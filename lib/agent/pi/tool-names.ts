/** Pure, side-effect-free authority for the Pi builtins Finwork can construct. */
export const FINWORK_READ_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export const FINWORK_WRITE_TOOL_NAMES = ["write", "edit"] as const;
export const FINWORK_BUILTIN_TOOL_NAMES = [
  ...FINWORK_READ_TOOL_NAMES,
  ...FINWORK_WRITE_TOOL_NAMES,
  "bash",
] as const;
export const FINWORK_ASK_USER_TOOL_NAME = "AskUserQuestion" as const;

export type FinworkBuiltinToolName = (typeof FINWORK_BUILTIN_TOOL_NAMES)[number];
