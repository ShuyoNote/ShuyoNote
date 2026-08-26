import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { platform } from "../../lib/platform";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createHeadingNode, $createQuoteNode } from "@lexical/rich-text";
import { $createLinkNode } from "@lexical/link";
import { $createCodeHighlightNode, $createCodeNode } from "@lexical/code";
import {
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
} from "@lexical/list";
import { $createHorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { INSERT_TABLE_COMMAND } from "@lexical/table";
import { api } from "../../lib/api";
import { toast } from "../../store/toast";
import { useBlockSelector } from "../../store/blockSelector";
import { $getInsertTargetBlock } from "../blockUtils";
import { useAttachmentsStore } from "../../store/attachments";
import { inputDialog } from "../../store/input";
import { $createCalloutNode } from "../nodes/CalloutNode";
import { $createColumnsBlockNode, EMPTY_COLUMN_JSON } from "../nodes/ColumnsBlockNode";
import { $createImageNode } from "../nodes/ImageNode";
import { $createDrawingNode } from "../nodes/DrawingNode";
import { $createVideoNode } from "../nodes/VideoNode";
import { $createAttachmentRefNode } from "../nodes/AttachmentRefNode";
import { $createWebBookmarkNode } from "../nodes/WebBookmarkNode";
import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  KEY_DOWN_COMMAND,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";

export type SlashRun = (editor: LexicalEditor) => void | Promise<void>;

export interface SlashOption {
  key: string;
  title: string;
  badge: string;
  group: string;
  run: SlashRun;
  shortcut?: string;
  pinyin?: string;
}

// Replace the current block (scoped to its column if inside one) with a new
// element, moving children over.
function $replaceBlock(newNode: ElementNode) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const anchor = selection.anchor.getNode();
  const target = $getInsertTargetBlock(anchor);
  if (!target || !$isElementNode(target)) return;
  const children = target.getChildren();
  for (const child of children) {
    newNode.append(child);
  }
  target.replace(newNode);
  newNode.selectStart();
}

// Replace the current block (scoped to its column if inside one) with a decorator
// (image/video), then insert an empty paragraph after it and move the caret there.
function $insertBlockNode(node: LexicalNode) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const anchor = selection.anchor.getNode();
  const target = $getInsertTargetBlock(anchor);
  if (!target) return;
  target.replace(node);
  // Always leave a valid selection on a fresh paragraph after the inserted block,
  // even if the parent lookup fails — never leave the caret pointing at a removed node.
  const paragraph = $createParagraphNode();
  if (node.getParent()) {
    node.insertAfter(paragraph);
  }
  paragraph.selectStart();
}

