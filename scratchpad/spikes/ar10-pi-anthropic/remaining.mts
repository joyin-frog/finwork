import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defineTool,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { createAr10Runtime, getProbeTool } from "./runtime.mts";

type Mode = "compaction" | "steering";

async function main(): Promise<void> {
  if (process.env.AR10_ALLOW_REAL !== "1") {
    throw new Error("Refusing real gateway call without AR10_ALLOW_REAL=1");
  }
  const mode = (process.argv[2] ?? "compaction") as Mode;
  if (!["compaction", "steering"].includes(mode)) {
    throw new Error(`Unknown remaining mode: ${mode}`);
  }
  const root = await mkdtemp(path.join(tmpdir(), `finwork-ar10-${mode}-`));
  try {
    const result = mode === "compaction"
      ? await runCompaction(root)
      : await runSteering(root);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCompaction(root: string) {
  let runtime = await createAr10Runtime({
    sessionRoot: root,
    compactionKeepRecentTokens: 32,
  });
  try {
    for (const [round, value] of [["ONE", 11], ["TWO", 22], ["THREE", 33]] as const) {
      await runtime.session.prompt(
        `Call ar10_contract_probe exactly once with nonce AR10_${round} and nested.values [${value}]. Then reply exactly AR10_${round}.`,
      );
      await runtime.session.waitForIdle();
    }
    const compaction = await runtime.session.compact(
      "Preserve the three AR10 nonce markers and their numeric values exactly.",
    );
    await runtime.session.waitForIdle();
    await runtime.session.prompt("Reply exactly AR10_POST_COMPACT_ONE.");
    await runtime.session.waitForIdle();
    await runtime.session.prompt("Reply exactly AR10_POST_COMPACT_TWO.");
    await runtime.session.waitForIdle();
    const sessionFile = runtime.session.sessionFile;
    if (!sessionFile) throw new Error("missing compacted session file");
    const beforeResumeTypes = runtime.events.map((event) => event.type);
    runtime.session.dispose();
    runtime = await createAr10Runtime({
      sessionRoot: root,
      sessionFile,
      compactionKeepRecentTokens: 32,
    });
    await runtime.session.prompt(
      "List the three remembered nonce/value pairs, then end with exactly AR10_COMPACTION_RESUME_OK.",
    );
    await runtime.session.waitForIdle();
    const text = assistantText(runtime.events);
    const types = [...beforeResumeTypes, ...runtime.events.map((event) => event.type)];
    const assertions = {
      threeToolRounds:
        beforeResumeTypes.filter((type) => type === "tool_execution_end").length === 3,
      realCompaction:
        beforeResumeTypes.includes("compaction_start") &&
        beforeResumeTypes.includes("compaction_end") &&
        Boolean(compaction.summary),
      twoPostCompactionTurns:
        beforeResumeTypes.filter((type) => type === "agent_settled").length >= 5,
      resumedAfterCompaction: text.includes("AR10_COMPACTION_RESUME_OK"),
      controlledSession: sessionFile.startsWith(`${root}${path.sep}`),
    };
    return evidence("compaction", assertions, types);
  } finally {
    runtime.session.dispose();
  }
}

async function runSteering(root: string) {
  const slowTool = defineTool({
    name: "ar10_slow_probe",
    label: "AR10 slow probe",
    description: "Call exactly when asked to test steering during a tool.",
    parameters: Type.Object({ nonce: Type.String() }),
    async execute(_id, params, signal) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        }, { once: true });
      });
      return {
        content: [{ type: "text" as const, text: params.nonce }],
        details: { nonce: params.nonce },
      };
    },
  });
  const runtime = await createAr10Runtime({
    sessionRoot: root,
    tools: [getProbeTool(), slowTool],
  });
  try {
    let outputSteered = false;
    const unsubscribeOutput = runtime.session.subscribe((event) => {
      if (
        !outputSteered &&
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        outputSteered = true;
        void runtime.session.steer(
          "Stop the long answer and reply exactly AR10_OUTPUT_STEER_OK.",
        );
      }
    });
    await runtime.session.prompt(
      "Write a numbered explanation with at least 80 sections. Do not stop early.",
    );
    await runtime.session.waitForIdle();
    unsubscribeOutput();
    const outputEvents = [...runtime.events];
    runtime.events.length = 0;

    let toolQueued = false;
    const unsubscribeTool = runtime.session.subscribe((event) => {
      if (!toolQueued && event.type === "tool_execution_start" && event.toolName === "ar10_slow_probe") {
        toolQueued = true;
        void runtime.session.steer(
          "After the tool, reply exactly AR10_TOOL_STEER_OK.",
        );
        void runtime.session.followUp(
          "Then process this follow-up and reply exactly AR10_TOOL_FOLLOWUP_OK.",
        );
      }
    });
    await runtime.session.prompt(
      "Call ar10_slow_probe exactly once with nonce AR10_SLOW_TOOL, then explain the result.",
    );
    await runtime.session.waitForIdle();
    unsubscribeTool();
    const toolEvents = [...runtime.events];
    const outputText = assistantText(outputEvents);
    const toolText = assistantText(toolEvents);
    const types = [...outputEvents, ...toolEvents].map((event) => event.type);
    const assertions = {
      outputSteerQueued:
        outputSteered && outputEvents.some((event) => event.type === "queue_update"),
      outputSteerDelivered: outputText.includes("AR10_OUTPUT_STEER_OK"),
      toolPhaseObserved: toolEvents.some(
        (event) => event.type === "tool_execution_start" && event.toolName === "ar10_slow_probe",
      ),
      toolQueueUpdated: toolEvents.filter((event) => event.type === "queue_update").length >= 2,
      steerBeforeFollowUp:
        toolText.indexOf("AR10_TOOL_STEER_OK") >= 0 &&
        toolText.indexOf("AR10_TOOL_FOLLOWUP_OK") > toolText.indexOf("AR10_TOOL_STEER_OK"),
      settledAfterQueues:
        toolEvents.at(-1)?.type === "agent_settled" &&
        outputEvents.at(-1)?.type === "agent_settled",
    };
    return evidence("steering", assertions, types);
  } finally {
    runtime.session.dispose();
  }
}

function assistantText(events: AgentSessionEvent[]): string {
  return events.flatMap((event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return [];
    return event.message.content.flatMap((part) => part.type === "text" ? [part.text] : []);
  }).join("\n");
}

function evidence(
  mode: Mode,
  assertions: Record<string, boolean>,
  eventTypes: string[],
) {
  return {
    mode,
    passed: Object.values(assertions).every(Boolean),
    assertions,
    eventTypes,
    eventTimelineSha256: createHash("sha256").update(eventTypes.join("\n")).digest("hex"),
  };
}

void main();
