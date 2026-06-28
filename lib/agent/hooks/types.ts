export type BeforeToolResult =
  | { action: "allow"; input?: unknown }
  | { action: "deny"; reason: string }
  | { action: "confirm"; prompt: string };

export type HookContext = {
  toolName: string;
  input: unknown;
  outputDir: string;
  resolveUserQuestion?: (q: { question: string; header?: string }) => Promise<string>;
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
