import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import sharp from "sharp";
import { createAr10Runtime } from "./runtime.mts";

type Mode = "text" | "tool" | "thinking" | "image" | "resume" | "abort";

function eventType(event: AgentSessionEvent): string {
  return event.type;
}

function assistantText(events: AgentSessionEvent[]): string {
  const parts: string[] = [];
  for (const event of events) {
    if (event.type !== "message_end" || event.message.role !== "assistant") continue;
    for (const block of event.message.content) {
      if (block.type === "text") parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function hasThinking(events: AgentSessionEvent[]): boolean {
  return events.some(
    (event) =>
      (event.type === "message_end" || event.type === "message_update") &&
      event.message.role === "assistant" &&
      event.message.content.some((block) => block.type === "thinking" && block.thinking.trim().length > 0),
  );
}

function hasUsage(events: AgentSessionEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.usage.totalTokens > 0,
  );
}

function assistantErrors(events: AgentSessionEvent[]): string[] {
  return events.flatMap((event) => {
    if (
      event.type !== "message_end" ||
      event.message.role !== "assistant" ||
      !event.message.errorMessage
    ) {
      return [];
    }
    return [
      event.message.errorMessage
        .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")
        .replace(/https?:\/\/[^\s/]+/g, "[REDACTED_ORIGIN]")
        .slice(0, 500),
    ];
  });
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else out.push(path.relative(root, absolute));
    }
  }
  await walk(root);
  return out.sort();
}

async function main(): Promise<void> {
  if (process.env.AR10_ALLOW_REAL !== "1") {
    throw new Error("Refusing real gateway call without AR10_ALLOW_REAL=1");
  }
  const mode = (process.argv[2] ?? "text") as Mode;
  if (!["text", "tool", "thinking", "image", "resume", "abort"].includes(mode)) {
    throw new Error(`Unknown AR10 mode: ${mode}`);
  }

  const sessionRoot = await mkdtemp(path.join(tmpdir(), "finwork-ar10-"));
  let runtime = await createAr10Runtime({
    sessionRoot,
    thinkingLevel: mode === "thinking" ? "low" : "off",
  });
  try {
    if (mode === "text") {
      await runtime.session.prompt("Reply with exactly AR10_TEXT_OK and nothing else.");
    } else if (mode === "tool") {
      await runtime.session.prompt(
        "Call ar10_contract_probe exactly once with nonce AR10_TOOL_OK and nested.values [7, 29]. Then reply exactly AR10_TOOL_OK.",
      );
    } else if (mode === "thinking") {
      await runtime.session.prompt(
        "Reason briefly about why 17 * 19 equals 323, then end your answer with exactly AR10_THINKING_OK.",
      );
    } else if (mode === "image") {
      // Synthetic 32x32 opaque red PNG. No user data crosses the gateway.
      const imageData = await sharp({
        create: { width: 32, height: 32, channels: 4, background: "#ff0000" },
      })
        .png()
        .toBuffer();
      await runtime.session.prompt("Identify the image color and end with exactly AR10_IMAGE_OK.", {
        images: [
          {
            type: "image",
            mimeType: "image/png",
            data: imageData.toString("base64"),
          },
        ],
      });
    } else if (mode === "resume") {
      await runtime.session.prompt(
        "Remember the token AR10_RESUME_SECRET. Reply exactly AR10_RESUME_STORED.",
      );
      await runtime.session.waitForIdle();
      const sessionFile = runtime.session.sessionFile;
      if (!sessionFile) throw new Error("Pi did not create a session file");
      runtime.session.dispose();
      runtime = await createAr10Runtime({ sessionRoot, sessionFile });
      await runtime.session.prompt(
        "What token did I ask you to remember? Reply with that token only.",
      );
    } else {
      const prompt = runtime.session.prompt(
        "Write a very long numbered explanation with at least 100 sections. Do not stop early.",
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      await runtime.session.abort();
      await prompt.catch(() => undefined);
    }
    await runtime.session.waitForIdle();

    const text = assistantText(runtime.events);
    const types = runtime.events.map(eventType);
    const files = await listFiles(sessionRoot);
    const sessionFile = runtime.session.sessionFile;
    const sessionBytes = sessionFile ? (await readFile(sessionFile)).byteLength : 0;
    const assertions = {
      settled: types.includes("agent_settled"),
      hasText:
        mode === "abort"
          ? true
          : text.includes(
              {
                text: "AR10_TEXT_OK",
                tool: "AR10_TOOL_OK",
                thinking: "AR10_THINKING_OK",
                image: "AR10_IMAGE_OK",
                resume: "AR10_RESUME_SECRET",
                abort: "",
              }[mode],
            ),
      toolStarted: types.includes("tool_execution_start"),
      toolEnded: types.includes("tool_execution_end"),
      thinkingObserved: hasThinking(runtime.events),
      usageObserved: hasUsage(runtime.events),
      aborted:
        runtime.events.some(
          (event) =>
            event.type === "message_end" &&
            event.message.role === "assistant" &&
            event.message.stopReason === "aborted",
        ) || (mode !== "abort"),
      sessionControlled:
        Boolean(sessionFile) && path.resolve(sessionFile!).startsWith(`${path.resolve(sessionRoot)}${path.sep}`),
      noAuthFile: !files.some((file) => /(^|\/)auth\.json$/.test(file)),
    };
    const passed =
      assertions.settled &&
      assertions.hasText &&
      (mode === "abort" || assertions.usageObserved) &&
      assertions.aborted &&
      assertions.sessionControlled &&
      assertions.noAuthFile &&
      (mode !== "tool" || (assertions.toolStarted && assertions.toolEnded)) &&
      (mode !== "thinking" || assertions.thinkingObserved);

    console.log(
      JSON.stringify(
        {
          mode,
          passed,
          provider: "anthropic-messages",
          gatewayOrigin: runtime.gatewayOrigin,
          modelId: runtime.modelId,
          piVersions: {
            ai: "0.82.1",
            agentCore: "0.82.1",
            codingAgent: "0.82.1",
          },
          assertions,
          assistantErrors: assistantErrors(runtime.events),
          eventTypes: types,
          eventTimelineSha256: createHash("sha256").update(types.join("\n")).digest("hex"),
          sessionFileCount: files.length,
          sessionBytes,
        },
        null,
        2,
      ),
    );
    if (!passed) process.exitCode = 1;
  } finally {
    runtime.session.dispose();
  }
}

void main();
