// ⭐ R155 的**播种执行体** —— 「外部写」与「恢复历史版本」两条路**只有这一份**依赖实现。
//
// ## 它修的是什么（两条路同一个病）
//
// 外部写（MCP／插件／AI 草稿）和「恢复历史版本」都**只改盘上那份正文**，不碰这一页的 CRDT 状态；
// 而编辑器打开页面时是「**有状态就载入**」（`crdt/pageBinding.ts`）——
// ⇒ 旧状态会在重开 / 重启时**赢回旧内容**，恢复 / 写入等于没落定。
// 修法：落库之后、界面重挂之前，用新正文把这一页的状态**整篇替换**一次
// （⛔ 有意代价：这一页原有血统丢了 —— owner 拍选项 a，台账 R155）。
//
// 机制（`stateFor` / `saveState` / `verify` / `report`）在 `crdt/seedExternalWrite.ts`；
// 字节怎么来在 `crdt/yDocBridge.ts` 的 `stateForExternalWrite`。
// **本文件只负责"谁在什么时候调它、怎么判成败"** —— ⛔ 别在别处再抄一份依赖实现。
//
// ## 两个入口
//
// | 入口 | 谁用 |
// |---|---|
// | `seedPageCrdtState(page)` | 外部写（`lib/applyDraftAndRefresh.ts`） |
// | `seedPageCrdtStateAfterRestore(page)` | 恢复历史版本（`components/HistoryPanel.tsx`） |
//
// ⚠️ **两条入口都播种、都不判平台**：桌面与 Web 都真实现了 `read_page_state` / `save_page_state`
// （Web 见 `platform/web.ts` 的 `readPageCrdtState` / `writePageCrdtState`），编辑器两侧都走
// 「有状态就载入」的同一条 `pageBinding.rs`/`pageBinding.ts` 语义 ⇒ 只给桌面播种会把 F1 原样留在 Web/PWA。
// 播种失败照旧返回 `failed`（盘上正文已写成功，不能把恢复流程带崩，也⛔ 不许说成完整成功）。
import { api } from "../api";
import { stateForExternalWrite } from "./yDocBridge";
import { seedExternalWriteState, type SeedExternalWriteDeps } from "./seedExternalWrite";
import type { PageDetail } from "../../types";

/** 播种结论 —— 调用方据此决定提示（⛔ 不许把 `failed` 说成成功）。 */
export type SeedPageStateOutcome =
  | { status: "seeded" }
  /** 播种真的失败了：盘上正文已换，但状态没换成 ⇒ 重启/重开可能回滚这一页。 */
  | { status: "failed"; error: string };

/** 依赖可注入（判据用）；生产一律走默认那份。 */
export interface SeedPageStateDeps extends Partial<SeedExternalWriteDeps> {}

/**
 * 唯一的依赖实现（从 `applyDraftAndRefresh` 的 `SEED_DEPS` 原样搬来，别改语义）。
 *
 * `stateFor` 收的是**整页**（只要 `id`；正文由 `stateForExternalWrite` 自己取）——
 * ⚠️ 调用方因此不必点存储字段名（点名字会触 `check-doc-content-access` 的新增计数）。
 */
const LIVE_DEPS: SeedExternalWriteDeps = {
  stateFor: (page) => stateForExternalWrite(page as PageDetail),
  saveState: (id, state) => api.savePageState(id, state),
  verify: async (id, state) => {
    const back = await api.readPageState(id);
    if (!back) return "read-null";
    if (back.length !== state.length) return `mismatch(len ${back.length}!=${state.length})`;
    let same = true;
    for (let i = 0; i < back.length; i++) {
      if (back[i] !== state[i]) { same = false; break; }
    }
    return same ? "match" : "mismatch(bytes)";
  },
  report: (line: string) => {
    // 诊断用：播种成败写进 mcp/apply.log（没有 devtools 的窗口也能查 R155 是否生效）
    try {
      void api.mcpLogApplyResult(line);
    } catch {
      // 诊断失败不影响落库
    }
  },
};

function mergeDeps(overrides: SeedPageStateDeps): SeedExternalWriteDeps {
  return {
    stateFor: overrides.stateFor ?? LIVE_DEPS.stateFor,
    saveState: overrides.saveState ?? LIVE_DEPS.saveState,
    verify: overrides.verify ?? LIVE_DEPS.verify,
    report: overrides.report ?? LIVE_DEPS.report,
  };
}

/**
 * 播种本体：把这一页的状态整篇替换成「当前盘上正文」那版。
 *
 * **不抛**：失败只带回 `status:"failed"` ＋ 留痕行（盘上正文已经写成功，不能把刷新流程带崩）。
 * 顺序的纪律由调用方守：**先落库 ⇒ 再播种 ⇒ 最后才 `bumpReload()` 让编辑器重挂**。
 */
export async function seedPageCrdtState(
  page: PageDetail,
  overrides: SeedPageStateDeps = {},
): Promise<SeedPageStateOutcome> {
  const deps = mergeDeps(overrides);
  // 抓住 `seedExternalWriteState` 那条失败留痕（它只返回 boolean ⇒ 详情在 report 行里）
  let lastReport = "";
  const ok = await seedExternalWriteState(page, {
    ...deps,
    report: (line: string) => {
      lastReport = line;
      deps.report?.(line);
    },
  });
  if (ok) return { status: "seeded" };
  return { status: "failed", error: lastReport || "状态写回失败（详见控制台）" };
}

/**
 * 「恢复历史版本」之后的播种 —— 与外部写走**同一个本体**。
 *
 * ⚠️ 不再按平台跳过：桌面与 Web 都实现了 `read_page_state` / `save_page_state`，
 * 而两侧编辑器都是「有状态就载入」⇒ 只给桌面播种＝把 F1 留在 Web/PWA（深度分析 §2 F1）。
 * 失败只带回 `status:"failed"`（恢复本身照常成功，但必须提示“重启可能回滚”）。
 */
export async function seedPageCrdtStateAfterRestore(
  page: PageDetail,
  overrides: SeedPageStateDeps = {},
): Promise<SeedPageStateOutcome> {
  return seedPageCrdtState(page, overrides);
}
