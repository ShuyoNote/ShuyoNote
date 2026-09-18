import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import "./prismSetup";
import { CodeExtension, CodeIndentExtension, registerCodeHighlighting } from "@lexical/code";
import { SHUYONOTE_TRANSFORMERS } from "./markdownTransformers";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $createParagraphNode, createEditor, ParagraphNode, type EditorState, type LexicalEditor } from "lexical";
// 块身份那一层：内存模型 ⇄ 落盘/同步形态（见 docs/plans/2026-09-18-crdt-block-id-ownership.md）
import { newBlockId, readBlockId, toLegacyDoc, toModelDoc, topLevelBlockIds } from "../lib/blockIdentity";
import { lazy, Suspense, useEffect, useMemo, useRef, memo } from "react";
import { toast } from "../store/toast";
import { useEditorStore } from "../store/editor";
import { SlashMenuPlugin } from "./plugins/SlashMenuPlugin";import { InsertShortcutPlugin } from "./plugins/InsertShortcutPlugin";
import { ClickToEditPlugin } from "./plugins/ClickToEditPlugin";
import { AiSpaceTriggerPlugin } from "./plugins/AiSpaceTriggerPlugin";
import { PageLinkSuggestPlugin } from "./plugins/PageLinkSuggestPlugin";
import { PageLinkPlugin } from "./plugins/PageLinkPlugin";
import { InlineFormulaPlugin } from "./plugins/InlineFormulaPlugin";
import { ImagePastePlugin } from "./plugins/ImagePastePlugin";
import { BookmarkPastePlugin } from "./plugins/BookmarkPastePlugin";
import { SearchHighlightPlugin } from "./plugins/SearchHighlightPlugin";
import { FindPlugin } from "./plugins/FindPlugin";
import { SelectionToolbarPlugin } from "./plugins/SelectionToolbarPlugin";
import { LinkPopoverPlugin } from "./plugins/LinkPopoverPlugin";
import { TableMenuPlugin } from "./plugins/TableMenuPlugin";
import { TableResizerPlugin } from "./plugins/TableResizerPlugin";
import { BlockDragPlugin } from "./plugins/BlockDragPlugin";import { BlockSelectionPlugin } from "./plugins/BlockSelectionPlugin";
import { BlockInsertPlugin } from "./plugins/BlockInsertPlugin";
import { BlockRefPlugin } from "./plugins/BlockRefPlugin";
import { PdfRefPlugin } from "./plugins/PdfRefPlugin";
import { BlockSelectorPlugin } from "./plugins/BlockSelectorPlugin";
import { BlockRefSyncPlugin } from "./plugins/BlockRefSyncPlugin";
import {
  upgradeCodeToBlockNode,
  upgradeHeadingToBlockNode,
  upgradeHorizontalRuleToBlockNode,
  upgradeListToBlockNode,
  upgradeParagraphToBlockNode,
  upgradeQuoteToBlockNode,
  upgradeTableToBlockNode,
} from "./blockIdTransform";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode } from "@lexical/list";
import { SafeCodeNode } from "./nodes/SafeCodeNode";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { TableNode } from "@lexical/table";
import { CodeBlockToolbar } from "./plugins/CodeBlockToolbar";

import { editorTheme as theme, EDITOR_NODES, ALLOWED_NODE_TYPES } from "./config";
import { collectColumnsText } from "../lib/columnsText";

interface EditorProps {
  contentJson: string;
  onSave: (contentJson: string, contentText: string) => void;
  autoFocus?: boolean;
  pageId: string;
  searchQuery?: string;
}

import { lexicalStateValid } from "../lib/lexicalValidate";

// A throwaway editor with the same node registry, used to PRE-PARSE a saved
// content string. If any node is malformed, Lexical catches the error internally
// and routes it to `editor._onError` — by default `console.error` (which spams the
// console). We install a handler that records the reason so we can surface WHY a
// page fell back to empty, without flooding the console on every keystroke.
let lastProbeError: unknown = null;
const probeEditor = createEditor({
  nodes: EDITOR_NODES,
  onError: (e) => {
    lastProbeError = e;
  },
});

/** Rebuild the doc from only the top-level blocks that Lexical can parse. A block
 *  that fails (bad node in `children` or `$slots`) is dropped; good blocks are
 *  kept so a mostly-valid page still renders instead of showing blank. */
