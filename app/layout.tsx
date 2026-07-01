import type { Metadata, Viewport } from "next";
import fs from "node:fs";
import path from "node:path";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { Inter, JetBrains_Mono } from "next/font/google";
import { getProjectRoot } from "@/lib/runtime/paths";
import { NavStateProvider } from "./shared/nav-state";
import { UserIdentityProvider } from "./shared/user-identity";
import { ChatStreamProvider } from "./shared/chat-stream";
import { AppThemeProvider } from "./shared/theme-provider";
import { AppShell } from "./shared/app-shell";
import { ScrollbarFade } from "./shared/scrollbar-fade";
import { cn } from "@/lib/utils";
import "./globals.css";
import "./styles/preview.css";

// 可选字体方案(next/font 自托管,离线可用):Inter 正文 + JetBrains Mono 财务数字/代码。
// 经 /dev/theme 字体下拉切换体验;转正则改 globals.css 的 --font-sans/--font-mono。
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains",
  display: "swap",
});

const highlightLightCSS = prefixCssScope(
  fs.readFileSync(path.join(getProjectRoot(), "node_modules/highlight.js/styles/atom-one-light.css"), "utf-8"),
  "html:not(.dark)"
);
const highlightDarkCSS = prefixCssScope(
  fs.readFileSync(path.join(getProjectRoot(), "node_modules/highlight.js/styles/atom-one-dark.css"), "utf-8"),
  "html.dark"
);

export const metadata: Metadata = {
  title: "Finance Agent",
  description: "财务 Agent 第一版工作台",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="zh-CN"
      className={cn(GeistSans.variable, GeistMono.variable, inter.variable, jetbrainsMono.variable)}
      suppressHydrationWarning
    >
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <style dangerouslySetInnerHTML={{ __html: `${highlightLightCSS}\n${highlightDarkCSS}` }} />
      </head>
      <body className="antialiased font-sans bg-background text-foreground">
        <AppThemeProvider>
          <ScrollbarFade />
          <NavStateProvider>
            <UserIdentityProvider>
              <ChatStreamProvider>
                <AppShell>{children}</AppShell>
              </ChatStreamProvider>
            </UserIdentityProvider>
          </NavStateProvider>
        </AppThemeProvider>
      </body>
    </html>
  );
}

function prefixCssScope(css: string, scope: string) {
  return css.replace(/(^|})\s*([^@}{][^{]+)\{/g, (_match, brace, selectors) => {
    const scopedSelectors = selectors
      .split(",")
      .map((s: string) => `${scope} ${s.trim()}`)
      .join(", ");
    return `${brace}\n${scopedSelectors} {`;
  });
}
