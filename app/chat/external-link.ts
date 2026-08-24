/** 外部链接:桌面壳走系统浏览器打开;浏览器模式回退 window.open。 */
export async function openExternalUrl(href: string) {
  const { getDesktop } = await import("@/lib/desktop/client");
  const desktop = getDesktop();
  if (desktop) {
    try {
      await desktop.openExternal(href);
      return;
    } catch (err) {
      console.error("[external-link] desktop open failed", err);
    }
  }
  window.open(href, "_blank", "noopener,noreferrer");
}
