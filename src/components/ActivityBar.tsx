import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useActivity, isActivity, type Activity } from "../store/activity";
import { isMobileViewport } from "../hooks/useMobile";
import { useViewStore } from "../store/view";
import { useEditorStore } from "../store/editor";
import { useFilePreview } from "../store/filePreview";
import { TrashPanel } from "./TrashPanel";
import { SearchPanel } from "./SearchPanel";
import {
  PageIcon,
  FolderIcon,
  BoardIcon,
  GraphIcon,
  TimelineIcon,
  TagIcon,
  TemplateIcon,
  SettingsIcon,
  SidebarIcon,
} from "./icons";

// 左侧竖条（activity bar）。
//
// 职责划分（改动前先读）：
//   - 竖条 = **全局导航与全局工具**（切换活动、打开全局对话框）
//   - 侧栏 = 当前活动的内容（页面树 / 搜索结果）
//   - 侧栏头部 = 与**当前空间**强相关的东西（空间切换、同步、新建）
//   - 右侧 RightRail = 与**当前文档**相关的辅助（AI、目录）
//
// 「搜索」只换侧栏面板、不动主区；notes/files/board/graph 会切主区视图。
// ⚠️ **2026-10-04 更新**：⭐ 活动图标**只切视图 ＋ 把侧栏展开** ✓ ——
//    ⭐ **不再**「点已选中的活动 ⇒ 收起侧栏」（~~VS Code 行为~~ ✗，owner 决定去掉 ✓）。
//    ⇒ 收起/展开侧栏**只由上面那颗 `.sidebar-toggle-btn` 负责** ✓（一个动作一个入口 ✓）。
//    ⚠️ 那句旧行为的注释与提示文案（title）当时**都留下了** ✗ ⇒ 已一并改掉 ✓。
const ITEMS: { id: Activity; labelKey: string; icon: JSX.Element }[] = [
  { id: "notes", labelKey: "nav.notes", icon: <PageIcon width={18} height={18} /> },
  { id: "files", labelKey: "nav.files", icon: <FolderIcon width={18} height={18} /> },
  { id: "board", labelKey: "nav.board", icon: <BoardIcon width={18} height={18} /> },
  { id: "graph", labelKey: "nav.graph", icon: <GraphIcon width={18} height={18} /> },
  { id: "timeline", labelKey: "nav.timeline", icon: <TimelineIcon width={18} height={18} /> },
  // S4：知识地图（按标签聚类；数据来自 `get_graph` 那**同一条**既有出处 ✓）
  { id: "map", labelKey: "nav.map", icon: <TagIcon width={18} height={18} /> },
];

