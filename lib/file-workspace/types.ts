export type WorkspaceSourceKind = "managed" | "external" | "generated";
export type WorkspaceFileRole = "input" | "output" | "baseline" | "evidence";

export type WorkspaceAssetRef = {
  assetId: string;
  versionId: string;
  blobId: string | null;
  name: string;
  mediaType: string;
  sizeBytes: number;
  sourceKind: WorkspaceSourceKind;
};

export type WorkspaceRootRef = {
  rootId: string;
  name: string;
  path: string;
  permission: "read" | "read_write";
  writePolicy: "output_subdir" | "confirm_replace";
  outputSubdir: string;
};

export type PreparedWorkspaceFile = WorkspaceAssetRef & {
  path: string;
  role: WorkspaceFileRole;
};

export type SemanticDiff = {
  kind: "xlsx" | "text" | "binary";
  summary: string;
  changed: boolean;
  details: Record<string, unknown>;
};

/**
 * Agent 在修改前声明的最小可验证计划。Excel 目标可以由语义 diff 确定性判定；
 * 只有 description 的目标保留为待复核，不能由模型自行声称完成。
 */
export type WorkspaceChangeTarget = {
  description: string;
  sheet?: string;
  cell?: string;
  expectedValue?: string | number | boolean | null;
  expectedFormula?: string;
  mustChange?: boolean;
};

export type WorkspaceChangePlanResult = {
  complete: boolean;
  completed: Array<WorkspaceChangeTarget & { address?: string }>;
  pending: Array<WorkspaceChangeTarget & { address?: string; reason: string }>;
};
