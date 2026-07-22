import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { sha256File } from "./hash";
import { mimeFromExtension } from "./mime";

export type ImmutableCopyResult =
  | {
      ok: true;
      deliveredPath: string;
      deliveredSha256: string;
      mime: string;
      sizeBytes: number;
    }
  | { ok: false; code: string; message: string };

/**
 * 将已验证工作文件原子复制到 delivered/，再哈希，关闭 TOCTOU：
 * 正式附件只指向副本；工作文件此后被改不影响交付。
 */
export function copyToDeliveredImmutable(args: {
  workingPath: string;
  deliveredDir: string;
  fileName: string;
  /** 校验通过时的候选 hash；复制后必须一致 */
  expectedSha256: string;
}): ImmutableCopyResult {
  const { workingPath, deliveredDir, fileName, expectedSha256 } = args;
  if (!existsSync(workingPath)) {
    return { ok: false, code: "file_not_found", message: "工作文件在复制前消失" };
  }

  const preHash = sha256File(workingPath);
  if (preHash !== expectedSha256) {
    return { ok: false, code: "hash_mismatch", message: "复制前工作文件 hash 与校验报告不一致" };
  }

  mkdirSync(deliveredDir, { recursive: true });
  const safeName = path.basename(fileName);
  const finalPath = path.join(deliveredDir, safeName);
  const tmpPath = path.join(deliveredDir, `.${safeName}.${process.pid}.tmp`);

  try {
    copyFileSync(workingPath, tmpPath);
    const tmpHash = sha256File(tmpPath);
    if (tmpHash !== expectedSha256) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        /* ignore */
      }
      return { ok: false, code: "hash_mismatch", message: "复制后 tmp hash 不一致（TOCTOU）" };
    }
    // 原子替换
    renameSync(tmpPath, finalPath);
  } catch (e) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      code: "copy_failed",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  const deliveredSha256 = sha256File(finalPath);
  if (deliveredSha256 !== expectedSha256) {
    try {
      rmSync(finalPath, { force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, code: "hash_mismatch", message: "delivered 副本 re-hash 失败" };
  }

  const st = statSync(finalPath);
  return {
    ok: true,
    deliveredPath: finalPath,
    deliveredSha256,
    mime: mimeFromExtension(safeName),
    sizeBytes: st.size,
  };
}

/** 测试辅助：写入标记文件证明 delivered 目录存在且可区分 */
export function writeDeliveredMarker(deliveredDir: string, note: string): void {
  mkdirSync(deliveredDir, { recursive: true });
  writeFileSync(path.join(deliveredDir, ".delivered-ok"), note, "utf8");
}