export function makeOptions(pageId: string): SlashOption[] {
  return [
    { key: "h1", title: "标题 1", badge: "H1", group: "基础", shortcut: "Ctrl+Alt+1", pinyin: "h1", run: (editor) =>
      editor.update(() => $replaceBlock($createHeadingNode("h1"))) },
    { key: "h2", title: "标题 2", badge: "H2", group: "基础", shortcut: "Ctrl+Alt+2", pinyin: "h2", run: (editor) =>
      editor.update(() => $replaceBlock($createHeadingNode("h2"))) },
    { key: "h3", title: "标题 3", badge: "H3", group: "基础", shortcut: "Ctrl+Alt+3", pinyin: "h3", run: (editor) =>
      editor.update(() => $replaceBlock($createHeadingNode("h3"))) },
    { key: "p", title: "正文", badge: "¶", group: "基础", pinyin: "zw", run: (editor) =>
      editor.update(() => $replaceBlock($createParagraphNode())) },
    { key: "quote", title: "引用", badge: "❝", group: "基础", shortcut: "Ctrl+Alt+Q", pinyin: "yy", run: (editor) =>
      editor.update(() => $replaceBlock($createQuoteNode())) },
    { key: "link", title: "链接", badge: "🔗", group: "基础", shortcut: "Ctrl+Alt+L", pinyin: "lj", run: (editor) =>
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const anchor = selection.anchor.getNode();
        const topLevel = $getInsertTargetBlock(anchor);
        if (!topLevel) return;
        const text = topLevel.getTextContent() || "链接";
        const linkNode = $createLinkNode("https://").append($createTextNode(text));
        const paragraph = $createParagraphNode();
        paragraph.append(linkNode);
        topLevel.replace(paragraph);
        linkNode.selectStart();
      }) },
    { key: "todo", title: "待办事项", badge: "☑", group: "列表", shortcut: "Ctrl+Alt+T", pinyin: "dblb", run: (editor) => {
      editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined); } },
    { key: "ul", title: "无序列表", badge: "•", group: "列表", shortcut: "Ctrl+Alt+U", pinyin: "wxlb", run: (editor) => {
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined); } },
    { key: "ol", title: "有序列表", badge: "1.", group: "列表", shortcut: "Ctrl+Alt+O", pinyin: "yxlb", run: (editor) => {
      editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined); } },
    { key: "image", title: "图片", badge: "🖼", group: "媒体", pinyin: "tp", run: async (editor) => {
      const selected = await platform.dialog.open({
        title: "选择图片",
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
        multiple: false,
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected as string];
      try {
        const metas = await api.importAttachmentFiles(pageId, paths);
        if (metas.length === 0) return;
        const src = platform.asset.convertFileSrc(metas[0].path);
        editor.update(() => $insertBlockNode($createImageNode(src, "", false, null, null, metas[0].hash, metas[0].mime)));
      } catch (e) {
        toast(`插入图片失败：${e}`, "error");
      }
    } },
    { key: "drawing", title: "绘图", badge: "✏️", group: "媒体", pinyin: "ht", run: (editor) => {
      editor.update(() => {
        $insertBlockNode($createDrawingNode());
      });
    } },
    { key: "video", title: "视频", badge: "🎬", group: "媒体", pinyin: "sp", run: async (editor) => {
      const selected = await platform.dialog.open({
        title: "选择视频",
        filters: [{ name: "视频", extensions: ["mp4", "webm", "mov", "m4v"] }],
        multiple: false,
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected as string];
      try {
        const metas = await api.importAttachmentFiles(pageId, paths);
        if (metas.length === 0) return;
        const src = platform.asset.convertFileSrc(metas[0].path);
        editor.update(() => $insertBlockNode($createVideoNode(src, metas[0].hash, metas[0].mime)));
      } catch (e) {
        toast(`插入视频失败：${e}`, "error");
      }
    } },
    { key: "attachment", title: "附件", badge: "📎", group: "媒体", pinyin: "fj", run: async (editor) => {
      const selected = await platform.dialog.open({
        title: "选择文件",
        multiple: true,
      });
      const paths = Array.isArray(selected) ? selected : selected ? [selected as string] : [];
      if (paths.length === 0) return;
      try {
        const metas = await api.importAttachmentFiles(pageId, paths);
        useAttachmentsStore.getState().bump();
        toast(`已添加 ${metas.length} 个附件`, "success");
        editor.focus();
      } catch (e) {
        toast(`添加附件失败：${e}`, "error");
      }
    } },
    { key: "fileref", title: "文件引用", badge: "▤", group: "媒体", pinyin: "wjyy", run: async (editor) => {
      const selected = await platform.dialog.open({
        title: "选择要引用的文件",
        multiple: true,
      });
      const paths = Array.isArray(selected) ? selected : selected ? [selected as string] : [];
      if (paths.length === 0) return;
      try {
        const metas = await api.importAttachmentFiles(pageId, paths);
        useAttachmentsStore.getState().bump();
        editor.update(() => {
          for (const m of metas) {
            $insertBlockNode($createAttachmentRefNode(m.id, m.name, m.size, m.mime, m.hash, m.path));
          }
        });
        toast(`已插入 ${metas.length} 个文件引用`, "success");
      } catch (e) {
        toast(`插入文件引用失败：${e}`, "error");
      }
    } },
    { key: "webbookmark", title: "网址书签", badge: "🔗", group: "媒体", pinyin: "wzsq", run: (editor) => {
      inputDialog({
        title: "网址书签",
        placeholder: "输入网址（URL），如 https://example.com/article",
        okLabel: "插入",
        onSubmit: (raw) => {
          let u = raw.trim();
          if (!u) return;
          if (!u.includes("://")) u = `https://${u}`;
          editor.update(() => {
            // Reuse the proven block-insert path: replace the current (which holds
            // the "/wzsq" text) with the bookmark, then insert a fresh paragraph
            // and move the caret there — the same reliable path as image/video inserts.
            $insertBlockNode($createWebBookmarkNode(u));
          });
        },
      });
    } },
    { key: "callout", title: "Callout 提示框", badge: "💡", group: "嵌入", pinyin: "ctsx", run: (editor) =>
      editor.update(() => $replaceBlock($createCalloutNode())) },    { key: "columns", title: "分栏", badge: "▥", group: "嵌入", pinyin: "fl", run: (editor) =>
      editor.update(() => $insertBlockNode($createColumnsBlockNode([EMPTY_COLUMN_JSON, EMPTY_COLUMN_JSON]))) },    { key: "code", title: "代码块", badge: "{}", group: "嵌入", shortcut: "Ctrl+Alt+C", pinyin: "dmk", run: (editor) =>
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const anchor = selection.anchor.getNode();
        const topLevel = $getInsertTargetBlock(anchor);
        if (!topLevel) return;
        const codeNode = $createCodeNode("javascript");
        codeNode.append($createCodeHighlightNode(topLevel.getTextContent()));
        topLevel.replace(codeNode);
        codeNode.selectStart();
      }) },
    { key: "hr", title: "分隔线", badge: "—", group: "嵌入", shortcut: "Ctrl+Alt+M", pinyin: "fgx", run: (editor) => {
      // Replace the current block in place with the divider, then drop a fresh
      // paragraph below it (same behavior as the Ctrl+Alt+M shortcut) — no leftover/extra block.
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const topLevel = $getInsertTargetBlock(selection.anchor.getNode());
        if (!topLevel) return;
        const hr = $createHorizontalRuleNode();
        topLevel.replace(hr);
        const paragraph = $createParagraphNode();
        hr.insertAfter(paragraph);
        paragraph.select();
      }); } },
    { key: "table", title: "表格", badge: "▦", group: "嵌入", pinyin: "bg", run: (editor) => {
      editor.dispatchCommand(INSERT_TABLE_COMMAND, {
        columns: "3",
        rows: "3",
        includeHeaders: { rows: true, columns: false },
      }); } },
    { key: "blockref", title: "引用块", badge: "⛓", group: "引用", pinyin: "yyk", run: () => {
      useBlockSelector.getState().openSelector("ref"); } },
    { key: "blockembed", title: "嵌入块", badge: "🧩", group: "引用", pinyin: "qrk", run: () => {
      useBlockSelector.getState().openSelector("embed"); } },
  ];
}

