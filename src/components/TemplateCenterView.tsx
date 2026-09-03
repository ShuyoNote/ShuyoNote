import { useEffect, useMemo, useState } from "react";
import { $getSelection, $isRangeSelection } from "lexical";
import { platform } from "../lib/platform";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { useEditorStore } from "../store/editor";
import { useTemplateCenterStore } from "../store/templateCenter";
import { useTemplates } from "../store/templates";
import { toast } from "../store/toast";
import { TEMPLATES, TEMPLATE_CATEGORIES, substituteTemplateVars } from "../templates";
import { SearchIcon } from "./icons";

// M20.1 打磨：读编辑器当前选中文本，供 `{{selected}}` 模板变量在创建页面时填充。
// 编辑器可能在别的 view（模板中心浮层打开时编辑器仍挂着），故可安全读空。
function readEditorSelectionText(): string {
  const editor = useEditorStore.getState().editor;
  if (!editor) return "";
  let text = "";
  try {
    editor.getEditorState().read(() => {
      const sel = $getSelection();
      if ($isRangeSelection(sel)) text = sel.getTextContent();
    });
  } catch {
    text = "";
  }
  return text.trim();
}

type GalleryItem = {
  id: string;
  name: string;
  category: string;
  icon: string;
  cover: string;
  content_json: string;
  content_text: string;
  kind: "page" | "database";
  database_json: string;
  user: boolean;
};

