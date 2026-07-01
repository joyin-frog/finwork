export type BeforeToolResult =
  | { action: "allow"; input?: unknown }
  | { action: "deny"; reason: string }
  | { action: "confirm"; prompt: string };

export type HookContext = {
  toolName: string;
  input: unknown;
  outputDir: string;
  // 多题一次下发:传 questions[] 时前端一个浮层左右切换,答案以 JSON 串返回;
  // 单题(仅 question/header)保持原路径,答案为纯文本。
  resolveUserQuestion?: (q: {
    question: string;
    header?: string;
    questions?: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean }>;
  }) => Promise<string>;
};

export type AfterHookContext = HookContext & {
  result: string;
  isError: boolean;
  durationMs: number;
};

export type Hook = {
  name: string;
  before?: (ctx: HookContext) => Promise<BeforeToolResult>;
  after?: (ctx: AfterHookContext) => Promise<void>;
};

export type HookChain = Hook[];
