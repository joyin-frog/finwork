import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const timelinesDir = path.resolve(__dirname, "../timelines");

export function createTimeline(experimentId) {
  const events = [];
  const t0 = Date.now();

  function mark(label, detail = undefined) {
    const entry = {
      tMs: Date.now() - t0,
      label,
      ...(detail !== undefined ? { detail } : {}),
    };
    events.push(entry);
    const detailStr = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
    console.log(`[+${entry.tMs}ms] ${label}${detailStr}`);
    return entry;
  }

  function summarizeMessage(msg) {
    if (!msg || typeof msg !== "object") return { raw: String(msg) };
    const out = { type: msg.type };
    if ("subtype" in msg) out.subtype = msg.subtype;
    if ("session_id" in msg) out.session_id = msg.session_id;
    if ("num_turns" in msg) out.num_turns = msg.num_turns;
    if ("is_error" in msg) out.is_error = msg.is_error;
    if ("terminal_reason" in msg) out.terminal_reason = msg.terminal_reason;
    if ("stop_reason" in msg) out.stop_reason = msg.stop_reason;
    if (msg.type === "assistant" && msg.message?.content) {
      out.contentKinds = (Array.isArray(msg.message.content) ? msg.message.content : [])
        .map((c) => c?.type)
        .filter(Boolean);
    }
    if (msg.type === "system" && msg.subtype) out.systemSubtype = msg.subtype;
    return out;
  }

  function write(extra = {}) {
    fs.mkdirSync(timelinesDir, { recursive: true });
    const file = path.join(timelinesDir, `${experimentId}.json`);
    const payload = {
      experimentId,
      writtenAt: new Date().toISOString(),
      events,
      ...extra,
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    console.log(`Wrote timeline ${file}`);
    return file;
  }

  return { mark, summarizeMessage, write, events, t0 };
}

/** Template timeline for experiments not run live. */
export function writeNotRunTemplate(experimentId, reason, plannedSteps) {
  const tl = createTimeline(experimentId);
  tl.mark("not_run", { reason });
  for (const step of plannedSteps) tl.mark("planned_step", { step });
  return tl.write({ status: "not_run", reason, plannedSteps });
}
