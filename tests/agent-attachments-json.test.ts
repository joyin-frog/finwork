/**
 * Tests for JSON-path attachment disk-save behavior (parseJsonRequest).
 *
 * Before this fix, parseJsonRequest returned dataUrl attachments without
 * a storagePath. The buildAttachmentBlocks path in claude-adapter would then
 * produce inline base64 document/image blocks that non-Anthropic gateways
 * (e.g. gpt-5.x) silently drop.
 *
 * After the fix, parseJsonRequest persists every "has dataUrl but no storagePath"
 * attachment to disk, using the same upload dir logic as the multipart path,
 * and populates storagePath + size before returning.
 *
 * Tests call POST directly (same as smoke.test.ts) with FINANCE_AGENT_MOCK_AGENT=1.
 * The disk-save happens inside parseJsonRequest before the agent runs, so we can
 * assert file existence from the response's reported conversationId.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const agentAttachmentsJsonTestPromise = (async () => {
  const tmpRoot = path.join(os.tmpdir(), `fa-attach-json-${process.pid}`);
  mkdirSync(tmpRoot, { recursive: true });

  const prevAppDataDir = process.env.FINANCE_AGENT_APP_DATA_DIR;
  const prevDbPath = process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_APP_DATA_DIR = tmpRoot;
  process.env.FINANCE_AGENT_DB_PATH = path.join(tmpRoot, "test.db");

  // Import after env is set so paths and DB initialize with test dirs.
  const { POST } = await import("../app/api/agent/query/route.ts");
  const { getConversationFilesDir } = await import("../lib/runtime/paths.ts");

  function makeJsonRequest(body: unknown): Request {
    return new Request("http://localhost/api/agent/query?stream=false", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ── A1: dataUrl attachment → file saved to upload dir, storagePath reported ──
  // We verify disk-side effect: after POST, an upload/ file exists in the
  // conversation dir matching the decoded base64 content.
  {
    const content = "hello world from attachment";
    const b64 = Buffer.from(content).toString("base64");
    const dataUrl = `data:text/plain;base64,${b64}`;

    const req = makeJsonRequest({
      messages: [{ role: "user", content: "please read this file" }],
      attachments: [{ name: "note.txt", mimeType: "text/plain", size: content.length, dataUrl }],
    });

    const res = await POST(req);
    assert.equal(res.status, 200, `A1 FAIL: POST returned ${res.status}`);

    const json = (await res.json()) as { data?: { conversationId?: number } };
    const convId = json.data?.conversationId;
    assert.ok(convId && convId > 0, "A1 FAIL: response must include a conversationId");

    const uploadDir = path.join(getConversationFilesDir(convId!), "upload");
    assert.ok(existsSync(uploadDir), `A1 FAIL: upload dir must exist at ${uploadDir}`);

    const files = readdirSync(uploadDir);
    assert.equal(files.length, 1, `A1 FAIL: exactly 1 file should be in upload dir, got ${files.length}`);

    const savedPath = path.join(uploadDir, files[0]);
    const diskContent = readFileSync(savedPath);
    assert.deepEqual(diskContent, Buffer.from(content), "A1 FAIL: file content must match decoded base64");
  }

  // ── A2: no conversationId in request → auto-create, file still lands on disk ──
  {
    const content = "auto conv test data";
    const b64 = Buffer.from(content).toString("base64");
    const dataUrl = `data:text/plain;base64,${b64}`;

    const req = makeJsonRequest({
      // No conversationId — should be auto-created
      messages: [{ role: "user", content: "process this attachment please" }],
      attachments: [{ name: "auto.txt", mimeType: "text/plain", size: content.length, dataUrl }],
    });

    const res = await POST(req);
    assert.equal(res.status, 200, `A2 FAIL: POST returned ${res.status}`);

    const json = (await res.json()) as { data?: { conversationId?: number } };
    const convId = json.data?.conversationId;
    assert.ok(convId && convId > 0, "A2 FAIL: conversationId must be auto-created");

    const uploadDir = path.join(getConversationFilesDir(convId!), "upload");
    assert.ok(existsSync(uploadDir), `A2 FAIL: upload dir must exist at ${uploadDir}`);

    const files = readdirSync(uploadDir);
    assert.equal(files.length, 1, `A2 FAIL: exactly 1 file should be saved, got ${files.length}`);
  }

  // ── A3: attachment already has storagePath → not re-saved (file count unchanged) ──
  // Create a real file first, then POST referencing it with storagePath already set.
  {
    // POST a normal message to get a conversationId
    const initRes = await POST(makeJsonRequest({
      messages: [{ role: "user", content: "init conversation for A3" }],
    }));
    const initJson = (await initRes.json()) as { data?: { conversationId?: number } };
    const convId = initJson.data?.conversationId!;
    assert.ok(convId > 0, "A3 setup FAIL: could not create conversation");

    // Plant a file in the upload dir
    const uploadDir = path.join(getConversationFilesDir(convId), "upload");
    mkdirSync(uploadDir, { recursive: true });
    const existingFile = path.join(uploadDir, "existing.pdf");
    const existingContent = Buffer.from("existing pdf content");
    require("node:fs").writeFileSync(existingFile, existingContent);

    // POST a second message referencing the already-saved file
    const req = makeJsonRequest({
      conversationId: convId,
      messages: [{ role: "user", content: "read the existing file" }],
      attachments: [{ name: "existing.pdf", mimeType: "application/pdf", size: existingContent.length, dataUrl: `data:application/pdf;base64,${existingContent.toString("base64")}`, storagePath: existingFile }],
    });
    await POST(req);

    // upload dir should still have exactly 1 file (not duplicated)
    const files = readdirSync(uploadDir);
    assert.equal(files.length, 1, `A3 FAIL: already-stored attachment must not create a duplicate file, got ${files.length}`);
    assert.equal(files[0], "existing.pdf", "A3 FAIL: original file name must be preserved");
  }

  // ── A4: no dataUrl (empty string) → no storagePath set, no file saved ──
  {
    const req = makeJsonRequest({
      messages: [{ role: "user", content: "text only, no attachment content" }],
      attachments: [{ name: "ghost.txt", mimeType: "text/plain", size: 0, dataUrl: "" }],
    });

    const res = await POST(req);
    assert.equal(res.status, 200, `A4 FAIL: POST returned ${res.status}`);

    const json = (await res.json()) as { data?: { conversationId?: number } };
    const convId = json.data?.conversationId;
    if (convId) {
      const uploadDir = path.join(getConversationFilesDir(convId), "upload");
      // If upload dir exists, it must have no files (no dataUrl = nothing saved)
      if (existsSync(uploadDir)) {
        const files = readdirSync(uploadDir);
        assert.equal(files.length, 0, `A4 FAIL: empty dataUrl must not create any files, got ${files.length}`);
      }
    }
    // Either no upload dir, or empty upload dir — both valid
  }

  // Restore env
  if (prevAppDataDir === undefined) delete process.env.FINANCE_AGENT_APP_DATA_DIR;
  else process.env.FINANCE_AGENT_APP_DATA_DIR = prevAppDataDir;

  if (prevDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
  else process.env.FINANCE_AGENT_DB_PATH = prevDbPath;

  console.log("agent-attachments-json: all 4 checks passed ✓");
})();
