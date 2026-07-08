/**
 * WP12: embedding 存取 + 余弦检索 + RRF 融合。
 *
 * embedTexts: 调用 Python worker embed-texts 命令，返回向量数组。
 *   - 接受可选 runner 参数（注入），默认走真实 worker spawn。
 *   - worker 缺失/模型未下载时返回 model_not_found 结构化错误。
 *
 * cosine: Float32Array 余弦相似度。
 * vectorSearch: 全表余弦暴力扫，文档级最高分聚合。
 * rrfScore / mergeRrfResults: RRF(k=60) 融合。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getPythonPath, getProjectRoot } from "@/lib/runtime/paths";
import { pythonSpawnEnv } from "@/lib/runtime/python-env";
import { EMBED_MODEL, getEmbedModelDir, isEmbedModelReady } from "./embed-model";
import type { SearchFile } from "./rg-search";

/**
 * 异步 spawn 辅助：向子进程 stdin 写 input，收集 stdout 字符串。
 * 替代 execFileSync(... {input}) 的同步阻塞，让 Promise.all 真并行。
 */
function spawnWithInput(
  cmd: string,
  args: string[],
  input: string,
  opts: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env,
    });

    let out = "";
    let errOut = "";
    let bytesOut = 0;

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("embed-texts worker timeout"));
    }, opts.timeout);

    child.stdout.on("data", (chunk: Buffer) => {
      bytesOut += chunk.length;
      if (bytesOut > opts.maxBuffer) {
        child.kill();
        clearTimeout(timer);
        reject(new Error("embed-texts output exceeds maxBuffer"));
        return;
      }
      out += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      errOut += chunk.toString("utf-8");
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`embed-texts worker exited ${code}: ${errOut.trim()}`));
      } else {
        resolve(out);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.stdin.write(input, "utf-8");
    child.stdin.end();
  });
}

export type EmbedRunner = (texts: string[], modelDir: string) => Promise<number[][]>;

/** 默认 runner：调用 Python worker embed-texts 命令（异步 spawn，与 Promise.all 真并行） */
async function defaultEmbedRunner(texts: string[], modelDir: string): Promise<number[][]> {
  const workerPath = path.join(getProjectRoot(), "workers/finance_worker.py");
  const payload = JSON.stringify({ texts, model_dir: modelDir });
  const stdout = await spawnWithInput(
    getPythonPath(),
    [workerPath, "embed-texts"],
    payload,
    { env: pythonSpawnEnv(), timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }
  );
  const result = JSON.parse(stdout.trim()) as
    | { ok: true; dim: number; vectors: number[][] }
    | { ok: false; error: string };
  if (!result.ok) {
    throw new Error(`embed-texts worker error: ${result.error}`);
  }
  return result.vectors;
}

/**
 * embed 文本数组 → 向量矩阵。
 * runner 可注入（测试用），默认走真实 worker。
 * 返回 null 表示不可用（无 python/无模型/worker 崩）—— 调用方静默降级。
 */
export async function embedTexts(
  texts: string[],
  runner?: EmbedRunner
): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const modelDir = getEmbedModelDir();
  if (!isEmbedModelReady() && runner === undefined) {
    // 模型未下载，降级
    return null;
  }
  const actualRunner = runner ?? defaultEmbedRunner;
  return await actualRunner(texts, modelDir);
}

/** Float32Array 余弦相似度（内积 / 模长乘积） */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 把 Float32 number[] 转 Buffer（小端）落库 */
export function float32ArrayToBuffer(vec: number[]): Buffer {
  const fa = new Float32Array(vec);
  return Buffer.from(fa.buffer);
}