function salvageByBlock(contentJson: string | null | undefined): EditorState | null {
  if (!contentJson) return null;
  try {
    const parsed = JSON.parse(contentJson);
    const root = parsed?.root;
    if (!root || !Array.isArray(root.children) || root.children.length === 0) return null;
    const origError = console.error;
    const kept: unknown[] = [];
    for (const block of root.children) {
      const probeDoc = JSON.stringify({ type: "root", version: 1, children: [block] });
      console.error = () => {};
      let ok = false;
      try {
        const st = probeEditor.parseEditorState(probeDoc);
        ok = !!st && !st.isEmpty();
      } catch {
        ok = false;
      } finally {
        console.error = origError;
      }
      if (ok) kept.push(block);
    }
    if (kept.length === 0) return null;
    root.children = kept;
    console.error = () => {};
    try {
      const st = probeEditor.parseEditorState(JSON.stringify(parsed));
      return st && !st.isEmpty() ? st : null;
    } catch {
      return null;
    } finally {
      console.error = origError;
    }
  } catch {
    return null;
  }
}

/** Walk a content doc (children + $slots) and return the FIRST node that would
 *  make Lexical throw — a missing/blank/`"undefined"`/unregistered `type`. Returns
 *  a short JSON snippet of that node so the exact offender is identifiable. */
function scanBadNode(contentJson: string | null | undefined, allowed: Set<string>): string | null {
  if (!contentJson) return null;
  try {
    const parsed = JSON.parse(contentJson);
    const root = parsed?.root;
    if (!root || typeof root !== "object") return null;
    const bad = (n: unknown): string | null => {
      if (!n || typeof n !== "object" || Array.isArray(n)) return null;
      const node = n as Record<string, unknown>;
      const t = node.type;
      if (typeof t !== "string" || !t || t === "undefined" || t === "null" || !allowed.has(t)) {
        return JSON.stringify(node).slice(0, 200);
      }
      if (Array.isArray(node.children)) {
        for (const c of node.children) {
          const r = bad(c);
          if (r) return r;
        }
      }
      if (node.$slots && typeof node.$slots === "object") {
        for (const k of Object.keys(node.$slots)) {
          const r = bad((node.$slots as Record<string, unknown>)[k]);
          if (r) return r;
        }
      }
      return null;
    };
    return bad(root);
  } catch {
    return null;
  }
}

/** @returns a parsed EditorState if the content parses cleanly, else null (empty). */
function isEmptyRootDoc(json: string): boolean {
  try {
    const parsed = JSON.parse(json);
    const root = parsed?.root;
    return !!root && Array.isArray(root.children) && root.children.length === 0;
  } catch {
    return false;
  }
}

/** @returns a parsed EditorState if the content parses cleanly, else null (empty). */
function parseEditorState(contentJson: string): EditorState | null {
  if (contentJson) {
    // lexicalStateValid now SANITIZES: it drops malformed children (e.g. nodes
    // missing `type`) and keeps the good block content, so a mostly-valid page
    // still renders. It returns null only when nothing usable remains or the doc
    // isn't parseable. Log a clear marker when we have to fall back to empty so
    // we can confirm which build the browser is running and capture the raw JSON.
    const valid = lexicalStateValid(contentJson, ALLOWED_NODE_TYPES);
    if (!valid) {
      console.warn("[ShuyoNote] 页面内容不可用(打开空白)。content_json 长度:", contentJson.length, "片段:", contentJson.slice(0, 300));
      return null;
    }
    // ★ 老形态（落盘/同步）→ **内存模型**：`paragraph` 换成 `shuyo-paragraph`，顶层块补齐块 ID。
    // 顺序有意如此：**先按老形态校验/净化**（wire 格式才是我们承诺稳定的那一种），再换模型类型。
    contentJson = toModelDoc(valid, newBlockId);
  }
  // Lexical catches a malformed node internally and routes it to the editor's
  // onError (a no-op here), returning an EMPTY state — so `probeEditor` never
  // throws; we decide the outcome by whether the parsed state is empty.
  const origError = console.error;
  console.error = () => {};
  try {
    lastProbeError = null;
    const state = probeEditor.parseEditorState(contentJson ?? "");
    if (!state || state.isEmpty()) {
      // 合法空 root（children 为空）就是正常的空白页——返回 null，让 LexicalComposer
      // 用默认空根(非空)初始化，而不是空 EditorState(会报 "editor state is empty")。
      if (isEmptyRootDoc(contentJson)) {
        return null;
      }
      const wholeDocErr = lastProbeError;
      // Some node survived sanitization in a non-`children` spot (e.g. `$slots`);
      // rescue the good top-level blocks rather than showing a blank page.
      const salvaged = salvageByBlock(contentJson);
      if (!salvaged && contentJson) {
        console.warn(
          "[ShuyoNote] 页面整页/逐块均失败(确定为空白)。parse error:",
          String((wholeDocErr as Error)?.message ?? wholeDocErr),
          "| offending node:",
          scanBadNode(contentJson, ALLOWED_NODE_TYPES) ?? "(none found)",
          "| content_json:",
          contentJson.slice(0, 600),
        );
      }
      return salvaged;
    }
    return state;
  } catch {
    return salvageByBlock(contentJson);
  } finally {
    console.error = origError;
  }
}

