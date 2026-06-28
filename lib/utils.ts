import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// 让 tailwind-merge 认识自定义字阶工具类(@theme 里的 --text-*),否则它会把 text-meta/text-title 等
// 误判成与 text-{color} 冲突而丢弃,导致字号回落到 16px(如主按钮变大)。注册进 font-size 组后:
// 字阶与颜色不再互相挤掉;不同字阶之间仍正确取最后一个。
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["figure", "display", "h1", "h2", "title", "body", "small", "meta", "caption"] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
