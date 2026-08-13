import { createHash } from "node:crypto";
import { copyFile, readFile } from "node:fs/promises";
import type { DocumentDiff, DocumentIr, DocumentNode, PreservationManifest } from "./contracts";

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function key(node: DocumentNode): string {
  return `${node.kind}:${JSON.stringify(node.locator)}`;
}

export function diffDocumentIr(source: DocumentIr, target: DocumentIr, visualSimilarity: number | null = null): DocumentDiff {
  const before = new Map(source.nodes.map((item) => [key(item), item]));
  const after = new Map(target.nodes.map((item) => [key(item), item]));
  const added = [...after].filter(([itemKey]) => !before.has(itemKey)).map(([, item]) => item);
  const removed = [...before].filter(([itemKey]) => !after.has(itemKey)).map(([, item]) => item);
  const changed = [...before].flatMap(([itemKey, item]) => {
    const next = after.get(itemKey);
    return next && JSON.stringify(item) !== JSON.stringify(next) ? [{ before: item, after: next }] : [];
  });
  const denominator = Math.max(1, source.nodes.length, target.nodes.length);
  return {
    sourceSha256: source.sourceSha256,
    targetSha256: target.sourceSha256,
    added,
    removed,
    changed,
    structureSimilarity: Math.max(0, 1 - (added.length + removed.length + changed.length) / denominator),
    visualSimilarity,
  };
}

export function assertPreservationPolicy(manifest: PreservationManifest): void {
  if (manifest.blocked) throw new Error(`document_preservation_blocked:${manifest.blockingReasons.join(";")}`);
}

/**
 * Lossless no-op round-trip. Edits are deliberately handled by format-specific
 * operation adapters; copying the package gives the preservation layer a
 * byte-for-byte reference implementation and prevents silent normalization.
 */
export async function preserveRoundTrip(sourcePath: string, targetPath: string, manifest: PreservationManifest): Promise<{
  sourceSha256: string;
  targetSha256: string;
  byteIdentical: boolean;
}> {
  assertPreservationPolicy(manifest);
  const source = await readFile(sourcePath);
  await copyFile(sourcePath, targetPath);
  const target = await readFile(targetPath);
  return { sourceSha256: hash(source), targetSha256: hash(target), byteIdentical: Buffer.compare(source, target) === 0 };
}
