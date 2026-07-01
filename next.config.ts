import type { NextConfig } from "next";
import path from "node:path";
import { readFileSync } from "node:fs";

// 版本号来自 package.json,构建期注入 NEXT_PUBLIC_APP_VERSION 供「关于」页展示。
const appVersion = (() => {
  try {
    return JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf-8")).version as string;
  } catch {
    return "";
  }
})();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  env: { NEXT_PUBLIC_APP_VERSION: appVersion },
  outputFileTracingRoot: path.join(__dirname),
  // layout.tsx 运行时 fs.readFileSync 读 highlight.js 主题 CSS 来内联代码高亮配色;
  // standalone 输出只 trace JS、不含这俩 CSS → 打包后 ENOENT 致全站 500。显式纳入 trace。
  outputFileTracingIncludes: {
    "/**": [
      "./node_modules/highlight.js/styles/atom-one-light.css",
      "./node_modules/highlight.js/styles/atom-one-dark.css",
    ],
  },
  devIndicators: false,
  serverExternalPackages: [],
  experimental: {
    serverActions: {
      bodySizeLimit: "8mb"
    }
  },
  // instrumentation.ts 在 NEXT_RUNTIME==="nodejs" 守卫内动态 import 一串 node-only 模块
  // (server-log→paths→node:fs、flags→sqlite→node:sqlite 等)。生产 build 靠 DCE 把 edge 分支消掉,
  // 但 dev 不做 DCE,webpack 仍把整条子树打进 edge 版 instrumentation,而 edge target 不认 node: scheme
  // → UnhandledSchemeError。这些代码在 edge 永不执行(本应用也无 middleware/edge 路由),故对非 nodejs
  // 编译统一忽略所有 node: 内建即可;nodejs runtime 不挂该插件,行为完全不变。
  webpack: (config, { nextRuntime, webpack }) => {
    if (nextRuntime !== "nodejs") {
      config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^node:/ }));
    }
    return config;
  }
};

export default nextConfig;
