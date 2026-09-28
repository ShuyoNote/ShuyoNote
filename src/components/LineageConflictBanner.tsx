// 冲刺 §13.3 第 2 条 · **页级血统冲突**的提示条（2026-09-23 第 49 轮）。
//
// 与块级那条 `ConflictBanner` **并列但不同族**，别把它俩合成一个：
//   · 块级：**同一块**被判成两版 ⇒ 可以逐块选一侧（另一侧仍在版本历史里）；
//   · 页级：撞上的是**两条独立创建的血统** —— Yjs 结构上就不是同一棵树，**合并在数学上做不到**
//     （S1 红线：硬合 ⇒ 顶层块变成两份、`blockId` 重复）⇒ 真实选项只有三条：
//     **① 留本机 ② 用对端 ③ 两个都要（一页变两页）**，而**只有 ③ 不丢数据**。
//
// 所以这条横幅只给两个按钮：**「另存为新页」**（＝③ 的第一步，把对端那一版落成一个真页面）
// 与**「保留本机」**（＝① 的显式确认：我知道了，别管它）。②"用对端"（本机这版让位）还没做 ——
// 它要动本机血统的取舍，见 [方案稿](../../docs/plans/2026-09-23-lineage-conflict-adjudication.md) §4。
//
// 刷新时机与 `ConflictBanner` **同两处**：① 挂载/换页（`refresh` 跟着 `pageId` 变）；
// ② 一次同步结束（`syncing` 变回 false）——**不做轮询**（页级冲突只在打开页面/拉取时才可能出现）。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../lib/api";
import { deriveContentText } from "../lib/contentText";
import { pageCreationArgsFromDocJson } from "../lib/docContent";
import { useSyncStatus } from "../store/syncStatus";
import { toast } from "../store/toast";

type LineageRow = NonNullable<Awaited<ReturnType<typeof api.listLineageConflicts>>>;

/** 救回来的新页标题后缀（**不自动合并标题**：让用户一眼看出它是"另一条编辑历史"那一份）。 */
const RESCUED_TITLE_SUFFIX_ZH = "（另一条编辑历史）";

export function LineageConflictBanner({ pageId }: { pageId: string }) {
  const { t } = useTranslation();
  const [row, setRow] = useState<LineageRow | null>(null);
  const syncing = useSyncStatus((s) => s.syncing);

  const refresh = useCallback(() => {
    api
      .listLineageConflicts(pageId)
      .then((next) => setRow(next))
      .catch(() => setRow(null)); // 读不出来就不显示（不打扰用户），下一轮同步会再试
  }, [pageId]);

  useEffect(() => {
    if (!syncing) refresh();
  }, [syncing, refresh]);

  if (!row) return null;

  /** ★ ③「两个都要」：把**对端那一版**落成一个新页 ⇒ 谁都不丢。裁决记 `saved-as-new`。 */
  const saveAsNew = async () => {
    try {
      const page = (await api.getPage(pageId)) as { title?: unknown } | null;
      const base = typeof page?.title === "string" && page.title ? page.title : "未命名";
      // 正文文本按**编辑器语义**派生（与保存路径同一个实现）⇒ 新页一建出来就能被搜索/反链看到。
      const json = row.remote_doc;
      // ⚠️ 落库形状由**文档内容层**组装（那一层的注释写了理由：存储列名只许出现在那一层，
      //    这个界面文件一旦自己拼出来，`check-doc-content-access` 会当场红）。
      await api.createPage(pageCreationArgsFromDocJson(`${base}${RESCUED_TITLE_SUFFIX_ZH}`, json, deriveContentText(json)));
      await api.resolveLineageConflict(row.id, "saved-as-new");
      toast(t("lineage.rescued"), "success");
      refresh();
    } catch (e) {
      toast(String(e), "error");
    }
  };

  /** ①「保留本机」：本页不动，只是**别再打扰我**（裁决记 `local`）。 */
  const keepLocal = async () => {
    try {
      await api.resolveLineageConflict(row.id, "local");
      refresh();
    } catch (e) {
      toast(String(e), "error");
    }
  };

  return (
    <div className="conflict-banner conflict-banner-lineage" role="status">
      <div className="conflict-banner-head">
        <span className="conflict-banner-title">{t("lineage.title")}</span>
        <span className="conflict-banner-hint">{t("lineage.hint")}</span>
      </div>
      <div className="conflict-item-actions">
        <button className="conflict-btn" onClick={() => void keepLocal()}>
          {t("lineage.keepLocal")}
        </button>
        <button className="conflict-btn conflict-btn-primary" onClick={() => void saveAsNew()}>
          {t("lineage.savedAsNew")}
        </button>
      </div>
    </div>
  );
}
