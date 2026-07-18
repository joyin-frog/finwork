import type { ComponentProps } from "react";

import { Surface } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

type AgentTabSurfaceProps = Omit<ComponentProps<typeof Surface>, "level" | "edge" | "shape">;

/** 智能体工作台各页签共用的主内容画布；页签只负责内部信息布局。 */
export function AgentTabSurface({ className, pad = "card", ...props }: AgentTabSurfaceProps) {
  return (
    <Surface
      {...props}
      level="card"
      edge="hairline"
      shape="card"
      pad={pad}
      className={cn("w-full max-w-3xl overflow-hidden", className)}
    />
  );
}