// Generate a stable block id (UUID v4). 实现在 `lib/blockIdentity.ts`（全应用只留一份）。
// 这一层还要用它做**两形态互转**：内存用 `shuyo-paragraph`（块 ID 是声明属性，CRDT 才同步得到），
// 落盘/同步一律还原成 `paragraph` + `blockId` 字段。见 docs/plans/2026-09-18-crdt-block-id-ownership.md。

// Read the persisted block ids from a serialized editor state, in top-level
// child order (null where a block has no id yet, e.g. legacy documents).
// ⚠️ 老形态（落盘/同步）里 `blockId` 是**注入的字段**，所以要在这里读出来 → 种进内存模型的节点上。
function extractSeedIds(contentJson: string): (string | null)[] {
  return topLevelBlockIds(contentJson).map((id) => (id.length > 0 ? id : null));
}

// Serialize an editor state, injecting a stable `blockId` into every top-level
// block. Ids are memoized by Lexical node key so reordering/copy-paste keeps
// each block's identity, while pasted/duplicated blocks get fresh ids.
function serializeWithBlockIds(editorState: EditorState, map: Map<string, string>): string {
  const json: any = editorState.toJSON();
  editorState.read(() => {
    const root = $getRoot();
    const children = root.getChildren();
    const rootChildren = json?.root?.children;
    if (Array.isArray(rootChildren)) {
      children.forEach((child, i) => {
        if (i >= rootChildren.length) return;
        // 内存模型里的节点（如 `BlockParagraphNode`）自己就带块 ID（`exportJSON` 已写出）；
        // `map` 仍是**会话内的权威**（跨重排/复制粘贴保持身份，与今天一致），
        // 所以这里：map 没有就优先用模型里的 ID（避免每次保存都把已有 ID 换掉），最后才新造。
        const modelId = readBlockId(json?.root?.children?.[i]);
        let id = map.get(child.getKey());
        if (!id) {
          id = modelId || newBlockId();
          map.set(child.getKey(), id);
        }
        rootChildren[i].blockId = id;
      });
    }
  });
  // ★ 写出去之前**还原成老形态**：`shuyo-paragraph` → `paragraph`。
  // 落盘/同步的 JSON 里不许出现模型 type（旧版本客户端会把未注册类型整块丢掉 = 段落全丢）。
  return toLegacyDoc(JSON.stringify(json));
}

// Tag each top-level block's DOM element with `data-block-id` so block-reference
// jumps can locate and scroll to it.
function tagBlockDoms(editor: LexicalEditor, map: Map<string, string>, editorState: EditorState) {
  const pairs: [string, string][] = [];
  editorState.read(() => {
    const root = $getRoot();
    root.getChildren().forEach((child) => {
      const id = map.get(child.getKey());
      if (id) pairs.push([child.getKey(), id]);
    });
  });
  pairs.forEach(([key, id]) => {
    const dom = editor.getElementByKey(key);
    if (dom) dom.setAttribute("data-block-id", id);
  });
}

