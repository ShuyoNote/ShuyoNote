import { AI_TOOL_META } from "../capabilities/aiTools.meta";
import { FRONTEND_ADAPTERS } from "../capabilities/frontend";
import type { AiTool } from "./types";

// 工具清单**不再是这里手写的**：元数据（id / 描述 / 参数 schema / 是否写操作）来自
// 能力注册表（生成物 `capabilities/aiTools.meta.ts`），实现在 `capabilities/frontend.ts`。
// 于是"AI 宿主"与"磁盘插件"消费同一份能力定义，仓库里不再有第二套语义工具清单。
//
// 行为不变：读取类立即执行；写入类返回草稿（`{draft:true, key, summary, payload}`），
// 由 host 累积、用户确认后经 lib/ai/apply.ts 落库。

const TOOL_LIST: AiTool[] = AI_TOOL_META.map((meta) => ({
  id: meta.id,
  description: meta.description,
  argsSchema: meta.argsSchema,
  isWrite: meta.isWrite,
  run: async (args, ctx) => {
    const adapter = FRONTEND_ADAPTERS[meta.id];
    // 门禁会挡住"注册表声明了 ai:true 却没有前端实现"，这里是运行期的兜底。
    if (!adapter) return { ok: false, error: `能力 ${meta.id} 没有前端实现` };
    // 把宿主上下文透传下去：适配层据此解析"省略 pageId 时用当前页"。
    return adapter(args as Record<string, unknown>, { currentPageId: ctx?.currentPageId });
  },
}));

export const aiTools: AiTool[] = TOOL_LIST;

export function getAiTool(id: string): AiTool | undefined {
  return TOOL_LIST.find((t) => t.id === id);
}

/** Compact tool description listing for the system prompt. */
export function aiToolSummaries(): string {
  return TOOL_LIST.map((t) => `- ${t.id}: ${t.description}`).join("\n");
}

/** Compose the system prompt for a session. */
export function buildSystemPrompt(ctx: { pages: Array<{ id: string; title: string }> }): string {
  const spacePages = ctx.pages.slice(0, 200).map((p) => `  ${p.id}  ${p.title}`).join("\n");
  return [
    "你是 ShuyoNote 的写作助手。你只能使用下面这些工具操作笔记。",
    "规则:",
    "1. 读取类工具(检索/读页/读块/反链/文件)可直接执行。",
    "2. 写入类工具(新建页面/追加块)返回的是「草稿」：需要用户确认后才真正保存，所以你只需说明意图，不要声称它已保存。",
    "3. 不要执行任何工具外操作(没有 shell、没有任意文件、没有联网)。",
    "",
    "可用工具:",
    aiToolSummaries(),
    "",
    "当前空间的页面(用于把名称解析成 pageId):",
    spacePages || "  (无页面)",
  ].join("\n");
}
