/**
 * 文件管理的**默认视图**策略。
 *
 * 为什么是"改默认值"而不是"改布局"：文件管理本来就有两个视图 —— `list`（表格，信息密度高）
 * 与 `grid`（卡片，缩略图优先），而卡片视图**本来就流动**
 * （`repeat(auto-fill, minmax(gridSize, 1fr))`，列数随宽度自动增减）。
 * 所以窄窗口下只要**默认给它**，就拿到了"每个宽度都有合适形态"的八成收益，
 * 而不必去做"把 `<table>` 变成卡片"那套双份渲染 + 双份判据（详见 2026-09-19 的利弊分析）。
 *
 * 三条纪律（每条都对应本仓踩过的坑）：
 *  1. **用户显式选过就永远听他的**：响应式不许覆盖偏好；
 *  2. **绝不把"自动决定"写回 `localStorage`**：否则一次窄窗口访问会把用户永久钉在卡片视图
 *     —— 与 `verify-mobile-layout.mjs` 头部记的"移动端自动收起污染桌面偏好"同一类事故；
 *  3. **只在进页面那一刻决定一次**，不监听宽度强制切换：用户手动切回表格后又被宽度抢回去，
 *     是最令人讨厌的那种"响应式"。
 *
 * 这里只放**纯函数**：组件负责喂它两个事实（存过的偏好、真实容器宽），判据只测这一层。
 */

/** 存视图偏好的 key（沿用既有的那份，别新建第二个）。 */
export const FM_VIEW_KEY = "shuyonote:fmView";

/** 视图模式：`list` = 表格，`grid` = 卡片。 */
export type FileViewMode = "list" | "grid";

/**
 * 表格能读的**下限宽度**：与 `src/App.css` 里 `.file-manager-table { min-width: … }` **同源**。
 * 低于它，表格只会横向滚动（或更糟：把列挤扁成「文/件」）⇒ 默认改用卡片视图。
 * `fileManagerView.test.ts` 有一条判据**读 App.css 逐字比对**，防止两边漂移。
 */
export const FM_TABLE_MIN_WIDTH = 780;

/** 读用户显式选择：只认这两个值；`null`、脏数据、旧值一律当成"没选过"。 */
export function readSavedFileView(saved: string | null | undefined): FileViewMode | null {
  return saved === "list" || saved === "grid" ? saved : null;
}

/**
 * 进页面那一刻决定默认视图。
 *
 * @param saved 存过的偏好（`localStorage.getItem(FM_VIEW_KEY)` 的原值）
 * @param containerWidth 文件管理容器的**真实**宽度（`rootRef.current.clientWidth`）
 * @returns 用户选过 ⇒ 照他的；没选过 ⇒ 宽（≥ {@link FM_TABLE_MIN_WIDTH}）用表格，窄用卡片。
 *          容器宽量不到（0 / 未挂载）时按"宽"处理 —— 表格是既有默认，别因为量不到就换形态。
 */
export function defaultFileView(saved: string | null | undefined, containerWidth: number): FileViewMode {
  const explicit = readSavedFileView(saved);
  if (explicit !== null) return explicit;
  return containerWidth > 0 && containerWidth < FM_TABLE_MIN_WIDTH ? "grid" : "list";
}
