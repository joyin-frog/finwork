/** 外部链接:桌面壳走 Tauri shell 在系统浏览器打开(避开 webview 对 _blank 的拦截);浏览器回退 window.open。 */
export async function openExternalUrl(href: string) {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(href);
      return;
    } catch (err) {
      console.error("[external-link] tauri open failed", err);
    }
  }
  window.open(href, "_blank", "noopener,noreferrer");
}
