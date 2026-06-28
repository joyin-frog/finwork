"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * 段级渲染崩溃兜底页(§16.2)。
 * 不露堆栈;显示短错误码 digest;触发 POST /api/errors。
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    try {
      fetch("/api/errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "render",
          source: "segment-error",
          message: error?.message ?? "Unknown render error",
          stack: error?.stack ?? null,
        }),
      }).catch(() => {});
    } catch {
      // 静默
    }
  }, [error]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        padding: "2rem",
        textAlign: "center",
      }}
    >
      <div
        style={{
          maxWidth: 400,
          padding: "1.75rem 2rem",
          background: "var(--background, #fff)",
          borderRadius: 12,
          border: "1px solid var(--border, #e5e7eb)",
        }}
      >
        <div style={{ fontSize: 36, marginBottom: "0.75rem" }}>⚠️</div>
        <h2
          style={{
            fontSize: "1.1rem",
            fontWeight: 600,
            color: "var(--foreground, #111827)",
            margin: "0 0 0.5rem",
          }}
        >
          这个页面出了点小问题
        </h2>
        <p
          style={{
            color: "var(--muted-foreground, #6b7280)",
            fontSize: "0.875rem",
            margin: "0 0 1.25rem",
            lineHeight: 1.6,
          }}
        >
          已自动记录,点重试或返回首页继续使用。
        </p>
        {error?.digest && (
          <p
            style={{
              color: "#9ca3af",
              fontSize: "0.72rem",
              fontFamily: "monospace",
              margin: "0 0 1.25rem",
            }}
          >
            错误码: {error.digest}
          </p>
        )}
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center" }}>
          <button
            onClick={reset}
            style={{
              padding: "0.45rem 1rem",
              background: "var(--foreground, #111827)",
              color: "var(--background, #fff)",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: "0.85rem",
              fontWeight: 500,
            }}
          >
            重试
          </button>
          <Link
            href="/"
            style={{
              padding: "0.45rem 1rem",
              background: "transparent",
              color: "var(--foreground, #374151)",
              border: "1px solid var(--border, #d1d5db)",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: "0.85rem",
              fontWeight: 500,
              textDecoration: "none",
              display: "inline-block",
            }}
          >
            回首页
          </Link>
        </div>
      </div>
    </div>
  );
}
