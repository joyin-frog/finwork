"use client";

import { useEffect } from "react";

// 滚动条:平时藏起来,只有正在被滚动的那个容器才浮现,停下 ~1.2s 后淡出。
// 做法:捕获阶段全局监听 scroll(覆盖所有可滚动容器),给「当前被滚动的元素自己」
// 加 .fa-scrolling,每个容器独立计时——所以左侧菜单滚动只亮左侧,主内容滚动只亮主内容。
// 显隐与淡出动画交给 CSS(globals.css 的 .fa-scrolling::-webkit-scrollbar-thumb)。
const FADE_MS = 1200;

export function ScrollbarFade() {
  useEffect(() => {
    // 每个滚动容器一个独立 timer;WeakMap 随元素回收,不漏。
    const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

    const onScroll = (e: Event) => {
      // 文档级滚动 target 是 document,落到根滚动元素(通常 <html>)。
      const el =
        e.target instanceof Element
          ? e.target
          : (document.scrollingElement ?? document.documentElement);
      if (!el) return;

      el.classList.add("fa-scrolling");
      const prev = timers.get(el);
      if (prev) clearTimeout(prev);
      timers.set(
        el,
        setTimeout(() => el.classList.remove("fa-scrolling"), FADE_MS),
      );
    };

    // capture:true —— scroll 不冒泡,捕获阶段才能听到任意子容器的滚动。
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, []);

  return null;
}
