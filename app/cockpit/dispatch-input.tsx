"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import type { CalendarContext } from "@/lib/domain/tax-calendar";
import { getCockpitSuggestions } from "@/lib/domain/cockpit-suggestions";

export function DispatchInput({ calendar }: { calendar: CalendarContext | null }) {
  const [text, setText] = useState("");
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const placeholder = calendar
    ? getCockpitSuggestions(calendar).placeholder
    : "有什么财务问题？让专员帮你处理…";

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && text.trim()) {
      router.push("/chat/new?prompt=" + encodeURIComponent(text.trim()));
    }
  }

  // 监听 cockpit:prefill-dispatch 事件，设值并聚焦
  useEffect(() => {
    function handlePrefill(e: Event) {
      const detail = (e as CustomEvent<{ text: string }>).detail;
      if (detail?.text) {
        setText(detail.text);
        inputRef.current?.focus();
      }
    }

    window.addEventListener("cockpit:prefill-dispatch", handlePrefill);
    return () => {
      window.removeEventListener("cockpit:prefill-dispatch", handlePrefill);
    };
  }, []);

  return (
    <Input
      id="dispatch-input-field"
      ref={inputRef}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      className="w-full h-9 text-body"
      aria-label="派活入口"
    />
  );
}
