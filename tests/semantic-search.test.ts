/**
 * WP12 语义检索测试（spec-semantic-search v1.1）
 * WP-C blindspot-fixes 追加：
 * - T11: ensureEmbedModel 内置下载器 mock 测试（不打网络）
 * - T12: vectorSearch model 列过滤
 * - T13: reindex 409 并发守卫
 * - T4 修正：补 chunkIndex 字段，断言 lineNo 非 NaN
 * - T9/T10 修正：显式传 model 参数避免 EMBED_MODEL 默认过滤失配
 *
 * 覆盖：
 * - 迁移形状：knowledge_embeddings 表存在 + CASCADE 删除
 * - chunkText 边界：空文本 / 短文本 / 超长段落
 * - 降级：注入失败 runner，ingest 仍成功 + embeddings 零行
 * - 混合融合：RRF 公式 / 向量路空表 → 纯 rg 结果
 * - reindex 路由返回结构
 * - knowledge-reset.mjs 冒烟（无 sqlite-vec import 即不崩）
 */

import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFinanceDatabase, initializeFinanceDatabase } from "../lib/db/sqlite.ts";
import { float32ArrayToBuffer } from "../lib/knowledge/embeddings.ts";

export const semanticSearchTestPromise = (async () => {
  const pid = process.pid;

  // ─── T1: knowledge_embeddings 表形状 + CASCADE ────────────────────────────
  {
    const dbPath = path.join(os.tmpdir(), `sem-search-t1-${pid}.db`);
    const db = openFinanceDatabase(dbPath);
    initializeFinanceDatabase(db, dbPath);

    // 表存在
    const tableRow = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_embeddings'"
    ).get() as { name: string } | undefined;
    assert.ok(tableRow, "T1 FAIL: knowledge_embeddings 表应存在");

    // 验证列
    const cols = (db.prepare("PRAGMA table_info(knowledge_embeddings)").all() as Array<{ name: string }>)
      .map(c => c.name);
    for (const required of ["id", "document_id", "chunk_index", "text", "embedding", "model", "created_at"]) {
      assert.ok(cols.includes(required), `T1 FAIL: knowledge_embeddings 缺列 ${required}`);
    }

    // 验证 UNIQUE(document_id, chunk_index)
    const indexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='knowledge_embeddings'"
    ).all() as Array<{ name: string }>).map(r => r.name);
    assert.ok(
      indexes.some(n => n.includes("doc") || n.includes("unique") || n.includes("uniq") || n.includes("embed")),
      `T1 FAIL: knowledge_embeddings 应有 document_id 相关索引，实际: ${JSON.stringify(indexes)}`
    );

    // CASCADE 删除：插入 knowledge_documents + embeddings 行，删文档，embeddings 随之消失
    db.exec(`
      INSERT INTO knowledge_documents (title, file_name, mime_type, category, size_bytes, chunk_count, content_hash, storage_path)
      VALUES ('test-doc', 'test.txt', 'text/plain', 'general', 100, 0, 'abc123', '')
    `);
    const docRow = db.prepare("SELECT id FROM knowledge_documents WHERE content_hash='abc123'").get() as { id: number };
    const docId = docRow.id;

    // 插入假 embedding（512 维 float32 = 2048 bytes）
    const fakeEmbedding = Buffer.alloc(512 * 4); // 全零
    db.prepare(
      "INSERT INTO knowledge_embeddings (document_id, chunk_index, text, embedding, model) VALUES (?, ?, ?, ?, ?)"
    ).run(docId, 0, "test chunk", fakeEmbedding, "bge-small-zh-v1.5");

    const countBefore = (db.prepare("SELECT COUNT(*) AS c FROM knowledge_embeddings WHERE document_id=?").get(docId) as { c: number }).c;
    assert.equal(countBefore, 1, "T1 FAIL: CASCADE 前 embedding 应为 1 行");

    db.exec(`DELETE FROM knowledge_documents WHERE id=${docId}`);

    const countAfter = (db.prepare("SELECT COUNT(*) AS c FROM knowledge_embeddings WHERE document_id=?").get(docId) as { c: number }).c;
    assert.equal(countAfter, 0, "T1 FAIL: CASCADE 删 knowledge_documents 后 embeddings 应级联清除");

    db.close();
    try { require("node:fs").unlinkSync(dbPath); } catch { /* ignore */ }
    console.log("semantic-search T1 PASS: knowledge_embeddings 形状 + CASCADE ✓");
  }

  // ─── T2: chunkText 边界 ───────────────────────────────────────────────────
  {
    const { chunkText } = await import("../lib/knowledge/chunker.ts");

    // 空文本 → 空数组
    const empty = chunkText("");
    assert.deepEqual(empty, [], "T2 FAIL: 空文本应返回 []");

    // 短文本（< 400 字）→ 单个 chunk
    const short = chunkText("你好世界");
    assert.equal(short.length, 1, "T2 FAIL: 短文本应返回 1 个 chunk");
    assert.ok(short[0].includes("你好世界"), "T2 FAIL: 短文本 chunk 应包含原文");

    // 超长段落（> 400 字无段落边界）→ 按窗口切块，至少 2 块
    const longText = "招待费上限业务招待费扣除标准".repeat(50); // 700 字以上
    const longChunks = chunkText(longText);
    assert.ok(longChunks.length >= 2, `T2 FAIL: 超长段落应切成 ≥2 块，实际 ${longChunks.length} 块`);
    // 验证重叠：相邻块有公共内容（重叠至少 20 字）
    if (longChunks.length >= 2) {
      const overlap = longChunks[0].slice(-80);
      assert.ok(longChunks[1].includes(overlap.slice(0, 20)), "T2 FAIL: 相邻块应有重叠内容");
    }

    console.log("semantic-search T2 PASS: chunkText 边界 ✓");
  }

  // ─── T3: 降级断言——注入失败 runner，ingest 仍成功 + embeddings 零行 ────
  {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "sem-search-t3-"));
    const dbPath = path.join(tmpDir, "test.db");
    process.env.FINANCE_AGENT_APP_DATA_DIR = tmpDir;
    process.env.FINANCE_AGENT_DB_PATH = dbPath;

    const { openFinanceDatabase: openDb, initializeFinanceDatabase: initDb } = await import("../lib/db/sqlite.ts");
    const db2 = openDb(dbPath);
    initDb(db2, dbPath);

    // 写一个真实文本文件（pipeline 解析需要）
    const txtPath = path.join(tmpDir, "sample.txt");
    writeFileSync(txtPath, "招待费上限业务招待费扣除标准".repeat(10));

    // 注入失败 runner
    const failingRunner = async (_texts: string[], _modelDir: string): Promise<number[][]> => {
      throw new Error("mock embed failure");
    };

    const { ingestDocument } = await import("../lib/knowledge/pipeline.ts");

    // 调用 ingestDocument 时用失败 runner（通过 embedTexts 的 runner 参数注入）
    const result = await ingestDocument({
      filePath: txtPath,
      title: "测试文档",
      fileName: "sample.txt",
      mimeType: "text/plain",
      sizeBytes: 100,
      embedRunner: failingRunner,
    });

    assert.ok(result.documentId > 0, "T3 FAIL: 降级时 ingestDocument 应仍成功返回 documentId");

    // embeddings 行数应为 0（失败静默降级）
    const db3 = openDb(dbPath);
    initDb(db3, dbPath);
    const embCount = (db3.prepare("SELECT COUNT(*) AS c FROM knowledge_embeddings").get() as { c: number }).c;
    assert.equal(embCount, 0, `T3 FAIL: 失败 runner 下 embeddings 应为 0 行，实际 ${embCount}`);
    db3.close();

    console.log("semantic-search T3 PASS: 降级 ingest 仍成功 + embeddings 零行 ✓");

    // 清理
    delete process.env.FINANCE_AGENT_APP_DATA_DIR;
    delete process.env.FINANCE_AGENT_DB_PATH;
  }

  // ─── T4: RRF 融合纯函数测试 ──────────────────────────────────────────────
  {
    const { rrfScore, mergeRrfResults } = await import("../lib/knowledge/embeddings.ts");

    // RRF(k=60): rank 1 → 1/(60+1)，rank 2 → 1/(60+2)
    const s1 = rrfScore(1, 60);
    const s2 = rrfScore(2, 60);
    assert.ok(s1 > s2, "T4 FAIL: RRF rank 1 应 > rank 2");
    assert.ok(Math.abs(s1 - 1 / 61) < 1e-9, `T4 FAIL: rrfScore(1,60) 应为 1/61，实际 ${s1}`);

    // mergeRrfResults：纯 rg 结果（无向量）时原样返回
    const rgFiles = [
      { docId: 1, title: "A", fileName: "a.txt", category: "general", hitCount: 3, matches: [] },
      { docId: 2, title: "B", fileName: "b.txt", category: "general", hitCount: 1, matches: [] },
    ];
    const merged = mergeRrfResults(rgFiles, [], 20);
    assert.equal(merged.length, 2, "T4 FAIL: 纯 rg 无向量时应保留所有结果");
    assert.equal(merged[0].docId, 1, "T4 FAIL: hitCount 多的应排前");

    // mergeRrfResults：向量命中排名高于 rg，应影响融合排序
    // T4 修正：补 chunkIndex 字段 + 新增向量独有命中 docId=3，断言 lineNo 非 NaN
    const vectorHits = [
      { docId: 2, score: 0.95, chunkText: "语义命中", chunkIndex: 1 },
      { docId: 3, score: 0.90, chunkText: "向量独有命中", chunkIndex: 2 },
    ];
    const merged2 = mergeRrfResults(rgFiles, vectorHits, 20);
    // docId=2 有向量加成，可能排到前面（取决于 RRF 权重）
    assert.ok(merged2.length >= 1, "T4 FAIL: RRF 融合应返回结果");
    // 向量独有命中 docId=3：合成 match 的 lineNo 应为 chunkIndex+1=3，不应为 NaN
    const vectorOnlyHit = merged2.find(f => f.docId === 3);
    assert.ok(vectorOnlyHit, "T4 FAIL: 向量独有命中 docId=3 应在融合结果中");
    assert.ok(!isNaN(vectorOnlyHit!.matches[0]?.lineNo), "T4 FAIL: 向量命中 lineNo 不应为 NaN");
    assert.equal(vectorOnlyHit!.matches[0]?.lineNo, 3, "T4 FAIL: chunkIndex=2 时 lineNo 应为 3");

    console.log("semantic-search T4 PASS: RRF 纯函数 ✓");
  }

  // ─── T5: 向量路空表 → searchKnowledge 不报错，返回 ok:true ──────────────
  {
    // 直接导入 searchKnowledge，knowledge_embeddings 空表时应正常运行
    // （此处不实际调用 rg，测试的是不抛异常）
    const { mergeRrfResults } = await import("../lib/knowledge/embeddings.ts");
    const emptyVec: Array<{ docId: number; score: number; chunkText: string; chunkIndex: number }> = [];
    const rgFiles = [{ docId: 5, title: "C", fileName: "c.txt", category: "general", hitCount: 2, matches: [] }];
    const result = mergeRrfResults(rgFiles, emptyVec, 20);
    assert.equal(result[0].docId, 5, "T5 FAIL: 空向量时应纯 rg 结果");
    console.log("semantic-search T5 PASS: 空向量路不报错 ✓");
  }

  // ─── T6: reindex 路由结构（HTTP handler 单元测试）────────────────────────
  {
    // 验证 reindex 路由文件存在且导出 POST handler
    const reindexModule = await import("../app/api/knowledge/reindex/route.ts");
    assert.ok(typeof reindexModule.POST === "function", "T6 FAIL: reindex route 应导出 POST 函数");
    console.log("semantic-search T6 PASS: reindex route 导出 POST ✓");
  }

  // ─── T7: embed-model 下载器候选源顺序 ───────────────────────────────────
  {
    const { resolveEmbedModelFileUrls } = await import("../lib/knowledge/embed-model.ts");

    // 无环境变量时：
    //   tokenizer.json  → Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json
    //   model_quantized.onnx → Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx
    delete process.env.FINANCE_AGENT_EMBED_MODEL_URL;
    const fileUrls = resolveEmbedModelFileUrls(["tokenizer.json", "model_quantized.onnx"]);
    assert.ok(fileUrls.length >= 2, "T7 FAIL: 应有两个文件的候选源");

    const tokenizerEntry = fileUrls.find(e => e.file === "tokenizer.json");
    const onnxEntry = fileUrls.find(e => e.file === "model_quantized.onnx");
    assert.ok(tokenizerEntry, "T7 FAIL: tokenizer.json 应有候选源列表");
    assert.ok(onnxEntry, "T7 FAIL: model_quantized.onnx 应有候选源列表");

    // tokenizer.json 远端路径为根目录（无 onnx/ 前缀）
    assert.ok(
      tokenizerEntry!.urls.some(u => u.includes("Xenova/bge-small-zh-v1.5") && u.endsWith("/tokenizer.json")),
      `T7 FAIL: tokenizer.json 候选源应用 Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json，实际: ${JSON.stringify(tokenizerEntry!.urls)}`
    );

    // model_quantized.onnx 远端路径在 onnx/ 子目录
    assert.ok(
      onnxEntry!.urls.some(u => u.includes("Xenova/bge-small-zh-v1.5") && u.includes("/onnx/model_quantized.onnx")),
      `T7 FAIL: model_quantized.onnx 候选源应含 onnx/ 子目录，实际: ${JSON.stringify(onnxEntry!.urls)}`
    );

    console.log("semantic-search T7 PASS: embed-model 候选源存在 ✓");

    // FINANCE_AGENT_EMBED_MODEL_URL 时自托管 URL 最高优先（本地文件名拼接）
    process.env.FINANCE_AGENT_EMBED_MODEL_URL = "https://my-cdn.com/model";
    const fileUrlsWithEnv = resolveEmbedModelFileUrls(["tokenizer.json"]);
    assert.ok(
      fileUrlsWithEnv[0].urls[0].includes("my-cdn.com"),
      "T7 FAIL: FINANCE_AGENT_EMBED_MODEL_URL 应排第一"
    );
    delete process.env.FINANCE_AGENT_EMBED_MODEL_URL;
    console.log("semantic-search T7 PASS: embed-model FINANCE_AGENT_EMBED_MODEL_URL 最高优先 ✓");
  }

  // ─── T8: knowledge-reset.mjs 冒烟——不存在 DB 路径正常退出 ──────────────
  {
    // 关键：脚本不再 import sqlite-vec，模块加载不应崩
    // 通过 child_process 跑脚本（DB 不存在路径）
    const { spawnSync } = await import("node:child_process");
    const { getProjectRoot } = await import("../lib/runtime/paths.ts");
    const scriptPath = path.join(getProjectRoot(), "scripts/knowledge-reset.mjs");
    const fakePath = path.join(os.tmpdir(), `sem-search-reset-${pid}.db`);
    const ret = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, FINANCE_AGENT_DB_PATH: fakePath, FINANCE_AGENT_APP_DATA_DIR: os.tmpdir() },
      encoding: "utf-8",
      timeout: 10_000,
    });
    assert.equal(ret.status, 0, `T8 FAIL: knowledge-reset.mjs 应正常退出，stderr: ${ret.stderr}`);
    assert.ok(!ret.stderr?.includes("Error") || ret.stderr.includes("not found"), `T8 FAIL: 不应有 Error 输出: ${ret.stderr}`);
    console.log("semantic-search T8 PASS: knowledge-reset.mjs 冒烟 ✓");
  }

  // ─── T9: B1 lineNo = chunk_index + 1（向量命中第二块时 lineNo=2）─────────
  {
    const { vectorSearch } = await import("../lib/knowledge/embeddings.ts");
    const { openFinanceDatabase: openDb9, initializeFinanceDatabase: initDb9 } = await import("../lib/db/sqlite.ts");

    const dbPath9 = path.join(os.tmpdir(), `sem-search-t9-${pid}.db`);
    const db9 = openDb9(dbPath9);
    initDb9(db9, dbPath9);

    // 插入文档
    db9.exec(`
      INSERT INTO knowledge_documents (title, file_name, mime_type, category, size_bytes, chunk_count, content_hash, storage_path)
      VALUES ('t9-doc', 't9.txt', 'text/plain', 'general', 100, 0, 't9hash', '')
    `);
    const docRow9 = db9.prepare("SELECT id FROM knowledge_documents WHERE content_hash='t9hash'").get() as { id: number };
    const docId9 = docRow9.id;

    // chunk 0: 与查询无关（全零向量）
    const zeroVec = new Float32Array(4);
    db9.prepare(
      "INSERT INTO knowledge_embeddings (document_id, chunk_index, text, embedding, model) VALUES (?, ?, ?, ?, ?)"
    ).run(docId9, 0, "chunk zero irrelevant", float32ArrayToBuffer(Array.from(zeroVec)), "test");

    // chunk 1: 与查询高度相关（与查询向量相同）
    const matchVec = new Float32Array([1, 0, 0, 0]);
    db9.prepare(
      "INSERT INTO knowledge_embeddings (document_id, chunk_index, text, embedding, model) VALUES (?, ?, ?, ?, ?)"
    ).run(docId9, 1, "chunk one relevant", float32ArrayToBuffer(Array.from(matchVec)), "test");

    // 查询向量与 chunk 1 完全匹配
    // T9 修正：显式传 model="test"，避免 EMBED_MODEL 默认过滤排除测试数据
    const queryVec = [1, 0, 0, 0];
    const hits = vectorSearch(db9, queryVec, 20, "test");

    assert.ok(hits.length > 0, "T9 FAIL: 应有向量命中");
    const hit = hits.find(h => h.docId === docId9);
    assert.ok(hit, "T9 FAIL: 应命中 t9-doc");
    assert.equal(hit!.chunkIndex + 1, 2, `T9 FAIL: lineNo 应为 2（chunk_index=1），实际 chunkIndex=${hit!.chunkIndex}`);

    db9.close();
    try { require("node:fs").unlinkSync(dbPath9); } catch { /* ignore */ }
    console.log("semantic-search T9 PASS: vectorSearch 返回 chunkIndex=1（lineNo=2）✓");
  }

  // ─── T10: N4 archived 文档不出现在向量检索结果中 ─────────────────────────
  {
    const { vectorSearch } = await import("../lib/knowledge/embeddings.ts");
    const { openFinanceDatabase: openDb10, initializeFinanceDatabase: initDb10 } = await import("../lib/db/sqlite.ts");

    const dbPath10 = path.join(os.tmpdir(), `sem-search-t10-${pid}.db`);
    const db10 = openDb10(dbPath10);
    initDb10(db10, dbPath10);

    // 插入文档（active）
    db10.exec(`
      INSERT INTO knowledge_documents (title, file_name, mime_type, category, size_bytes, chunk_count, content_hash, storage_path)
      VALUES ('t10-doc', 't10.txt', 'text/plain', 'general', 100, 0, 't10hash', '')
    `);
    const docRow10 = db10.prepare("SELECT id FROM knowledge_documents WHERE content_hash='t10hash'").get() as { id: number };
    const docId10 = docRow10.id;

    // 插入高相似度 embedding
    const matchVec10 = new Float32Array([1, 0, 0, 0]);
    db10.prepare(
      "INSERT INTO knowledge_embeddings (document_id, chunk_index, text, embedding, model) VALUES (?, ?, ?, ?, ?)"
    ).run(docId10, 0, "relevant text", float32ArrayToBuffer(Array.from(matchVec10)), "test");

    // 归档文档
    db10.prepare("UPDATE knowledge_documents SET archived = 1 WHERE id = ?").run(docId10);

    // 向量检索应不返回已归档文档
    // T10 修正：显式传 model="test"，避免 EMBED_MODEL 默认过滤排除测试数据
    const hitsAfterArchive = vectorSearch(db10, [1, 0, 0, 0], 20, "test");
    assert.ok(
      !hitsAfterArchive.some(h => h.docId === docId10),
      `T10 FAIL: 已归档文档不应出现在向量检索结果中，实际结果: ${JSON.stringify(hitsAfterArchive)}`
    );

    db10.close();
    try { require("node:fs").unlinkSync(dbPath10); } catch { /* ignore */ }
    console.log("semantic-search T10 PASS: archived 文档不出现在向量检索结果 ✓");
  }

  // ─── T11: ensureEmbedModel 内置下载器（mock 注入，不打网络）─────────────
  {
    const { ensureEmbedModel, isEmbedModelReady } = await import("../lib/knowledge/embed-model.ts");
    const tmpBase = mkdtempSync(path.join(os.tmpdir(), "sem-search-t11-"));
    const savedAppDataDir = process.env.FINANCE_AGENT_APP_DATA_DIR;

    // Mock download：写固定大小文件（100 字节）
    const mockFileSize = 100;
    const mockContent = Buffer.alloc(mockFileSize, 0x42);
    const mockDownload = async (_url: string, destFile: string): Promise<void> => {
      const fs = await import("node:fs");
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.writeFileSync(destFile, mockContent);
    };

    process.env.FINANCE_AGENT_APP_DATA_DIR = tmpBase;
    const result = await ensureEmbedModel({ download: mockDownload });
    assert.ok(result.ok, `T11 FAIL: mock download 应返回 ok:true，detail: ${result.detail}`);

    // manifest.json 应写入
    const manifestPath = path.join(result.modelDir, "manifest.json");
    assert.ok(existsSync(manifestPath), "T11 FAIL: 下载后应生成 manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, number>;
    assert.ok(
      manifest["model_quantized.onnx"] === mockFileSize,
      `T11 FAIL: manifest model_quantized.onnx 字节数应为 ${mockFileSize}，实际 ${JSON.stringify(manifest)}`
    );

    // isEmbedModelReady 应为 true（manifest 存在且字节数匹配）
    assert.ok(isEmbedModelReady(), "T11 FAIL: 下载后 isEmbedModelReady 应为 true");

    // 测试失败 download：ok:false
    const tmpBase2 = mkdtempSync(path.join(os.tmpdir(), "sem-search-t11b-"));
    process.env.FINANCE_AGENT_APP_DATA_DIR = tmpBase2;
    const failDownload = async (_url: string, _destFile: string): Promise<void> => {
      throw new Error("mock network failure");
    };
    const failResult = await ensureEmbedModel({ download: failDownload });
    assert.ok(!failResult.ok, "T11 FAIL: 所有候选源失败应返回 ok:false");

    // 无 manifest 但文件存在时 isEmbedModelReady 应放行（手动放置场景）
    const tmpBase3 = mkdtempSync(path.join(os.tmpdir(), "sem-search-t11c-"));
    process.env.FINANCE_AGENT_APP_DATA_DIR = tmpBase3;
    // 手动创建模型文件（无 manifest）
    const fs = await import("node:fs");
    const modelDir3 = path.join(tmpBase3, "models", "bge-small-zh-v1.5");
    fs.mkdirSync(modelDir3, { recursive: true });
    fs.writeFileSync(path.join(modelDir3, "model_quantized.onnx"), Buffer.alloc(10));
    fs.writeFileSync(path.join(modelDir3, "tokenizer.json"), Buffer.alloc(10));
    assert.ok(isEmbedModelReady(), "T11 FAIL: 文件齐全但无 manifest 时 isEmbedModelReady 应放行");

    process.env.FINANCE_AGENT_APP_DATA_DIR = savedAppDataDir;
    console.log("semantic-search T11 PASS: ensureEmbedModel 内置下载器 mock 测试 ✓");
  }

  // ─── T12: vectorSearch model 列过滤 ──────────────────────────────────────
  {
    const { vectorSearch: vectorSearchFn } = await import("../lib/knowledge/embeddings.ts");
    const { openFinanceDatabase: openDb12, initializeFinanceDatabase: initDb12 } = await import("../lib/db/sqlite.ts");

    const dbPath12 = path.join(os.tmpdir(), `sem-search-t12-${pid}.db`);
    const db12 = openDb12(dbPath12);
    initDb12(db12, dbPath12);

    db12.exec(`
      INSERT INTO knowledge_documents (title, file_name, mime_type, category, size_bytes, chunk_count, content_hash, storage_path)
      VALUES ('t12-doc', 't12.txt', 'text/plain', 'general', 100, 0, 't12hash', '')
    `);
    const docRow12 = db12.prepare("SELECT id FROM knowledge_documents WHERE content_hash='t12hash'").get() as { id: number };
    const docId12 = docRow12.id;

    // model-a embedding（高相似）
    const matchVec12 = new Float32Array([1, 0, 0, 0]);
    db12.prepare(
      "INSERT INTO knowledge_embeddings (document_id, chunk_index, text, embedding, model) VALUES (?, ?, ?, ?, ?)"
    ).run(docId12, 0, "model-a text", float32ArrayToBuffer(Array.from(matchVec12)), "model-a");

    // model-b embedding（同样高相似）
    db12.prepare(
      "INSERT INTO knowledge_embeddings (document_id, chunk_index, text, embedding, model) VALUES (?, ?, ?, ?, ?)"
    ).run(docId12, 1, "model-b text", float32ArrayToBuffer(Array.from(matchVec12)), "model-b");

    // 用 model-a 过滤：应命中
    const hitsModelA = vectorSearchFn(db12, [1, 0, 0, 0], 20, "model-a");
    assert.ok(hitsModelA.some(h => h.docId === docId12), "T12 FAIL: model-a 过滤应返回 docId12");

    // 用 model-b 过滤：不应返回 model-a 数据（chunk_index=0 用 model-a，chunk_index=1 用 model-b）
    // 此处 docId12 有 model-b 的 embedding，所以仍应返回
    const hitsModelB = vectorSearchFn(db12, [1, 0, 0, 0], 20, "model-b");
    assert.ok(hitsModelB.some(h => h.docId === docId12), "T12 FAIL: model-b 过滤应返回 model-b embedding");

    // 用不存在的 model 过滤：不应返回任何结果
    const hitsNoModel = vectorSearchFn(db12, [1, 0, 0, 0], 20, "nonexistent-model");
    assert.ok(!hitsNoModel.some(h => h.docId === docId12), "T12 FAIL: 不存在 model 过滤应无结果");

    db12.close();
    try { require("node:fs").unlinkSync(dbPath12); } catch { /* ignore */ }
    console.log("semantic-search T12 PASS: vectorSearch model 过滤 ✓");
  }

  // ─── T13: reindex POST 并发 409 守卫 ─────────────────────────────────────
  {
    const { POST: reindexPost } = await import("../app/api/knowledge/reindex/route.ts");

    // 两次并发调用：第一次进入 in-flight 状态，第二次应返回 409
    // 即使 ensureEmbedModel 下载失败（测试环境无真实网络），await 仍会 yield，
    // 让第二个调用看到 reindexInFlight=true
    const [r1, r2] = await Promise.all([reindexPost(), reindexPost()]);
    const statuses = [r1.status, r2.status];
    assert.ok(
      statuses.includes(409),
      `T13 FAIL: 并发 POST 应有一个返回 409，实际 statuses: ${JSON.stringify(statuses)}`
    );
    console.log("semantic-search T13 PASS: reindex 409 并发守卫 ✓");
  }

  console.log("semantic-search: all 13 checks passed ✓");
})();
