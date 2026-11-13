// 阶段 1 · **冲突提示条**：裁定 (iii) 的"不静默选边"要**看得见**。
//
// 数据来自本地表 `page_conflicts`（两个命令：`list_page_conflicts` / `resolve_page_conflict`）；
// 写入发生在本设备的**远端应用路径**（TS 侧 `applyRemoteContent`、Rust 侧 `apply_remote_page`）——
// 那两处遇到"同一块被两端改过"时**不再静默**：落表 + 这条提示。
//
// 刷新时机（**不做轮询**：冲突只在 pull 时才会出现）
//   ① 打开/切换页面；② **一次同步结束**（`useSyncStatus.syncing` 变回 false）；③ 自己裁决之后。
//
// 裁决按钮的两条语义（与 `docContent.resolvePageConflict` 一一对应）：
//   · **留本地** ⇒ 把本机那一版写回该块、盖新 rev、`dirty=1`（会被推上去）；
//   · **用远端** ⇒ 把远端那一版写回该块、同样盖新 rev 并推送。
//   两侧都**不删**对方：远端那一版仍在服务端历史里，本机那一版仍在版本历史里。

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../lib/api";
import { conflictSummary } from "../lib/conflictAdvice";
import { conflictRowAdvice, conflictShapeFromRow } from "../lib/conflictShape";
import { confirmDialog } from "../store/confirm";
import { useEditorStore } from "../store/editor";
import { useSyncStatus } from "../store/syncStatus";
import { toast } from "../store/toast";

type ConflictRow = Awaited<ReturnType<typeof api.listPageConflicts>>[number];

export function ConflictBanner({ pageId }: { pageId: string }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ConflictRow[]>([]);
  const syncing = useSyncStatus((s) => s.syncing);
  const setConflictBlockIds = useEditorStore((s) => s.setConflictBlockIds);

  const refresh = useCallback(() => {
    api
      .listPageConflicts(pageId)
      .then((next) => setRows(next))
      .catch(() => setRows([])); // 读不出来就不显示（不打扰用户），下一轮同步会再试
  }, [pageId]);

  // 什么时候读：① 挂载 / 换页（`refresh` 跟着 pageId 变）② 一次同步结束（`syncing` 变回 false）。
  // 只留这一个 effect：挂载时它本来就会跑一次 —— 再写一个"挂载时读"的 effect 等于**每次开页查两遍**。
  useEffect(() => {
    if (!syncing) refresh();
  }, [syncing, refresh]);

  // 把"哪几块有冲突"发布给编辑器（它据此画块级角标）；离开这一页时清空，别把角标留在别的页上。
  useEffect(() => {
    setConflictBlockIds(rows.map((row) => row.block_id));
  }, [rows, setConflictBlockIds]);
  useEffect(() => () => setConflictBlockIds([]), [setConflictBlockIds]);

  if (rows.length === 0) return null;

  const decide = async (row: ConflictRow, choice: "local" | "remote") => {
    try {
      await api.resolvePageConflict(row.id, choice);
      toast(t("conflicts.resolved"), "success");
      refresh();
    } catch (e) {
      toast(String(e), "error");
    }
  };

  /** 跳到那一块：与块引用跳转**同一条路**（`Editor` 会滚到它并闪一下）。 */
  const jumpTo = (row: ConflictRow) => {
    useEditorStore.getState().setFocusBlockId(row.block_id);
  };

  /**
   * ⭐ **U4 片 3（2026-11-13，owner 拍 D3=A）**：本页全部按同一策略处理（**仅一页内**）。
   * ⚠️ 必须先二次确认「将影响 N 块」；逐块调既有 `resolvePageConflict`（⛔ 不新造命令/同步路）。
   */
  const batchDecide = async (choice: "local" | "remote") => {
    const n = rows.length;
    if (!n) return;
    const ok = await confirmDialog({
      title: t("conflicts.batchTitle"),
      message: t("conflicts.batchMessage", { count: n }),
    });
    if (!ok) return;
    let done = 0;
    for (const row of rows) {
      try {
        await api.resolvePageConflict(row.id, choice);
        done += 1;
      } catch (e) {
        toast(String(e), "error");
        break;
      }
    }
    if (done > 0) toast(t("conflicts.batchDone", { count: done }), "success");
    refresh();
  };

  return (
    <div className="conflict-banner" role="status">
      <div className="conflict-banner-head">
        <span className="conflict-banner-title">{t("conflicts.title", { count: rows.length })}</span>
        <span className="conflict-banner-hint">{t("conflicts.hint")}</span>
      </div>
      {rows.length > 1 && (
        <div className="conflict-banner-batch" data-testid="conflict-batch">
          <button className="conflict-btn" data-testid="conflict-batch-local" onClick={() => void batchDecide("local")}>
            {t("conflicts.batchKeepLocal", { count: rows.length })}
          </button>
          <button className="conflict-btn" data-testid="conflict-batch-remote" onClick={() => void batchDecide("remote")}>
            {t("conflicts.batchUseRemote", { count: rows.length })}
          </button>
        </div>
      )}
      <ul className="conflict-banner-list">
        {rows.map((row) => {
          // ⭐ U4 片 2/3：差异＝**摘要 ＋ ≤40 字片段**（⛔ 不铺正文）；推荐与理由来自纯函数（唯一实现）。
          const summary = conflictSummary(conflictShapeFromRow(row));
          const advice = conflictRowAdvice(row);
          return (
            <li key={row.id} className="conflict-item">
              <div className="conflict-item-summary" data-testid="conflict-summary">
                {summary}
              </div>
              <div
                className={`conflict-item-advice${advice.choice === "ask" ? " is-tie" : ""}`}
                data-testid="conflict-advice"
              >
                {advice.choice === "ask" ? t("conflicts.tiePrefix") : t("conflicts.advicePrefix")}：
                {advice.reason}
              </div>
              <div className="conflict-item-actions">
                <button className="conflict-btn conflict-btn-locate" onClick={() => jumpTo(row)}>
                  {t("conflicts.locate")}
                </button>
                <button
                  className={`conflict-btn${advice.fuller === "local" ? " conflict-btn-primary" : ""}`}
                  onClick={() => void decide(row, "local")}
                >
                  {t("conflicts.keepLocal")}
                </button>
                <button
                  className={`conflict-btn${advice.fuller === "remote" ? " conflict-btn-primary" : ""}`}
                  onClick={() => void decide(row, "remote")}
                >
                  {t("conflicts.useRemote")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
