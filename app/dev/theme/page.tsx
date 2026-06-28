import { notFound } from "next/navigation";
import { ThemePlayground } from "./theme-playground";

// dev-only 设计调试页:生产构建屏蔽(只在 npm run dev 可用),不进用户导航。
// 改动实时写 :root CSS 变量预览;满意后用「导出」把值粘回 app/globals.css。
export default function DevThemePage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ThemePlayground />;
}
