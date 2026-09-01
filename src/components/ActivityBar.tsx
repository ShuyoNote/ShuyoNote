import { useEffect } from "react";
import { useActivity, type Activity } from "../store/activity";
import { useViewStore } from "../store/view";
import { useEditorStore } from "../store/editor";
import { useTemplateCenterStore } from "../store/templateCenter";
import { TrashPanel } from "./TrashPanel";
import { SearchPanel } from "./SearchPanel";
import {
  PageIcon,
  FolderIcon,
  BoardIcon,
  GraphIcon,
  TemplateIcon,
  SettingsIcon,
  InfoIcon,
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
// 点击已选中的活动 = 收起/展开侧栏（VS Code 行为）。
const ITEMS: { id: Activity; label: string; icon: JSX.Element }[] = [
  { id: "notes", label: "笔记", icon: <PageIcon width={18} height={18} /> },
  { id: "files", label: "文件", icon: <FolderIcon width={18} height={18} /> },
  { id: "board", label: "看板", icon: <BoardIcon width={18} height={18} /> },
  { id: "graph", label: "关系图", icon: <GraphIcon width={18} height={18} /> },
];

export function ActivityBar() {
  const activity = useActivity((s) => s.activity);
  const sidebarOpen = useActivity((s) => s.sidebarOpen);
  const setActivity = useActivity((s) => s.setActivity);
  const toggleSidebar = useActivity((s) => s.toggleSidebar);
  const setSidebarOpen = useActivity((s) => s.setSidebarOpen);
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);
  const updateAvailable = useEditorStore((s) => s.updateAvailable);

  // 视图也能被命令面板/快捷键改（view.graph 等），竖条要跟着高亮，
  // 否则会出现「主区在看板、竖条还亮着笔记」的错位。
  useEffect(() => {
    if (view !== activity) setActivity(view as Activity);
  }, [view, activity, setActivity]);

  const pick = (id: Activity) => {
    if (id === activity) {
      toggleSidebar();
      return;
    }
    setActivity(id);
    setSidebarOpen(true);
    setView(id);
  };

  return (
    <nav className="activity-bar" aria-label="主导航">
      <div className="activity-group">
        {/* 搜索自带触发器（弹层），放在导航组顶部；它不改变侧栏内容，
            所以不是一个「活动」，不参与选中态。 */}
        <SearchPanel />
        {ITEMS.map((it) => {
          const on = activity === it.id;
          return (
            <button
              key={it.id}
              className={`activity-btn${on ? " is-on" : ""}`}
              title={on ? `${it.label}（点击${sidebarOpen ? "收起" : "展开"}侧栏）` : it.label}
              aria-label={it.label}
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
          onClick={() => useTemplateCenterStore.getState().setOpen(true)}
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
        <button
          className="activity-btn"
          title="关于"
          aria-label="关于"
          onClick={() => useEditorStore.getState().openAbout()}
        >
          <InfoIcon width={18} height={18} />
          {updateAvailable && <span className="activity-dot" title="有新版本可用" />}
        </button>
      </div>
    </nav>
  );
}