// Deterministic mock "thumbnail" per template: a cover-gradient background with a
// mini white content card (page-screenshot look), until real thumbnails exist.
// 模板卡片中央内容快照：渲染模板真实正文(标题 + 前几行)，截断；无内容则伪线。
function MockPreview({ cover, content }: { cover: string; content?: string }) {
  const lines = (content ?? "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 6);
  const isHead = (i: number) => lines[i] && lines[i].length > 0 && !/[。：，;]$/.test(lines[i]) && lines[i].length < 18;
  return (
    <div className="tc-preview">
      <div className="tc-preview-cover" style={{ background: cover }} />
      <div className="tc-pv-card tc-pv-content">
        {lines.length === 0 ? (
          <>
            <div className="tc-pv-title" />
            <div className="tc-pv-line" style={{ width: "70%" }} />
            <div className="tc-pv-line" style={{ width: "52%" }} />
            <div className="tc-pv-line" style={{ width: "62%" }} />
          </>
        ) : (
          lines.slice(0, 5).map((l, i) => (
            <div key={i} className={`tc-pv-text${isHead(i) ? " tc-pv-head" : ""}`} title={l}>
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Template-center gallery: built-in templates (bundled) merged with the user's
// "我的模板" (persisted in DB). Clicking a card creates a page with content.
export function TemplateCenterView() {
  const setOpen = useTemplateCenterStore((s) => s.setOpen);
  const { createPage, createDatabase } = useNotes();
  const userTemplates = useTemplates((s) => s.userTemplates);
  const loadTemplates = useTemplates((s) => s.load);
  const removeTemplate = useTemplates((s) => s.remove);
  const [tab, setTab] = useState<string>(TEMPLATE_CATEGORIES[0]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const all: GalleryItem[] = useMemo(() => {
    const built = TEMPLATES.map((t): GalleryItem => ({
      id: t.id, name: t.name, category: t.category, icon: t.icon, cover: t.cover,
      content_json: t.content_json, content_text: t.content_text,
      kind: (t.kind ?? "page") as GalleryItem["kind"], database_json: t.database_json ?? "", user: false,
    }));
    const user = userTemplates.map((t): GalleryItem => ({
      id: t.id, name: t.name, category: t.category, icon: t.icon, cover: t.cover,
      content_json: t.content_json, content_text: t.content_text,
      kind: "page", database_json: "", user: true,
    }));
    return [...built, ...user];
  }, [userTemplates]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (t) =>
        (tab === TEMPLATE_CATEGORIES[0] || t.category === tab) &&
        (!q || t.name.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)),
    );
  }, [all, tab, query]);

  const today = () => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  };

  const useTemplate = async (t: GalleryItem) => {
    // Database template → create a database page and preset its columns.
    if (t.kind === "database" && t.database_json) {
      let config: any = null;
      try {
        config = JSON.parse(t.database_json);
      } catch {
        config = null;
      }
      const dbId = await createDatabase(null);
      if (dbId && config && Array.isArray(config.columns)) {
        for (const col of config.columns) {
          try {
            const attr = await api.createAttr({
              name: col.name,
              attr_type: col.type,
              options: col.options ?? [],
            });
            await api.addDbColumn(dbId, attr.id);
          } catch {
            /* skip a failed column */
          }
        }
      }
      setOpen(false);
      return;
    }
    // Page template → expand template vars (`{{date}}`/`{{title}}`/`{{selected}}`)
    // with the create-time context before seeding. `{{selected}}` reads the
    // editor's current selection (real selected text), if any.
    const selected = readEditorSelectionText();
    const vars = { date: today(), title: t.name, selected };
    const json = substituteTemplateVars(t.content_json, vars);
    const text = substituteTemplateVars(t.content_text, vars);
    const pid = await createPage(null, { content_json: json, content_text: text, title: t.name });
    // 把模板封面(题头图) + 页面图标应用到创建后的页面。
    if (pid && t.cover) await api.setPageCover(pid, t.cover);
    if (pid && t.icon) await api.setPageIcon(pid, t.icon);
    setOpen(false);
  };

  const exportTemplate = async (t: GalleryItem) => {
    try {
      const path = await platform.dialog.save({
        title: "导出模板",
        defaultPath: `${t.name}.shuyo-template.json`,
        filters: [{ name: "ShuyoNote 模板", extensions: ["json"] }],
      });
      if (!path) return;
      const payload = JSON.stringify({
        name: t.name, category: t.category, icon: t.icon, cover: t.cover,
        content_json: t.content_json, content_text: t.content_text,
      });
      await api.writeTextFile(path, payload);
    } catch (e) {
      console.error("export template failed", e);
    }
  };

  const importTemplate = async () => {
    try {
      const selected = await platform.dialog.open({ multiple: false, title: "导入模板" });
      if (!selected || Array.isArray(selected)) return;
      const text = await api.readTextFile(selected);
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed.content_json !== "string") {
        throw new Error("不是有效的模板文件");
      }
      await useTemplates.getState().saveAs({
        name: parsed.name ?? "导入的模板",
        category: parsed.category ?? "我的模板",
        content_json: parsed.content_json,
        content_text: parsed.content_text ?? "",
      });
    } catch (e) {
      toast(`导入模板失败：${e}`, "error");
    }
  };

  return (
    <div className="template-center">
      <div className="tc-head">
        <div className="tc-breadcrumb">
          <span className="tc-crumb">模板中心</span>
          <span className="tc-crumb-sep">/</span>
          <span className="tc-crumb-current">{tab}</span>
        </div>
        <div className="tc-search">
          <SearchIcon className="tc-search-icon" />
          <input
            className="tc-search-input"
            placeholder="搜索模板库…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="tc-import" title="导入模板文件" onClick={importTemplate}>
          ⬆ 导入
        </button>
        <button className="tc-close" title="关闭" onClick={() => setOpen(false)}>
          ×
        </button>
      </div>
      <div className="tc-tabs">
        {TEMPLATE_CATEGORIES.map((c) => (
          <button
            key={c}
            className={`tc-tab ${tab === c ? "tc-tab-active" : ""}`}
            onClick={() => setTab(c)}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="tc-grid">
        {filtered.length === 0 ? (
          <div className="tc-empty">
            {tab === "我的模板" ? "暂无我的模板 · 保存页面为模板后出现在这里" : "没有匹配的模板"}
          </div>
        ) : (
          filtered.map((t) => (
            <div key={t.id} className="tc-card" onClick={() => useTemplate(t)}>
              {t.user && (
                <div className="tc-card-actions">
                  <button className="tc-card-del" title="导出模板" onClick={(e) => { e.stopPropagation(); exportTemplate(t); }}>
                    ⬇
                  </button>
                  <button
                    className="tc-card-del"
                    title="删除模板"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTemplate(t.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              )}
              <MockPreview cover={t.cover} content={t.content_text} />
              <div className="tc-card-body">
                <span className="tc-card-name">{t.name}</span>
                <span className="tc-card-tag">
                  {t.user ? "我的模板" : "ShuyoNote · 模板"}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
