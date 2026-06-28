import { FilePreviewPage } from "@/app/shared/file-preview-page";

export default function PreviewPage() {
  return (
    <section className="flex flex-col h-full w-full overflow-hidden bg-background">
      <FilePreviewPage
        selection={null}
        title="独立预览页"
        description="这个页面可单独打开本地文件，也和聊天页右侧预览器复用同一套逻辑。"
      />
    </section>
  );
}
