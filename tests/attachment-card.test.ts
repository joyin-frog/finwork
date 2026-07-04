import assert from "node:assert/strict";
import { isRenderableImage } from "../app/chat/attachment-card";

// isRenderableImage 决定附件走"满卡图片预览"还是"文件卡"。重点覆盖 HEIC 边界:
// 浏览器解不了 HEIC,mime 与文件名任一命中 heic/heif 都必须判为不可渲染。
export const attachmentCardTestPromise = (async () => {
  // 可渲染图片
  assert.equal(isRenderableImage("a.png", "image/png"), true, "png 可渲染");
  assert.equal(isRenderableImage("a.JPG", "image/jpeg"), true, "大写 jpg 可渲染");
  assert.equal(isRenderableImage("a.webp", "image/webp"), true, "webp 可渲染");
  // 纯图片 mime、无扩展名 → 当图片
  assert.equal(isRenderableImage("clipboard", "image/png"), true, "无扩展名图片 mime 当图片");

  // HEIC:三种不一致组合都必须判死
  assert.equal(isRenderableImage("a.heic", "image/heic"), false, "heic mime+名");
  assert.equal(isRenderableImage("a.HEIC", "application/octet-stream"), false, "heic 名 + 泛 mime");
  assert.equal(isRenderableImage("photo.jpg", "image/heic"), false, "heic mime + 误标 jpg 名 → 仍判死");
  assert.equal(isRenderableImage("a.heif", "image/heif"), false, "heif 同样判死");

  // 文档 → 文件卡
  assert.equal(isRenderableImage("x.pdf", "application/pdf"), false, "pdf 是文件");
  assert.equal(isRenderableImage("x.xlsx", "application/vnd.ms-excel"), false, "xlsx 是文件");
  assert.equal(isRenderableImage("readme", "text/plain"), false, "无扩展名非图片 mime 是文件");

  console.log("attachment-card: isRenderableImage HEIC/图片/文件 边界 ✓");
})();
