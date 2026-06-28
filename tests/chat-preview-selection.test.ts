import assert from "node:assert/strict";

import {
  previewSelectionFromConversationFile,
  previewSelectionFromDisplayFile,
  previewSelectionFromDraftAttachment,
  previewSelectionFromReferencedFile,
  shouldShowScrollToBottom
} from "../app/chat/chat-preview-selection";

function main() {
  const conversationSelection = previewSelectionFromConversationFile(14, {
    fileName: "report.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: 2048,
    storagePath: "generate/report.xlsx"
  });
  assert.equal(conversationSelection.kind, "conversation");
  assert.equal(conversationSelection.conversationId, 14);

  const draftSelection = previewSelectionFromDraftAttachment({
    name: "draft.txt",
    mimeType: "text/plain",
    size: 12,
    dataUrl: "data:text/plain;base64,SGVsbG8=",
    text: "Hello"
  });
  assert.equal(draftSelection.kind, "draft");
  assert.equal(draftSelection.text, "Hello");

  const referencedSelection = previewSelectionFromReferencedFile(22, {
    name: "source.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4096,
    storagePath: "uploads/source.pdf"
  });
  assert.equal(referencedSelection.kind, "conversation");
  assert.equal(referencedSelection.storagePath, "uploads/source.pdf");

  const displayConversation = previewSelectionFromDisplayFile({
    name: "saved.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: 88,
    storagePath: "docs/saved.docx"
  }, 8);
  assert.equal(displayConversation?.kind, "conversation");

  const displayDraft = previewSelectionFromDisplayFile({
    name: "local.md",
    mimeType: "text/markdown",
    sizeBytes: 77,
    dataUrl: "data:text/markdown;base64,IyBIZWxsbw==",
    text: "# Hello"
  }, null);
  assert.equal(displayDraft?.kind, "draft");

  assert.equal(shouldShowScrollToBottom(0, 600, 640), false, "near-bottom threads should not show the scroll button");
  assert.equal(shouldShowScrollToBottom(0, 600, 900), true, "scrolled-up threads should show the scroll button");

  console.log("✓ PASS: preview selection helpers cover conversation, draft and scroll-button states");
}

main();
