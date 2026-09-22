// 阶段 1 · **正文索引的补算器**（B1，2026-09-22）：把"待重建"队列里的页面补上。
//
// 为什么需要它：合并产物与冲突裁决都是"内容拼出来的"，而正文列（与 FTS）仍是页级胜方那一份
// ⇒ 那一页**搜不到刚合并进来的字**，直到有人打开它。窗口 = 直到打开 ⇒ 只读浏览时可能永不关闭。
//
// 它做三件事（每件都短）：
//   ① 问队列（`api.listStaleTextPages`）：这一批哪几页待重建、**还有多少页**；
//   ② 对每一页用**唯一派生实现**（`contentText.ts` 的探测编辑器：同一套 Lexical 语义、不需要 DOM）算文本；
//   ③ 交给那一层写回（`api.refreshPageText` ⇒ `refreshPageTextIfStale`：不同才写、顺手刷索引、清标记）。
//
// ⚠️ **为什么驱动放在界面侧、而不是放进那一层或 `platform/web.ts`**：`contentText.ts` 拖着
// **整张节点表**，而 `docContent.ts` 会被 **node 侧** smoke 打进包（`scripts/smoke-web.mjs` 的 entryPoint
// 就是 `platform/web.ts`）⇒ 层里与 web.ts 里都不能引它（`docs/development.md` 记过这条坑）。
// 本文件只被浏览器包打进去，所以它是"引派生实现"的正确位置。
//
// ⚠️ 三条自我约束（照 B1 的拍板）：
//   ① **有预算**：一次最多补 `BUDGET` 页（默认 20），不许一次把整库拖进来；
//   ② **不在读路径上惰性重建**（macOS 的禁令）：只在"本轮同步结束 / 应用启动"这两个时机跑；
//   ③ **不并发**：同一时刻只跑一趟（`running` 闸），补算本身幂等。
//
// 判据：`TextRepairRunner.test.ts`（队列为空 ⇒ 一次都不调；按派生文本写回；预算用完就停并**说实话**）。

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../lib/api";
import { deriveContentText } from "../lib/contentText";
import { useSyncStatus } from "../store/syncStatus";
import { toast } from "../store/toast";

/** 一趟最多补几页（有预算：这是后台动作，不许把 UI 拖住）。 */
export const TEXT_REPAIR_BUDGET = 20;
/** 一趟里每批问队列要几页。 */
const BATCH = 5;

/** 一趟补算；返回 `{ repaired, remaining }`（判据直接调它，不必挂载组件）。 */
export async function runTextRepairPass(budget = TEXT_REPAIR_BUDGET): Promise<{ repaired: number; remaining: number }> {
  let repaired = 0;
  let remaining = 0;
  for (let asked = 0; asked < budget; asked += BATCH) {
    const q = await api.listStaleTextPages(Math.min(BATCH, budget - asked));
    if (q.pages.length === 0) {
      remaining = 0;
      break;
    }
    for (const p of q.pages) {
      // ② 唯一派生实现（与编辑器保存路径**同语义**）—— 这一层不在本文件里重写
      const derived = deriveContentText(p.doc_json);
      // ③ 交给那一层写回：不同才写、顺手刷索引、清"待重建"标记
      const fixed = await api.refreshPageText(p.page_id, derived);
      if (fixed) {
        repaired += 1;
        console.info(`[doc-content] 正文补算：page=${p.page_id}`);
      }
    }
    // 这一批已经清掉了标记 ⇒ 剩下的数 = 总数 - 已处理
    remaining = Math.max(0, q.total - q.pages.length);
    if (remaining === 0) break;
  }
  if (remaining > 0) {
    // 预算用完：**再问一次**拿准确数（界面要说"还有 N 页"，估个数不如问一句 —— 错报比不报更坏）
    try {
      remaining = (await api.listStaleTextPages(1)).total;
    } catch {
      /* 问不到就保留估值：结论（还有剩）不变 */
    }
  }
  return { repaired, remaining };
}

/** 挂在应用根上：应用启动一次、每次**同步结束**再一次（与冲突提示条同一套刷新时机）。 */
export function TextRepairRunner() {
  const { t } = useTranslation();
  const syncing = useSyncStatus((s) => s.syncing);
  const running = useRef(false);

  useEffect(() => {
    if (syncing) return;
    if (running.current) return;
    running.current = true;
    void runTextRepairPass()
      .then(({ repaired, remaining }) => {
        // ★ 可观测（B1 的价值就在这里）：**补不完要说实话**，不然用户只会觉得"有时候搜不到"。
        if (remaining > 0) toast(t("textRepair.pending", { count: remaining }), "info");
        else if (repaired > 0) console.info(`[doc-content] 正文补算完成：${repaired} 页`);
      })
      .catch(() => {
        /* 补算失败不打扰用户：下一次同步/启动会再试（标记还在，队列不会丢页面） */
      })
      .finally(() => {
        running.current = false;
      });
  }, [syncing, t]);

  return null;
}
