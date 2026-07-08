/**
 * WP12: embedding 模型下载/路径解析。
 *
 * 模型不内置仓库，运行时下载到 <appData>/models/<modelName>/。
 * 候选源（按优先级）：
 *   1. FINANCE_AGENT_EMBED_MODEL_URL（整条自托管 URL）
 *   2. hf-mirror.com（国内镜像）
 *   3. huggingface.co（原始源）
 *
 * 下载逻辑可注入（步骤注入），便于单测无真实网络。
 */

import * as fs from "node:fs";
import path from "node:path";
import { getAppDataDir } from "@/lib/runtime/paths";

export const EMBED_MODEL = "bge-small-zh-v1.5";
const MODEL_NAME = EMBED_MODEL;
const MODEL_FILES = ["model_quantized.onnx", "tokenizer.json"];
const HF_REPO = "Xenova/bge-small-zh-v1.5";

/**
 * 各模型文件在 HF repo 中的相对路径。
 * model_quantized.onnx 位于 onnx/ 子目录，tokenizer.json 在根目录。
 */
const HF_REMOTE_PATH: Record<string, string> = {
  "model_quantized.onnx": "onnx/model_quantized.onnx",
  "tokenizer.json": "tokenizer.json",
};

export type DownloadStep = (url: string, destFile: string) => Promise<void>;

export interface EmbedModelPaths {
  modelDir: string;
  ready: boolean; // 所有文件已存在
}

/**
 * 解析模型目录路径。
 */
export function getEmbedModelDir(modelName = MODEL_NAME): string {
  return path.join(getAppDataDir(), "models", modelName);
}

/**
 * 检查模型文件是否完整（全部文件存在）。
 */
export function isEmbedModelReady(modelName = MODEL_NAME): boolean {
  const dir = getEmbedModelDir(modelName);
  return MODEL_FILES.every(f => fs.existsSync(path.join(dir, f)));
}

/**
 * 解析某个模型文件的候选下载 URL 列表（按优先级排列）。
 * 每个 entry 为 { file, url }。
 */
export function resolveEmbedModelUrls(
  files = MODEL_FILES
): string[] {
  const urls: string[] = [];

  const selfHost = process.env.FINANCE_AGENT_EMBED_MODEL_URL?.trim();

  for (const file of files) {
    const remotePath = HF_REMOTE_PATH[file] ?? file;
    const hfMirror = `https://hf-mirror.com/${HF_REPO}/resolve/main/${remotePath}`;
    const hfRaw = `https://huggingface.co/${HF_REPO}/resolve/main/${remotePath}`;

    if (selfHost) {
      // 自托管 URL：以本地文件名（非 onnx/ 子路径）拼接
      urls.push(selfHost.replace(/\/?$/, "/") + file);
    }
    urls.push(hfMirror);
    urls.push(hfRaw);
  }

  return urls;
}

/**
 * 解析各模型文件对应的有序候选 URL（按文件分组）。
 * 返回 Array<{ file, urls }>，外层按 files 顺序，内层按优先级排列。
 */
export function resolveEmbedModelFileUrls(
  files = MODEL_FILES
): Array<{ file: string; urls: string[] }> {
  const selfHost = process.env.FINANCE_AGENT_EMBED_MODEL_URL?.trim();

  return files.map(file => {
    const remotePath = HF_REMOTE_PATH[file] ?? file;
    const candidates: string[] = [];
    if (selfHost) {
      // 自托管 URL：以本地文件名（非 onnx/ 子路径）拼接
      candidates.push(selfHost.replace(/\/?$/, "/") + file);
    }
    candidates.push(`https://hf-mirror.com/${HF_REPO}/resolve/main/${remotePath}`);
    candidates.push(`https://huggingface.co/${HF_REPO}/resolve/main/${remotePath}`);
    return { file, urls: candidates };
  });
}

/**
 * 下载模型文件（若已存在则跳过）。步骤注入便于单测。
 * 全部候选源失败时不抛——返回 ok:false，调用方降级。
 */
export async function ensureEmbedModel(opts: {
  modelName?: string;
  files?: string[];
  download: DownloadStep;
  onProgress?: (msg: string) => void;
}): Promise<{ ok: boolean; modelDir: string; detail: string }> {
  const modelName = opts.modelName ?? MODEL_NAME;
  const files = opts.files ?? MODEL_FILES;
  const onProgress = opts.onProgress ?? (() => {});
  const modelDir = getEmbedModelDir(modelName);

  fs.mkdirSync(modelDir, { recursive: true });

  const fileUrls = resolveEmbedModelFileUrls(files);
  let anyFailed = false;
  let lastError = "";

  for (const { file, urls } of fileUrls) {
    const destFile = path.join(modelDir, file);
    if (fs.existsSync(destFile)) {
      onProgress(`${file} 已就绪，跳过下载`);
      continue;
    }

    let downloaded = false;
    for (const url of urls) {
      try {
        onProgress(`正在下载 ${file}…`);
        await opts.download(url, destFile);
        downloaded = true;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    if (!downloaded) {
      anyFailed = true;
    }
  }

  if (anyFailed) {
    return { ok: false, modelDir, detail: `模型文件下载失败:${lastError}` };
  }
  return { ok: true, modelDir, detail: "embedding 模型已就绪" };
}
