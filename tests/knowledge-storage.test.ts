import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  acquireKnowledgeIngestLease,
  canonicalStoragePathKey,
  computeFileHash,
  deleteStoredFile,
  getKnowledgeStorageDir,
  hasActiveKnowledgeHashLease,
  hasActiveKnowledgePathLease,
  knowledgeStoragePath,
  writeUploadedFile,
} from "../lib/knowledge/storage";

const testDir = path.join(tmpdir(), `finance-agent-storage-test-${process.pid}`);
const externalDir = path.join(tmpdir(), `finance-agent-storage-external-${process.pid}`);
mkdirSync(testDir, { recursive: true });
mkdirSync(externalDir, { recursive: true });
process.env.FINANCE_AGENT_KNOWLEDGE_DIR = testDir;

function cleanup() {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  try { rmSync(externalDir, { recursive: true, force: true }); } catch {}
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

  // Existing target bytes must never be overwritten when the requested hash does not match them.
  const conflictingHash = computeFileHash(Buffer.from("expected target bytes"));
  const conflictingPath = path.join(testDir, `${conflictingHash}.txt`);
  writeFileSync(conflictingPath, "pre-existing conflicting bytes");
  assert.throws(
    () => writeUploadedFile(conflictingHash, Buffer.from("expected target bytes"), ".txt"),
    /hash|哈希|冲突/i,
    "a conflicting pre-existing target must reject publication"
  );
  assert.equal(readFileSync(conflictingPath, "utf-8"), "pre-existing conflicting bytes", "conflicting target bytes must remain unchanged");
  assert.ok(
    readdirSync(testDir).every((name) => !name.includes(".upload-")),
    "publication temporary files must be cleaned"
  );

  // writeUploadedFile handles ext with or without leading dot
  const path1 = writeUploadedFile(hash, buf, "txt");
  const path2 = writeUploadedFile(hash, buf, ".txt");
  assert.equal(path.basename(path1), path.basename(path2));
  assert.equal(knowledgeStoragePath(hash.toUpperCase(), ".PDF"), knowledgeStoragePath(hash, ".pdf"), "hash and extension case must canonicalize to one target");

  // Lease state is process-global and visible through independently evaluated route bundles.
  const release = acquireKnowledgeIngestLease(hash, path1);
  assert.equal(hasActiveKnowledgeHashLease(hash.toUpperCase()), true);
  assert.equal(hasActiveKnowledgePathLease(path1), true);
  const require = createRequire(import.meta.url);
  const storageModulePath = require.resolve("../lib/knowledge/storage.ts");
  delete require.cache[storageModulePath];
  const independentExports = require(storageModulePath) as typeof import("../lib/knowledge/storage.ts");
  assert.equal(independentExports.hasActiveKnowledgeHashLease(hash), true, "independent module evaluation must share the global registry");
  assert.equal(independentExports.hasActiveKnowledgePathLease(path1), true, "independent module evaluation must observe path leases");
  release();
  release();
  assert.equal(hasActiveKnowledgeHashLease(hash), false, "lease release must be idempotent");
  assert.equal(hasActiveKnowledgePathLease(path1), false);

  const caseVariant = path.join(path.dirname(path1), path.basename(path1).toUpperCase());
  if (process.platform === "darwin" || process.platform === "win32") {
    assert.equal(canonicalStoragePathKey(caseVariant), canonicalStoragePathKey(path1), "case-insensitive platforms share canonical path keys");
  } else {
    assert.notEqual(canonicalStoragePathKey(caseVariant), canonicalStoragePathKey(path1), "Linux path keys remain case-sensitive");
  }

  // deleteStoredFile removes the file
  assert.equal(deleteStoredFile(filePath), true, "knowledge-owned file should be deleted");
  assert.ok(!existsSync(filePath), "file should be gone after delete");

  // deleteStoredFile is idempotent (no error on missing file)
  assert.equal(deleteStoredFile(filePath), false);
  assert.equal(deleteStoredFile(""), false);
  assert.equal(deleteStoredFile("/nonexistent/path/that/does/not/exist.txt"), false);

  // Existing paths outside the knowledge root are never physically deleted.
  const externalFile = path.join(externalDir, "shared-original.txt");
  writeFileSync(externalFile, "shared attachment");
  assert.equal(deleteStoredFile(externalFile), false, "external file must be rejected");
  assert.ok(existsSync(externalFile), "external file must remain after rejected delete");

  // A path that appears inside the root but escapes through symlink/junction is rejected.
  const escapedFile = path.join(externalDir, "escaped.txt");
  const escapeLink = path.join(testDir, "escape");
  writeFileSync(escapedFile, "escaped attachment");
  try {
    symlinkSync(externalDir, escapeLink, process.platform === "win32" ? "junction" : "dir");
    assert.equal(deleteStoredFile(path.join(escapeLink, "escaped.txt")), false, "symlink/junction escape must be rejected");
    assert.ok(existsSync(escapedFile), "escaped target must remain");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
      console.log(`knowledge-storage: symlink/junction unsupported (${code}), escape case skipped`);
    } else {
      throw error;
    }
  }

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
