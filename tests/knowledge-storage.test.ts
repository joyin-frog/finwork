import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeFileHash, deleteStoredFile, getKnowledgeStorageDir, writeUploadedFile } from "../lib/knowledge/storage";

const testDir = path.join(tmpdir(), `finance-agent-storage-test-${process.pid}`);
mkdirSync(testDir, { recursive: true });
process.env.FINANCE_AGENT_KNOWLEDGE_DIR = testDir;

function cleanup() {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
}

async function main() {
  // getKnowledgeStorageDir returns the env-overridden path
  assert.equal(getKnowledgeStorageDir(), testDir);

  // computeFileHash is stable and matches sha256
  const { createHash } = await import("node:crypto");
  const buf = Buffer.from("hello world");
  const expected = createHash("sha256").update(buf).digest("hex");
  assert.equal(computeFileHash(buf), expected);

  // writeUploadedFile creates the file at <dir>/<hash>.<ext>
  const hash = computeFileHash(buf);
  const filePath = writeUploadedFile(hash, buf, ".txt");
  assert.ok(existsSync(filePath), "file should exist after write");
  assert.ok(filePath.endsWith(`${hash}.txt`), "filename should be <hash>.txt");

  // writing the same file again is idempotent (no error)
  const filePath2 = writeUploadedFile(hash, buf, ".txt");
  assert.equal(filePath, filePath2);
  assert.ok(existsSync(filePath), "file should still exist after second write");

  // writeUploadedFile handles ext with or without leading dot
  const path1 = writeUploadedFile(hash, buf, "txt");
  const path2 = writeUploadedFile(hash, buf, ".txt");
  assert.equal(path.basename(path1), path.basename(path2));

  // deleteStoredFile removes the file
  deleteStoredFile(filePath);
  assert.ok(!existsSync(filePath), "file should be gone after delete");

  // deleteStoredFile is idempotent (no error on missing file)
  deleteStoredFile(filePath);
  deleteStoredFile("");
  deleteStoredFile("/nonexistent/path/that/does/not/exist.txt");

  // directory is auto-created if missing
  const freshDir = path.join(tmpdir(), `finance-agent-storage-fresh-${process.pid}`);
  process.env.FINANCE_AGENT_KNOWLEDGE_DIR = freshDir;
  try {
    const freshPath = writeUploadedFile(hash, buf, ".bin");
    assert.ok(existsSync(freshPath), "directory should be auto-created");
  } finally {
    try { rmSync(freshDir, { recursive: true, force: true }); } catch {}
    process.env.FINANCE_AGENT_KNOWLEDGE_DIR = testDir;
  }

  cleanup();
  console.log("knowledge-storage tests passed");
}

export const knowledgeStorageTestPromise = main();
knowledgeStorageTestPromise.catch((err) => {
  console.error(err);
  process.exit(1);
});
