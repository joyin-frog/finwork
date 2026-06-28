"use client";

import { createContext, useContext } from "react";

/** 回答语气模式:daily=非技术财务(过程只看干净步骤);tech=技术用户(每步可点开看原始 I/O)。 */
export type RoleMode = "daily" | "tech";

const RoleModeContext = createContext<RoleMode>("daily");

export const RoleModeProvider = RoleModeContext.Provider;

/** 深层组件(工具步)读当前 roleMode;无 Provider 时默认 daily。 */
export function useRoleMode(): RoleMode {
  return useContext(RoleModeContext);
}
