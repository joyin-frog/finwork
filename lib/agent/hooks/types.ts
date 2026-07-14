export type BeforeToolResult =
  | { action: "allow"; input?: unknown }
  | { action: "deny"; reason: string }
  | { action: "confirm"; prompt: string; trustable?: boolean };

export type HookContext = {
  toolName: string;
  input: unknown;
  outputDir: string;
  /** 当前对话 id：传入后信任存储可按对话作用域;缺省时 sentinel 仅当次放行、不写信任。 */
  conversationId?: number;
  // 多题一次下发:传 questions[] 时前端一个浮层左右切换,答案以 JSON 串返回;
  // 单题(仅 question/header)保持原路径,答案为纯文本。
  resolveUserQuestion?: (q: {
    question: string;
    header?: string;
    questions?: Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean }>;
    // 高风险工具确认门:confirm 时前端渲染为确认卡(两按钮,无文本框);缺省为普通提问。
    kind?: "confirm";
    // run_python 专属:true 时前端渲染「本次对话不再询问」勾选项。
    trustable?: boolean;
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