// Clamp the slash menu position within the viewport. The menu can be up to
// MENU_MAX_H tall; if it wouldn't fit below the caret, flip it above; then clamp
// so the measured height never overflows the bottom or top edges.
const MENU_MAX_H = 340;
const MENU_W = 240;
function computeMenuPos(rect: DOMRect, menuHeight: number = MENU_MAX_H): { top: number; left: number } {
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - MENU_W - 8));
  let top = rect.bottom + 4;
  if (top + menuHeight > window.innerHeight - 8) {
    // Not enough room below → open above the caret.
    top = rect.top - menuHeight - 8;
  }
  // Final clamp so the menu always fits (handles both below & above cases).
  top = Math.max(8, Math.min(top, window.innerHeight - menuHeight - 8));
  return { top, left };
}

export function SlashMenuPlugin({ pageId }: { pageId: string }) {
  const [editor] = useLexicalComposerContext();
  const options = useMemo(() => makeOptions(pageId), [pageId]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [sel, setSel] = useState(0);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? options.filter(
          (o) =>
            o.title.toLowerCase().includes(q) ||
            (o.pinyin && o.pinyin.includes(q)) ||
            (o.key && o.key.toLowerCase().includes(q)),
        )
      : options;
  }, [options, query]);

  const stateRef = useRef({ filtered, sel, editor });
  stateRef.current = { filtered, sel, editor };

  // Re-clamp once the menu is rendered, using its true measured height, so a
  // short menu doesn't over-flip above nor a tall one overflow the bottom.
  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    const h = menuRef.current.offsetHeight;
    if (h <= 0) return;
    setPos((p) => ({ ...p, top: Math.max(8, Math.min(p.top, window.innerHeight - h - 8)) }));
  }, [open, filtered.length]);

  // ↑/↓ navigation: keep the active item in view by scrolling only the menu
  // container (not ancestor pages).
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const menu = menuRef.current;
    const active = menu.querySelector(".slash-item-active") as HTMLElement | null;
    if (!active) return;
    const m = menu.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    if (a.top < m.top + 8) menu.scrollTop += a.top - (m.top + 8);
    else if (a.bottom > m.bottom - 8) menu.scrollTop += a.bottom - (m.bottom - 8);
  }, [sel, open, filtered.length]);

  const select = useCallback(
    (option: SlashOption) => {
      setOpen(false);
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
        const anchor = selection.anchor;
        const node = anchor.getNode();
        if ($isTextNode(node)) {
          const full = node.getTextContent();
          const before = full.slice(0, anchor.offset);
          // Trigger only on a "/" at start-of-text or after whitespace, so URLs
          // like http://... (the "/" follows ":") never open the menu.
          const match = before.match(/(^|\s)(\/[^\s/]*)$/);
          if (match && match.index !== undefined) {
            const slash = match.index + match[1].length;
            node.spliceText(slash, anchor.offset - slash, "");
          }
        }
      });
      option.run(editor);
    },
    [editor],
  );
  const selectRef = useRef(select);
  selectRef.current = select;

  // Detect trigger + query + position.
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          setOpen(false);
          return;
        }
        const node = selection.anchor.getNode();
        if (!$isTextNode(node)) {
          setOpen(false);
          return;
        }
        const before = node.getTextContent().slice(0, selection.anchor.offset);
        // Only trigger on a "/" at start-of-text or after whitespace, so URLs
        // like http://... never open the menu mid-typing.
        const match = before.match(/(^|\s)(\/[^\s/]*)$/);
        if (!match) {
          setOpen(false);
          return;
        }
        setQuery(match[2].slice(1) || "");
        setSel(0);
        const dom = editor.getElementByKey(node.getKey());
        if (dom) {
          const rect = dom.getBoundingClientRect();
          setPos(computeMenuPos(rect));
        }
        setOpen(true);
      });
    });
  }, [editor]);

  // Keyboard navigation.
  useEffect(() => {
    if (!open) return;
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (e: KeyboardEvent) => {
        const { filtered: f, sel: s } = stateRef.current;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSel((v) => Math.min(v + 1, f.length - 1));
          return true;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSel((v) => Math.max(v - 1, 0));
          return true;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const o = f[s];
          if (o) selectRef.current(o);
          return true;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setOpen(false);
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [open, editor]);

  // Reposition on scroll instead of closing.
  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      const ed = stateRef.current.editor;
      ed.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const node = selection.anchor.getNode();
        const dom = ed.getElementByKey(node.getKey());
        if (dom) {
          const rect = dom.getBoundingClientRect();
          setPos(computeMenuPos(rect));
        }
      });
    };
    document.addEventListener("scroll", reposition, true);
    return () => document.removeEventListener("scroll", reposition, true);
  }, [open]);

  // Close slash menu when clicking outside it (e.g. on the sidebar or empty area).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const menu = document.querySelector(".slash-menu");
      if (menu && !menu.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!open) return null;

  const rows: { group?: string; option?: SlashOption; index: number }[] = [];
  let lastGroup: string | null = null;
  filtered.forEach((option, i) => {
    if (option.group !== lastGroup) {
      rows.push({ group: option.group, index: i });
      lastGroup = option.group;
    }
    rows.push({ option, index: i });
  });

  return (
    <div ref={menuRef} className="slash-menu" style={{ position: "fixed", top: pos.top, left: pos.left }}>
      {filtered.length === 0 ? (
        <div className="slash-empty">无匹配块</div>
      ) : (
        rows.map((row) => {
          if (row.group) {
            return (
              <div key={`g-${row.group}`} className="slash-group">
                {row.group}
              </div>
            );
          }
          const option = row.option!;
          return (
            <button
              key={option.key}
              className={`slash-item ${sel === row.index ? "slash-item-active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(option)}
              onMouseEnter={() => setSel(row.index)}
            >
              <span className="slash-icon">{option.badge}</span>
              <span className="slash-title">{option.title}</span>
              {option.pinyin && <span className="slash-shortcut">/{option.pinyin}</span>}
            </button>
          );
        })
      )}
    </div>
  );
}
