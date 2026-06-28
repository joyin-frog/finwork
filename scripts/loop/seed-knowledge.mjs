// Seed the (sandbox) knowledge base with the finance policy fixtures so that
// knowledge-dependent eval cases (rag_qa / complex_workflow that start with
// "先查公司制度…") can actually retrieve, instead of hitting an empty KB.
// Uploads via the real /api/knowledge/documents route (server must be up).
//
//   node scripts/loop/with-server.mjs -- node scripts/loop/seed-knowledge.mjs
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3997";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = path.join(REPO, "tests", "golden", "fixtures");

const files = (await fs.readdir(DIR)).filter((f) => /\.(md|txt)$/i.test(f));
let ok = 0;
for (const f of files) {
  const buf = await fs.readFile(path.join(DIR, f));
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "text/markdown" }), f);
  fd.append("title", f.replace(/\.(md|txt)$/i, ""));
  fd.append("category", "policy");
  try {
    const res = await fetch(BASE + "/api/knowledge/documents", { method: "POST", body: fd });
    const body = await res.json().catch(() => null);
    const good = res.status === 200 && body?.ok;
    console.log(`${good ? "✅" : "❌"} seed ${f} — HTTP ${res.status}`);
    if (good) ok++;
  } catch (e) {
    console.log(`❌ seed ${f} — ${e.message}`);
  }
}
console.log(`\nseeded ${ok}/${files.length} policy docs into KB @ ${BASE}`);
process.exit(ok === files.length ? 0 : 1);
