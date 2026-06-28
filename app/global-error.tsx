"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * 根布局崩溃兜底页(§16.2)。
 * - 不露堆栈。
 * - 显示短错误码 digest(无语义,仅供技术反查)。
 * - 触发 POST /api/errors 上报(fire-and-forget,失败静默)。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // fire-and-forget,失败静默,不能造成错误循环
    try {
      fetch("/api/errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "render",
          source: "global-error",
          message: error?.message ?? "Unknown render error",
          stack: error?.stack ?? null,
        }),
      }).catch(() => {});
    } catch {
      // 静默
    }
  }, [error]);

  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#fafafa" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            padding: "2rem",
            textAlign: "center",
          }}
        >
          <div
            style={{
              maxWidth: 420,
              padding: "2rem 2.5rem",
              background: "#fff",
              borderRadius: 16,
              boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
              border: "1px solid #e5e7eb",
            }}
          >
            <div style={{ fontSize: 40, marginBottom: "1rem" }}>😔</div>
            <h1
              style={{
                fontSize: "1.25rem",
                fontWeight: 600,
                color: "#111827",
                margin: "0 0 0.75rem",
              }}
            >
              页面出了点小问题
            </h1>
            <p style={{ color: "#6b7280", fontSize: "0.9rem", margin: "0 0 1.5rem", lineHeight: 1.6 }}>
              应用遇到了意外错误,已自动记录。这通常是临时性的,点重试往往就能恢复。
            </p>
            {error?.digest && (
              <p
                style={{
                  color: "#9ca3af",
                  fontSize: "0.75rem",
                  fontFamily: "monospace",
                  margin: "0 0 1.5rem",
                }}
              >
                错误码: {error.digest}
              </p>
            )}
            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap" }}>
              <button
                onClick={reset}
                style={{
                  padding: "0.5rem 1.25rem",
                  background: "#111827",
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  cursor: "pointer",
                  fontSize: "0.875rem",
                  fontWeight: 500,
                }}
              >
                重试
              </button>
              <Link
                href="/"
                style={{
                  padding: "0.5rem 1.25rem",
                  background: "transparent",
                  color: "#374151",
                  border: "1px solid #d1d5db",
                  borderRadius: 8,
                  cursor: "pointer",
                  fontSize: "0.875rem",
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
      </body>
    </html>
  );
}
