"use client";

import { useEffect, useRef } from "react";

type Props = {
  data: Uint8Array;
};

export default function DocxPreviewWrapper({ data }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    async function render() {
      const { renderAsync } = await import("docx-preview");
      if (cancelled || !container) return;
      container.innerHTML = "";
      await renderAsync(data, container, undefined, {
        className: "docx-page",
        breakPages: true,
        ignoreFonts: true,
        ignoreHeight: false,
      });
    }

    render();

    return () => {
      cancelled = true;
    };
  }, [data]);

  return <div ref={containerRef} className="docx-preview-container" />;
}