/** 从 Buffer 读回 Float32Array */
export function bufferToFloat32Array(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** 向量检索：全表余弦暴力扫，返回文档级最高分聚合（docId → 最高分 chunk）。
 *  knowledge_embeddings 空表 / 查询向量 null → 返回空数组。
 *  只命中 archived=0 的文档（与 rg 路 listActiveKnowledgeDocuments 对称）。
 *  model 参数：只检索该模型的 embeddings（默认 EMBED_MODEL）。 */
export function vectorSearch(
  db: DatabaseSync,
  queryVec: number[] | null,
  topK = 20,
  model = EMBED_MODEL
): Array<{ docId: number; score: number; chunkText: string; chunkIndex: number }> {
  if (!queryVec || queryVec.length === 0) return [];

  const qfa = new Float32Array(queryVec);

  // 文档级最高分聚合（O(唯一文档数)，不截断——截断会破坏按文档聚合的正确性）
  const best = new Map<number, { score: number; chunkText: string; chunkIndex: number }>();

  try {
    const stmt = db.prepare(
      `SELECT ke.document_id, ke.chunk_index, ke.embedding, ke.text
       FROM knowledge_embeddings ke
       JOIN knowledge_documents kd ON kd.id = ke.document_id
       WHERE kd.archived = 0 AND ke.model = ?`
    );
    // iterate() 逐行返回，BLOB 用完即弃，不物化全表数组
    for (const row of stmt.iterate(model) as Iterable<{
      document_id: number;
      chunk_index: number;
      embedding: Buffer;
      text: string;
    }>) {
      const emb = bufferToFloat32Array(row.embedding);
      const score = cosine(qfa, emb);
      const prev = best.get(row.document_id);
      if (!prev || score > prev.score) {
        best.set(row.document_id, { score, chunkText: row.text, chunkIndex: row.chunk_index });
      }
    }
  } catch {
    return [];
  }

  if (best.size === 0) return [];

  return Array.from(best.entries())
    .map(([docId, v]) => ({ docId, score: v.score, chunkText: v.chunkText, chunkIndex: v.chunkIndex }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** RRF 分：rank 从 1 开始，k=60 */
export function rrfScore(rank: number, k = 60): number {
  return 1 / (k + rank);
}

/**
 * RRF 融合：rg 结果 + 向量检索结果 → 融合排序。
 * 向量结果空时直接返回 rg 结果（零改动回归防线）。
 */
export function mergeRrfResults(
  rgFiles: SearchFile[],
  vectorHits: Array<{ docId: number; score: number; chunkText: string; chunkIndex: number }>,
  topK: number
): SearchFile[] {
  if (vectorHits.length === 0) {
    return rgFiles.slice(0, topK);
  }

  // 建 docId → rg rank 映射（rank 从 1）
  const rgRank = new Map<number, number>();
  rgFiles.forEach((f, i) => rgRank.set(f.docId, i + 1));

  // 建 docId → vector rank 映射
  const vecRank = new Map<number, number>();
  vectorHits.forEach((h, i) => vecRank.set(h.docId, i + 1));

  // 全部候选 docId
  const allDocIds = new Set([
    ...rgFiles.map(f => f.docId),
    ...vectorHits.map(h => h.docId),
  ]);

  const scores: Array<{ docId: number; score: number }> = [];
  for (const docId of allDocIds) {
    let s = 0;
    const rr = rgRank.get(docId);
    const vr = vecRank.get(docId);
    if (rr !== undefined) s += rrfScore(rr);
    if (vr !== undefined) s += rrfScore(vr);
    scores.push({ docId, score: s });
  }
  scores.sort((a, b) => b.score - a.score);

  // 构建 SearchFile 结果：优先保留 rg 的全 match 信息；向量独有的用 chunk 文本生成合成 match
  const rgMap = new Map(rgFiles.map(f => [f.docId, f]));
  const vecMap = new Map(vectorHits.map(h => [h.docId, h]));

  const result: SearchFile[] = [];
  for (const { docId } of scores.slice(0, topK)) {
    const existing = rgMap.get(docId);
    if (existing) {
      result.push(existing);
    } else {
      // 向量独有命中：用 chunk 文本构造合成 SearchMatch
      const vh = vecMap.get(docId)!;
      // 从全部向量结果找该文档所有 chunk（按 chunk_index 排序）
      result.push({
        docId,
        title: "",       // 调用方（searchKnowledge）会补 title/fileName/category
        fileName: "",
        category: "",
        hitCount: 0,
        matches: [{
          lineNo: vh.chunkIndex + 1,
          line: vh.chunkText,
          before: [],
          after: [],
          ranges: [],
        }],
      });
    }
  }

  return result;
}

/** 存 embeddings 到 knowledge_embeddings（upsert 语义：UNIQUE 冲突替换） */
export function storeEmbeddings(
  db: DatabaseSync,
  documentId: number,
  chunks: string[],
  vectors: number[][],
  model: string
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO knowledge_embeddings
      (document_id, chunk_index, text, embedding, model)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < chunks.length; i++) {
    const vec = vectors[i];
    if (!vec) continue;
    const blob = float32ArrayToBuffer(vec);
    stmt.run(documentId, i, chunks[i], blob, model);
  }
}

/** 删除文档所有 embeddings（CASCADE 通常已覆盖，但存量路径兜底） */
export function deleteEmbeddings(db: DatabaseSync, documentId: number): void {
  db.prepare("DELETE FROM knowledge_embeddings WHERE document_id = ?").run(documentId);
}

/** 获取已有 embeddings 的文档 ID 集合 */
export function getDocIdsWithEmbeddings(db: DatabaseSync): Set<number> {
  const rows = db.prepare(
    "SELECT DISTINCT document_id FROM knowledge_embeddings"
  ).all() as Array<{ document_id: number }>;
  return new Set(rows.map(r => r.document_id));
}
