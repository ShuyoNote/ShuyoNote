// 把「Rust 叫前端算一份东西」那条桥挂上（B3）。
//
// 只在**主窗口**挂：独立页窗口（`?page=<id>`）不参与 —— 与 `useExternalDrafts` 同一条口径
// （一个应用只做一次；多窗口各算一遍既浪费、也可能让两份结果互相盖）。
//
// ⚠️ 这里**不**把"前端在不在"写进任何 store：就绪信号是给 Rust 的（`mcp_frontend_tool_ready`），
// 界面不显示它（外部 AI 接入面板已有自己的状态读数）。
import { useEffect } from "react";
import { registerMcpFrontendTools } from "../lib/mcpFrontendTools";
import { standalonePageIdOf } from "../lib/externalDrafts";

export function useMcpFrontendTools(): void {
  useEffect(() => {
    if (standalonePageIdOf(window.location.search)) return;
    const unregister = registerMcpFrontendTools();
    return unregister;
  }, []);
}