export function ActivityBar() {
  const { t } = useTranslation();
  const activity = useActivity((s) => s.activity);
  const sidebarOpen = useActivity((s) => s.sidebarOpen);
  const railOpen = useActivity((s) => s.railOpen);
  const setActivity = useActivity((s) => s.setActivity);
  const toggleSidebar = useActivity((s) => s.toggleSidebar);
  const setSidebarOpen = useActivity((s) => s.setSidebarOpen);
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);
  // ⚠️ 2026-10-01：`updateAvailable` 那个选择器随**竖条上的「关于」按钮**一起去掉了 ✓ ——
  //   它当时只服务那颗"有新版本可用"的小红点 ✗；更新提示仍在**更新横幅**（`UpdateBanner` ✓）
  //   与**设置 → 关于与更新**里 ✓（两个入口都在 ✓），所以不是把提示删掉了 ✓。

  // 视图也能被命令面板/快捷键改（view.graph 等），竖条要跟着高亮，
  // 否则会出现「主区在看板、竖条还亮着笔记」的错位。
  // ⚠️ **2026-10-04 修**：⭐ 必须先用 `isActivity(view)` **收窄**再写 ✗ ——
  //    原先写的是 `setActivity(view as Activity)` ✓，⭐ 而 `AppView` **比 `Activity` 宽** ✗
  //    （还有 settings / trash / templates / search 这类**非活动**视图 ✓）
  //    ⇒ ⭐ `as` 把类型检查绕过去了 ⇒ ⭐ 打开设置/回收站时会把**非法值**写进 `activity` ✓
  //      ⇒ ⭐ 那 6 个活动图标**一个都不会高亮** ✓（⭐ 因为没人等于 "settings" 这种值 ✓）。
  useEffect(() => {
    if (view !== activity && isActivity(view)) setActivity(view);
  }, [view, activity, setActivity]);

  const pick = (id: Activity) => {
    // ⚠️⚠️ **2026-10-04 改**（owner 决定）：⭐ **点活动图标不再收起侧栏** ✗。
    //    原先这里是 VS Code 那套 —— `if (id === activity) { toggleSidebar(); return; }` ✓：
    //    ⭐ 点亮的那个再点一下 ⇒ 收起 ✓。⚠️ 但副作用是 ⭐ **每一个图标都"能收起侧栏"** ✗
    //    （⭐ 因为点完它就变亮的那个 ✓ ⇒ 再点一下就收起 ✓）⇒ 用户体验上分不清
    //    "切换视图" 与 "收起侧栏" 两件事 ✗；owner 实测后要求改成：
    //    ⭐ **活动图标只负责切视图 ＋ 把侧栏展开** ✓；⭐ **收起侧栏只由上面那颗专职的
    //    `.sidebar-toggle-btn` 负责** ✓（⭐ 一个动作一个入口 ✓）。
    //    ⚠️ 窄屏的行为**不变**：⭐ 下面那句 `if (!isMobileViewport()) setSidebarOpen(true)` 照旧 ✓
    //    （⭐ 窄屏侧栏是盖住内容的整高抽屉 ⇒ 点图标时**不能**顺手拉开 ✓ 见它的注释 ✓）。
    // 切换视图（看板/关系图等）时关闭文件预览，避免残留遮住新视图。
    // ⚠️ 只在**真的换活动**时关：⭐ 点当前那个（只是想展开侧栏）不该把预览关掉 ✗。
    if (id !== activity) useFilePreview.getState().close();
    setActivity(id);
    // ⚠️ 窄屏**不要**顺手把侧栏拉开：桌面上侧栏是并排的一列（拉开正好一起看），
    // 但窄屏它是**盖住内容的整高抽屉**——点「看板」之后看到的是侧栏抽屉，
    // 刚切过去的视图还在它后面，用户得再点一次遮罩才看得见（等于"点了没反应"）。
    // 窄屏想开抽屉有专门的入口（`.sidebar-toggle-btn` / 竖条里那个按钮）。
    if (!isMobileViewport()) setSidebarOpen(true);
    setView(id);
  };

  return (
    <nav
      className={`activity-bar${railOpen ? " is-open" : ""}`}
      aria-label="主导航"
      onClick={() => {
        // 窄屏竖条是浮层：在里面点任何东西（活动 / 搜索 / 回收站 / 模板 / 设置 /
        // 关于）都顺手把它收起来，免得面板都弹出来了、竖条还盖在旁边。
        // 桌面端竖条常驻，不做处理。
        if (isMobileViewport()) useActivity.getState().setRailOpen(false);
      }}
    >
      <div className="activity-group">
        {/* ⚠️ **2026-10-04 更新**：⭐ 这是**侧栏开合的唯一入口** ✓ ——
            桌面与窄屏都是它（⭐ 活动图标只切视图、不再收起侧栏 ✓ 见上面 `pick` 与 `ITEMS` 的注释 ✓）。
            ⚠️ 原先这段写的是「桌面端点活动图标就能开合…触屏没有 hover ⇒ 所以小屏给一个」✗ ——
            ⭐ 那个理由已经**不成立**了 ✓；保留这颗按钮仍有理由：⭐ 触屏**没有 hover** ✓
            （「图标可以点」这件事在小屏依旧完全不可见 ✓），而且它是唯一入口 ✓。 */}
        <button
          className="activity-btn sidebar-toggle-btn"
          title={sidebarOpen ? t("common.collapseSidebar") : t("common.expandSidebar")}
          aria-label={sidebarOpen ? t("common.collapseSidebar") : t("common.expandSidebar")}
          aria-expanded={sidebarOpen}
          onClick={() => toggleSidebar()}
        >
          <SidebarIcon width={18} height={18} />
        </button>
        {/* 搜索自带触发器（弹层），放在导航组顶部；它不改变侧栏内容，
            所以不是一个「活动」，不参与选中态。 */}
        <SearchPanel />
        {ITEMS.map((it) => {
          const on = activity === it.id;
          return (
            <button
              key={it.id}
              className={`activity-btn${on ? " is-on" : ""}`}
              title={t(it.labelKey)}
              aria-label={t(it.labelKey)}
              aria-current={on}
              onClick={() => pick(it.id)}
            >
              {it.icon}
            </button>
          );
        })}
      </div>

      <div className="activity-group activity-group-end">
        {/* 回收站是「看已删除的内容」——本质是导航，不是设置，所以归竖条；
            备份与存储清理是低频且不可逆的全局操作，已归设置中心「数据」页。 */}
        <TrashPanel />
        <button
          className="activity-btn"
          title="模板中心"
          aria-label="模板中心"
          onClick={() => useViewStore.getState().setView("templates")}
        >
          <TemplateIcon width={18} height={18} />
        </button>
        <button
          className="activity-btn"
          title="设置"
          aria-label="设置"
          onClick={() => useEditorStore.getState().openSettings()}
        >
          <SettingsIcon width={18} height={18} />
        </button>
      </div>
    </nav>
  );
}
