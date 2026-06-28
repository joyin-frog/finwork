"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, CheckListIcon } from "@hugeicons/core-free-icons";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CockpitTodo } from "@/lib/domain/cockpit-todos";

export function TodosCard({ todos }: { todos: CockpitTodo[] | null }) {
  const hasUrgent = todos?.some((t) => t.severity === "urgent") ?? false;
  return (
    <Card>
      <CardHeader>
        <div
          className="flex size-6 items-center justify-center rounded-md fa-toned"
          style={{ "--tone": hasUrgent ? "var(--tone-alarm)" : "var(--tone-notice)" } as CSSProperties}
        >
          <HugeiconsIcon icon={CheckListIcon} size={13} aria-hidden />
        </div>
        <CardTitle>待办</CardTitle>
      </CardHeader>
      <CardContent>
        {todos == null ? (
          <p className="text-body text-muted-foreground">加载中…</p>
        ) : todos.length === 0 ? (
          <p className="text-body text-muted-foreground py-2">当前节点无待办,一切就绪。</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border -mx-4">
            {todos.map((todo) => (
              <li key={todo.id}>
                <Link
                  href={todo.href}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent transition-colors"
                >
                  <span
                    className={`fa-tone-dot shrink-0 ${todo.severity === "urgent" ? "fa-dot-pulse" : ""}`}
                    style={{ "--tone": todo.severity === "urgent" ? "var(--tone-alarm)" : "var(--tone-notice)" } as CSSProperties}
                    aria-label={todo.severity === "urgent" ? "紧急" : "普通"}
                  />
                  <span className="text-body flex-1 min-w-0">{todo.label}</span>
                  <HugeiconsIcon icon={ArrowRight01Icon} size={14} className="text-muted-foreground shrink-0" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
