import { getDb } from "@/lib/db/sqlite";
import { getFileWorkspaceDir } from "@/lib/runtime/paths";
import { getFileWorkspaceMasterKey } from "./key-store";
import { FileWorkspaceStore } from "./store";
export { FileWorkspaceStore } from "./store";

export async function getFileWorkspaceStore(): Promise<FileWorkspaceStore> {
  return new FileWorkspaceStore(getDb(), getFileWorkspaceDir(), await getFileWorkspaceMasterKey());
}

export * from "./types";
export * from "./semantic-diff";
export * from "./execution-evidence";