// Seed the block-id map on mount (matching persisted order), keep DOM tags in
// sync, and scroll to a pending focus target after block-reference jumps.
function BlockIdPlugin({
  seedIds,
  map,
}: {
  seedIds: (string | null)[];
  map: Map<string, string>;
}) {
  const [editor] = useLexicalComposerContext();
  const focusBlockId = useEditorStore((s) => s.focusBlockId);

  // Seed ids once, matching persisted order.
  useEffect(() => {
    editor.getEditorState().read(() => {
      const root = $getRoot();
      root.getChildren().forEach((child, i) => {
        map.set(child.getKey(), seedIds[i] ?? newBlockId());
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // 新建的段落（粘贴 / markdown 导入 / HTML 导入 / 空编辑器首段，以及 Lexical 内部自己造的）
  // 一律**升级成模型段落**（`shuyo-paragraph` + 声明块 ID）：这样块 ID 来自**模型**，
  // 而不是等到保存时才注入 JSON（那种 ID 在 CRDT 平面里没有稳定身份）。
  // 创建段落的调用点太散，逐个改必漏 ⇒ 用节点变换一处覆盖。理由见 `blockIdTransform.ts`。
  useEffect(
    () => editor.registerNodeTransform(ParagraphNode, upgradeParagraphToBlockNode),
    [editor],
  );
  // 标题同理（第 4 步逐类型加，每加一个类型补一条判据）。
  useEffect(
    () => editor.registerNodeTransform(HeadingNode, upgradeHeadingToBlockNode),
    [editor],
  );
  // 引用（第 4 步第二个类型）。
  useEffect(
    () => editor.registerNodeTransform(QuoteNode, upgradeQuoteToBlockNode),
    [editor],
  );
  // 列表（第 4 步第三个类型）。
  useEffect(
    () => editor.registerNodeTransform(ListNode, upgradeListToBlockNode),
    [editor],
  );
  // 代码块（第 4 步第四个类型）。变换注册在 SafeCodeNode 上（它的 type 是 `"code"`）。
  useEffect(
    () => editor.registerNodeTransform(SafeCodeNode, upgradeCodeToBlockNode),
    [editor],
  );
  // 水平线（第 4 步第五个类型）。
  useEffect(
    () => editor.registerNodeTransform(HorizontalRuleNode, upgradeHorizontalRuleToBlockNode),
    [editor],
  );
  // 表格（第 4 步第六个类型）。
  useEffect(
    () => editor.registerNodeTransform(TableNode, upgradeTableToBlockNode),
    [editor],
  );

  // Tag DOMs on mount and on every update.
  useEffect(() => {
    tagBlockDoms(editor, map, editor.getEditorState());
    return editor.registerUpdateListener(({ editorState }) => {
      tagBlockDoms(editor, map, editorState);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // 点击「最后一行下方空白」：若最后一行非空则追加空段落并聚焦，可立即输入。
  useEffect(() => {
    const root = editor.getRootElement();
    const host = root?.parentElement ?? root;
    if (!host) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, button, select, a, [contenteditable='false']")) return;
      let lastKey = "";
      try {
        editor.getEditorState().read(() => {
          const last = $getRoot().getLastChild();
          if (!last) return;
          lastKey = last.getKey();
        });
      } catch {
        return;
      }
      if (!lastKey) return;
      const el = editor.getElementByKey(lastKey);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (e.clientY < r.bottom - 4) return; // 不在最后一行下方
      editor.update(() => {
        const last = $getRoot().getLastChild();
        if (!last) return;
        if ((last as any).isEmpty?.()) {
          (last as any).selectStart?.();
        } else {
          const p = $createParagraphNode();
          $getRoot().append(p);
          p.selectStart();
        }
      });
      setTimeout(() => root?.focus(), 0);
    };
    host.addEventListener("mousedown", onDown);
    return () => host.removeEventListener("mousedown", onDown);
  }, [editor]);

  // Enable Prism-based syntax highlighting for code blocks (only tokenizes on
  // code-node updates; does not loop because it doesn't trigger further updates).
  useEffect(() => {
    return registerCodeHighlighting(editor);
  }, [editor]);

  // Scroll to + highlight the focused block. Retries briefly so cross-page jumps
  // land after the new editor mounts (the old editor unmounts and cancels here).
  useEffect(() => {
    if (!focusBlockId) return;
    let cancelled = false;
    let attempts = 0;
    const attempt = () => {
      if (cancelled) return;
      tagBlockDoms(editor, map, editor.getEditorState());
      const el = document.querySelector(`[data-block-id="${focusBlockId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("block-flash");
        window.setTimeout(() => el.classList.remove("block-flash"), 1800);
        useEditorStore.getState().clearFocusBlockId();
      } else if (attempts < 30) {
        attempts += 1;
        window.setTimeout(attempt, 100);
      } else {
        useEditorStore.getState().clearFocusBlockId();
      }
    };
    const raf = requestAnimationFrame(attempt);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [focusBlockId, editor, map]);

  return null;
}

// Lazy-load the drawing editor modal so the (large) Excalidraw bundle is split
// into its own chunk and only fetched when a user actually edits a drawing.
const DrawingEditorModal = lazy(() => import("../components/DrawingEditorModal"));

const EditorImpl = function Editor({ contentJson, onSave, autoFocus, pageId, searchQuery }: EditorProps) {
  // Stable block identity: node key → block id, and the persisted ids (in
  // top-level child order) read from the saved document at mount.
  const blockIdMapRef = useRef<Map<string, string>>(new Map());
  const seedIdsRef = useRef<(string | null)[]>(extractSeedIds(contentJson));

  const initialConfig = useMemo(
    () => ({
      namespace: "shuyonote-editor",
      theme,
      nodes: EDITOR_NODES,
      // CodeNode 0.49+ needs CodeExtension (+ CodeIndentExtension), else
      // insertNewAfter (按 Enter) crashes with getIndexWithinParent undefined.
      extensions: [CodeExtension, CodeIndentExtension],
      onError: (error: Error) => {
        console.error(error);
        toast(`编辑器错误：${error.message || String(error)}`, "error");
      },
      editorState: parseEditorState(contentJson),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onChange = (_editorState: EditorState, _editor: LexicalEditor, tags: Set<string>) => {
    // Internal block-reference text sync should not trigger a save.
    if (tags.has("blockref-sync")) return;
    const json = serializeWithBlockIds(_editorState, blockIdMapRef.current);
    const text = _editorState.read(() => $getRoot().getTextContent());
    onSave(json, text + collectColumnsText(json));
  };

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="editor-shell">
        <RichTextPlugin
          contentEditable={<ContentEditable className="editor-content" autoFocus={autoFocus} />}
          placeholder={<div className="editor-placeholder">输入 '/' 选择，按 '空格' 打开 AI...</div>}
          ErrorBoundary={(props) => <div className="editor-error">{props.children}</div>}
        />
        <HistoryPlugin />
        <ListPlugin />
        <CheckListPlugin />
        <HorizontalRulePlugin />
        <TablePlugin hasHorizontalScroll />
        <OnChangePlugin onChange={onChange} />
        <BlockIdPlugin seedIds={seedIdsRef.current} map={blockIdMapRef.current} />
        <BlockRefPlugin pageId={pageId} />
        <PdfRefPlugin />
        <BlockRefSyncPlugin />
      {/* 块身份那一层的模型节点升级（见下方 BlockIdPlugin 里的 registerNodeTransform） */}
        <BlockSelectorPlugin />
        <CodeBlockToolbar />
        <MarkdownShortcutPlugin transformers={SHUYONOTE_TRANSFORMERS} />
        <SlashMenuPlugin pageId={pageId} />
        <PageLinkSuggestPlugin />
        <PageLinkPlugin />
        <InlineFormulaPlugin />
        <AiSpaceTriggerPlugin />
        <ImagePastePlugin pageId={pageId} />
        <BookmarkPastePlugin />
        <BlockDragPlugin />
        <BlockInsertPlugin pageId={pageId} />
        <BlockSelectionPlugin />
        <InsertShortcutPlugin />
        <ClickToEditPlugin />
        {searchQuery && <SearchHighlightPlugin query={searchQuery} />}
        <FindPlugin />
        <SelectionToolbarPlugin />
        <LinkPopoverPlugin />
        <TableMenuPlugin />
        <TableResizerPlugin />
        <EditorStoreSync />
        <Suspense fallback={null}>
          <DrawingEditorModal />
        </Suspense>
      </div>
    </LexicalComposer>
  );
}

// The editor's Lexical state is authoritative; a page autosave only rewrites
// `contentJson`/`onSave`, which the editor ignores after mount. Skip those
// re-renders so the whole decorator tree (e.g. embedded Excalidraw drawings)
// doesn't remount/re-init on every save — that was the visible "刷新" jitter.
export const Editor = memo(
  EditorImpl,
  (prev, next) =>
    prev.pageId === next.pageId &&
    prev.searchQuery === next.searchQuery &&
    prev.autoFocus === next.autoFocus,
);

// Expose the active editor instance to the top toolbar (outside the editor tree).
function EditorStoreSync() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    useEditorStore.getState().setEditor(editor);
    return () => {
      useEditorStore.getState().setEditor(null);
      // Closing the editor (page switch) should also collapse the inline AI bar.
      useEditorStore.getState().setAiBarOpen(false);
    };
  }, [editor]);
  return null;
}
