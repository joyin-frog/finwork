export type AnnKey = { bandNo: number; bucketHash: string };

function pseudoSign(seed: number): number {
  let value = seed | 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value & 1) === 0 ? -1 : 1;
}

export function annBucketKeys(vector: readonly number[], bands = 8, bitsPerBand = 8): AnnKey[] {
  if (vector.length === 0) throw new Error("ANN vector must not be empty");
  if (!Number.isInteger(bands) || bands < 1 || bands > 64) throw new Error("invalid ANN band count");
  if (!Number.isInteger(bitsPerBand) || bitsPerBand < 1 || bitsPerBand > 24) throw new Error("invalid ANN bits per band");
  const keys: AnnKey[] = [];
  for (let band = 0; band < bands; band += 1) {
    let hash = 0;
    for (let bit = 0; bit < bitsPerBand; bit += 1) {
      let projection = 0;
      for (let dimension = 0; dimension < vector.length; dimension += 1) {
        projection += vector[dimension] * pseudoSign((band + 1) * 73_856_093 ^ (bit + 1) * 19_349_663 ^ (dimension + 1) * 83_492_791);
      }
      if (projection >= 0) hash |= 1 << bit;
    }
    keys.push({ bandNo: band, bucketHash: hash.toString(16).padStart(Math.ceil(bitsPerBand / 4), "0") });
  }
  return keys;
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

export function vectorToBuffer(vector: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

export function bufferToVector(buffer: Uint8Array): number[] {
  const bytes = buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength
    ? buffer.buffer
    : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return Array.from(new Float32Array(bytes));
}
