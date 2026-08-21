import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("FWC1");

export function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

export function privateContentId(key: Uint8Array, bytes: Uint8Array, prefix: string): string {
  return `${prefix}_${createHmac("sha256", key).update(sha256(bytes)).digest("hex")}`;
}

export function privateStringId(key: Uint8Array, value: string, prefix: string): string {
  return `${prefix}_${createHmac("sha256", key).update(value).digest("hex")}`;
}

export function encryptBytes(key: Uint8Array, plaintext: Uint8Array, aad?: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptBytes(key: Uint8Array, payload: Uint8Array, aad?: string): Buffer {
  const value = Buffer.from(payload);
  if (value.length < 32 || !value.subarray(0, 4).equals(MAGIC)) throw new Error("文件工作区密文格式无效");
  const nonce = value.subarray(4, 16);
  const tag = value.subarray(16, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(value.subarray(32)), decipher.final()]);
}

export function encryptStringFields(key: Uint8Array, plaintext: string, aad: string) {
  const packed = encryptBytes(key, Buffer.from(plaintext, "utf8"), aad);
  return {
    ciphertext: packed.subarray(32).toString("base64"),
    nonce: packed.subarray(4, 16).toString("base64"),
    tag: packed.subarray(16, 32).toString("base64"),
  };
}

export function decryptStringFields(
  key: Uint8Array,
  fields: { ciphertext: string; nonce: string; tag: string },
  aad: string,
): string {
  const packed = Buffer.concat([
    MAGIC,
    Buffer.from(fields.nonce, "base64"),
    Buffer.from(fields.tag, "base64"),
    Buffer.from(fields.ciphertext, "base64"),
  ]);
  return decryptBytes(key, packed, aad).toString("utf8");
}
