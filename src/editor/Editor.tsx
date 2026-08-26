import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import { TableNode, TableCellNode, TableRowNode } from "@lexical/table";
import { SHUYONOTE_TRANSFORMERS } from "./markdownTransformers";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, createEditor, type EditorState, type LexicalEditor } from "lexical";
import { lazy, Suspense, useEffect, useMemo, useRef, memo } from "react";
import { toast } from "../store/toast";
import { useEditorStore } from "../store/editor";
import { CalloutNode } from "./nodes/CalloutNode";
import { ImageNode } from "./nodes/ImageNode";
import { ImageRowNode } from "./nodes/ImageRowNode";
import { VideoNode } from "./nodes/VideoNode";
import { BlockRefNode } from "./nodes/BlockRefNode";
import { BlockEmbedNode } from "./nodes/BlockEmbedNode";
import { WebBookmarkNode } from "./nodes/WebBookmarkNode";
import { AttachmentRefNode } from "./nodes/AttachmentRefNode";
import { DrawingNode } from "./nodes/DrawingNode";
import { MermaidNode } from "./nodes/MermaidNode";
import { SlashMenuPlugin } from "./plugins/SlashMenuPlugin";import { InsertShortcutPlugin } from "./plugins/InsertShortcutPlugin";
import { ClickToEditPlugin } from "./plugins/ClickToEditPlugin";
import { AiSpaceTriggerPlugin } from "./plugins/AiSpaceTriggerPlugin";
import { PageLinkSuggestPlugin } from "./plugins/PageLinkSuggestPlugin";
import { ImagePastePlugin } from "./plugins/ImagePastePlugin";
import { BookmarkPastePlugin } from "./plugins/BookmarkPastePlugin";
import { SearchHighlightPlugin } from "./plugins/SearchHighlightPlugin";
import { FindPlugin } from "./plugins/FindPlugin";
import { SelectionToolbarPlugin } from "./plugins/SelectionToolbarPlugin";
import { LinkPopoverPlugin } from "./plugins/LinkPopoverPlugin";
import { TableMenuPlugin } from "./plugins/TableMenuPlugin";
import { TableResizerPlugin } from "./plugins/TableResizerPlugin";
import { BlockDragPlugin } from "./plugins/BlockDragPlugin";import { BlockSelectionPlugin } from "./plugins/BlockSelectionPlugin";
import { BlockRefPlugin } from "./plugins/BlockRefPlugin";
import { BlockSelectorPlugin } from "./plugins/BlockSelectorPlugin";
import { BlockRefSyncPlugin } from "./plugins/BlockRefSyncPlugin";

const theme = {
  heading: {
    h1: "editor-h1",
    h2: "editor-h2",
    h3: "editor-h3",
  },
  quote: "editor-quote",
  callout: "editor-callout",
  list: {
    ul: "editor-ul",
    ol: "editor-ol",
    listitem: "editor-listitem",
    checklist: "editor-checklist",
    listitemChecked: "editor-listitem-checked",
    listitemUnchecked: "editor-listitem-unchecked",
    nested: {
      listitem: "editor-nested-listitem",
    },
  },
  text: {
    bold: "editor-bold",
    italic: "editor-italic",
    underline: "editor-underline",
    strikethrough: "editor-strikethrough",
    code: "editor-code",
  },
  link: "editor-link",
  code: "editor-codeblock",
  hr: "editor-hr",
  table: "editor-table",
  tableScrollableWrapper: "editor-table-scrollable-wrapper",
  tableSelection: "table-selecting",
  tableCell: "editor-table-cell",
  tableCellHeader: "editor-table-cell-header",
  tableCellSelected: "editor-table-cell-selected",
  tableRow: "editor-table-row",
};

interface EditorProps {
  contentJson: string;
  onSave: (contentJson: string, contentText: string) => void;
  autoFocus?: boolean;
  pageId: string;
  searchQuery?: string;
}

import { lexicalStateValid } from "../lib/lexicalValidate";

const EDITOR_NODES = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  CodeHighlightNode,
  LinkNode,
  CalloutNode,
  HorizontalRuleNode,
  ImageNode,
  ImageRowNode,
  VideoNode,
  BlockRefNode,
  BlockEmbedNode,
  WebBookmarkNode,
  AttachmentRefNode,
  DrawingNode,
  MermaidNode,
  TableNode,
  TableCellNode,
  TableRowNode,
];

// Every node type this editor can deserialize: Lexical's always-core types plus
// the ones we register above. A serialized node whose `type` is outside this set
// (e.g. the literal string "undefined", or a stray/unregistered type) cannot be
// parsed by Lexical and is dropped by lexicalStateValid so it can't crash the
// editor or spam the console with "type ... not found".
const CORE_NODE_TYPES = ["root", "paragraph", "text", "linebreak", "tab"];
const ALLOWED_NODE_TYPES = new Set<string>([
  ...CORE_NODE_TYPES,
  ...EDITOR_NODES.map((n) => (n as { getType?: () => string }).getType?.()).filter((t): t is string => typeof t === "string"),
]);

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
    contentJson = valid;
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

// Generate a stable block id (UUID v4). Falls back to crypto.getRandomValues when
// crypto.randomUUID is unavailable (non-secure contexts).
function newBlockId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Read the persisted block ids from a serialized editor state, in top-level
// child order (null where a block has no id yet, e.g. legacy documents).
function extractSeedIds(contentJson: string): (string | null)[] {
  try {
    const parsed = JSON.parse(contentJson);
    const children = parsed?.root?.children;
    if (!Array.isArray(children)) return [];
    return children.map((c: any) =>
      typeof c?.blockId === "string" && c.blockId.length > 0 ? (c.blockId as string) : null,
    );
  } catch {
    return [];
  }
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
        let id = map.get(child.getKey());
        if (!id) {
          id = newBlockId();
          map.set(child.getKey(), id);
        }
        rootChildren[i].blockId = id;
      });
    }
  });
  return JSON.stringify(json);
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

  // Tag DOMs on mount and on every update.
  useEffect(() => {
    tagBlockDoms(editor, map, editor.getEditorState());
    return editor.registerUpdateListener(({ editorState }) => {
      tagBlockDoms(editor, map, editorState);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    onSave(json, text);
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
        <BlockRefSyncPlugin />
        <BlockSelectorPlugin />
        <MarkdownShortcutPlugin transformers={SHUYONOTE_TRANSFORMERS} />
        <SlashMenuPlugin pageId={pageId} />
        <PageLinkSuggestPlugin />
        <AiSpaceTriggerPlugin />
        <ImagePastePlugin pageId={pageId} />
        <BookmarkPastePlugin />
        <BlockDragPlugin />
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
