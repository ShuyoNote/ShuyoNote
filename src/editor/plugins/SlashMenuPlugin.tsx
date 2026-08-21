import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createHeadingNode, $createQuoteNode } from "@lexical/rich-text";
import { $createLinkNode } from "@lexical/link";
import { $createCodeHighlightNode, $createCodeNode } from "@lexical/code";
import {
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
} from "@lexical/list";
import { INSERT_HORIZONTAL_RULE_COMMAND } from "@lexical/react/LexicalHorizontalRuleNode";
import { INSERT_TABLE_COMMAND } from "@lexical/table";
import { api } from "../../lib/api";
import { toast } from "../../store/toast";
import { useBlockSelector } from "../../store/blockSelector";
import { $createCalloutNode } from "../nodes/CalloutNode";
import { $createImageNode } from "../nodes/ImageNode";
import { $createVideoNode } from "../nodes/VideoNode";
import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  KEY_DOWN_COMMAND,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";

type Run = (editor: LexicalEditor) => void | Promise<void>;

interface SlashOption {
  key: string;
  title: string;
  badge: string;
  group: string;
  run: Run;
}

// Replace the current top-level block with a new element, moving children over.
function $replaceBlock(newNode: ElementNode) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const anchor = selection.anchor.getNode();
  const topLevel = anchor.getTopLevelElement();
  if (!topLevel) return;
  const children = topLevel.getChildren();
  for (const child of children) {
    newNode.append(child);
  }
  topLevel.replace(newNode);
  newNode.selectStart();
}

// Replace the current top-level block with a decorator (image/video), then
// insert an empty paragraph after it and move the caret there.
function $insertBlockNode(node: LexicalNode) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const anchor = selection.anchor.getNode();
  const topLevel = anchor.getTopLevelElement();
  if (!topLevel) return;
  topLevel.replace(node);
  const paragraph = $createParagraphNode();
  const parent = node.getParent();
  if (parent) {
    parent.splice(node.getIndexWithinParent() + 1, 0, [paragraph]);
    paragraph.select();
  }
}

function makeOptions(pageId: string): SlashOption[] {
  return [
    { key: "h1", title: "标题 1", badge: "H1", group: "基础", run: (editor) =>
      editor.update(() => $replaceBlock($createHeadingNode("h1"))) },
    { key: "h2", title: "标题 2", badge: "H2", group: "基础", run: (editor) =>
      editor.update(() => $replaceBlock($createHeadingNode("h2"))) },
    { key: "h3", title: "标题 3", badge: "H3", group: "基础", run: (editor) =>
      editor.update(() => $replaceBlock($createHeadingNode("h3"))) },
    { key: "p", title: "正文", badge: "¶", group: "基础", run: (editor) =>
      editor.update(() => $replaceBlock($createParagraphNode())) },
    { key: "quote", title: "引用", badge: "❝", group: "基础", run: (editor) =>
      editor.update(() => $replaceBlock($createQuoteNode())) },
    { key: "link", title: "链接", badge: "🔗", group: "基础", run: (editor) =>
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const anchor = selection.anchor.getNode();
        const topLevel = anchor.getTopLevelElement();
        if (!topLevel) return;
        const text = topLevel.getTextContent() || "链接";
        const linkNode = $createLinkNode("https://").append($createTextNode(text));
        const paragraph = $createParagraphNode();
        paragraph.append(linkNode);
        topLevel.replace(paragraph);
        linkNode.selectStart();
      }) },
    { key: "todo", title: "待办事项", badge: "☑", group: "列表", run: (editor) => {
      editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined); } },
    { key: "ul", title: "无序列表", badge: "•", group: "列表", run: (editor) => {
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined); } },
    { key: "ol", title: "有序列表", badge: "1.", group: "列表", run: (editor) => {
      editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined); } },
    { key: "image", title: "图片", badge: "🖼", group: "媒体", run: async (editor) => {
      const selected = await open({
        title: "选择图片",
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
        multiple: false,
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected as string];
      try {
        const metas = await api.importAttachmentFiles(pageId, paths);
        if (metas.length === 0) return;
        const src = convertFileSrc(metas[0].path);
        editor.update(() => $insertBlockNode($createImageNode(src)));
      } catch (e) {
        toast(`插入图片失败：${e}`, "error");
      }
    } },
    { key: "video", title: "视频", badge: "🎬", group: "媒体", run: async (editor) => {
      const selected = await open({
        title: "选择视频",
        filters: [{ name: "视频", extensions: ["mp4", "webm", "mov", "m4v"] }],
        multiple: false,
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected as string];
      try {
        const metas = await api.importAttachmentFiles(pageId, paths);
        if (metas.length === 0) return;
        const src = convertFileSrc(metas[0].path);
        editor.update(() => $insertBlockNode($createVideoNode(src)));
      } catch (e) {
        toast(`插入视频失败：${e}`, "error");
      }
    } },
    { key: "callout", title: "Callout 提示框", badge: "💡", group: "嵌入", run: (editor) =>
      editor.update(() => $replaceBlock($createCalloutNode())) },
    { key: "code", title: "代码块", badge: "{}", group: "嵌入", run: (editor) =>
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const anchor = selection.anchor.getNode();
        const topLevel = anchor.getTopLevelElement();
        if (!topLevel) return;
        const codeNode = $createCodeNode("javascript");
        codeNode.append($createCodeHighlightNode(topLevel.getTextContent()));
        topLevel.replace(codeNode);
        codeNode.selectStart();
      }) },
    { key: "hr", title: "分隔线", badge: "—", group: "嵌入", run: (editor) => {
      editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined); } },
    { key: "table", title: "表格", badge: "▦", group: "嵌入", run: (editor) => {
      editor.dispatchCommand(INSERT_TABLE_COMMAND, {
        columns: "3",
        rows: "3",
        includeHeaders: { rows: true, columns: false },
      }); } },
    { key: "blockref", title: "引用块", badge: "⛓", group: "引用", run: () => {
      useBlockSelector.getState().openSelector("ref"); } },
    { key: "blockembed", title: "嵌入块", badge: "🧩", group: "引用", run: () => {
      useBlockSelector.getState().openSelector("embed"); } },
  ];
}

export function SlashMenuPlugin({ pageId }: { pageId: string }) {
  const [editor] = useLexicalComposerContext();
  const options = useMemo(() => makeOptions(pageId), [pageId]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [sel, setSel] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.title.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const stateRef = useRef({ filtered, sel, editor });
  stateRef.current = { filtered, sel, editor };

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
          const match = before.match(/(\/)([^\s/]*)$/);
          if (match && match.index !== undefined) {
            node.spliceText(match.index, anchor.offset - match.index, "");
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
        const match = before.match(/(\/)([^\s/]*)$/);
        if (!match) {
          setOpen(false);
          return;
        }
        setQuery(match[2] || "");
        setSel(0);
        const dom = editor.getElementByKey(node.getKey());
        if (dom) {
          const rect = dom.getBoundingClientRect();
          setPos({ top: rect.bottom + 4, left: rect.left });
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
          setPos({ top: rect.bottom + 4, left: rect.left });
        }
      });
    };
    document.addEventListener("scroll", reposition, true);
    return () => document.removeEventListener("scroll", reposition, true);
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
    <div className="slash-menu" style={{ position: "fixed", top: pos.top, left: pos.left }}>
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
            </button>
          );
        })
      )}
    </div>
  );
}
