// ⭐ P3-3a 第二小步（task-52）：把 CRDT 影子比对接**真实空间**（当前活动空间），只回 id/计数。
//
// 边界（与 ADR §3.2 一致）：
// · 必须在 WebView/vitest 里跑（投影要拉编辑器节点表；Node 侧会炸）—— 本文件只被前端/dev hook 用；
// · **只读**：`listWorkspacePages` → 每页 `getPage`（取落盘正文）＋ `readPageState`；不写库、不发命令；
// · **不中断**：任何一页读失败只算 `uncomparable`（⛔ 不让一张坏页把整轮扫描按死）；
// · **脱敏**：返回只有计数与 `differPageIds`（⛔ 正文一个字节都不带）。
import { api } from "./api";
import { jsonTextOf } from "./docContent";
import {
  shadowCompareProjection,
  type ShadowRowsResult,
} from "./crdtShadow";

/** 注入点（判据用假 api；生产用默认实现）。 */
export interface ShadowScanApi {
  listWorkspacePages: (spaceId: string) => Promise<Array<{ id: string }>>;
  getPage: (id: string) => Promise<unknown>;
  readPageState: (id: string) => Promise<Uint8Array | null>;
  /**
   * ⭐ 2026-11-11（P0-1b）：读该页**待合并的远端状态**（只用来给差异分类：有 ⇒ 已知噪声）。
   * 不注入 ⇒ 差异一律算 `differUnexplained`（保守方向 ✓）。
   */
  readPendingStates?: (id: string) => Promise<unknown[]>;
}

export const defaultShadowScanApi: ShadowScanApi = {
  listWorkspacePages: (spaceId) => api.listWorkspacePages(spaceId),
  getPage: (id) => api.getPage(id),
  readPageState: (id) => api.readPageState(id),
  readPendingStates: (id) => api.readPendingPageStates(id),
};

export function emptyShadowRows(): ShadowRowsResult {
  return {
    total: 0,
    withState: 0,
    equal: 0,
    differ: 0,
    uncomparable: 0,
    differPageIds: [],
    differPending: 0,
    differUnexplained: 0,
  };
}

/**
 * 扫一个空间：逐页比较**落盘正文** vs 该页 CRDT 状态投影，返回汇总（只计数/差异页 id）。
 *
 * 失败口径：
 * · 页面列表都读不到 ⇒ 空汇总（⛔ 不抛；调用方是 dev 看门，不该让应用崩）；
 * · 单页 `getPage`/`readPageState` 抛错 / 页 id 缺失 ⇒ `uncomparable++` 继续下一页；
 * · 无状态/空字节 ⇒ `uncomparable`（与 `crdtShadow` 同一口径，⛔ 不算 differ）。
 */
export async function shadowScanSpace(
  spaceId: string,
  deps: ShadowScanApi = defaultShadowScanApi,
): Promise<ShadowRowsResult> {
  const out = emptyShadowRows();
  if (!spaceId.trim()) return out;
  let pages: Array<{ id: string }>;
  try {
    pages = await deps.listWorkspacePages(spaceId);
  } catch {
    return out;
  }
  for (const page of pages) {
    out.total += 1;
    const id = typeof page?.id === "string" ? page.id.trim() : "";
    if (!id) {
      out.uncomparable += 1;
      continue;
    }
    let storedJson: string;
    let state: Uint8Array | null;
    try {
      const detail = await deps.getPage(id);
      // ⚠️ 不在这里写存储列字面量（门禁按字面量计）：用那一层函数的入参类型即可。
      storedJson = jsonTextOf(detail as Parameters<typeof jsonTextOf>[0]);
      state = await deps.readPageState(id);
    } catch {
      out.uncomparable += 1;
      continue;
    }
    if (!state || state.length === 0) {
      out.uncomparable += 1;
      continue;
    }
    out.withState += 1;
    const cmp = shadowCompareProjection(storedJson, state);
    if (cmp.equal) {
      out.equal += 1;
    } else if (cmp.reason === "differ") {
      out.differ += 1;
      out.differPageIds.push(id);
      // ⭐ 2026-11-11（P0-1b）：差异分类 —— 该页有**待合并的远端状态** ⇒ 已知噪声；
      //   否则落 `differUnexplained`（待查；读不到也按“待查”算，保守方向 ✓）。
      let pendingCount = 0;
      if (deps.readPendingStates) {
        try {
          pendingCount = (await deps.readPendingStates(id)).length;
        } catch {
          pendingCount = 0;
        }
      }
      if (pendingCount > 0) out.differPending = (out.differPending ?? 0) + 1;
      else out.differUnexplained = (out.differUnexplained ?? 0) + 1;
    } else {
      out.uncomparable += 1;
    }
  }
  return out;
}
