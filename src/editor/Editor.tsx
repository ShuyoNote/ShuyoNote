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
import { $getRoot, type EditorState, type LexicalEditor } from "lexical";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "../store/toast";
import { useEditorStore } from "../store/editor";
import { CalloutNode } from "./nodes/CalloutNode";
import { ImageNode } from "./nodes/ImageNode";
import { ImageRowNode } from "./nodes/ImageRowNode";
import { VideoNode } from "./nodes/VideoNode";
import { BlockRefNode } from "./nodes/BlockRefNode";
import { BlockEmbedNode } from "./nodes/BlockEmbedNode";
import { AttachmentRefNode } from "./nodes/AttachmentRefNode";
import { SlashMenuPlugin } from "./plugins/SlashMenuPlugin";
import { InsertShortcutPlugin } from "./plugins/InsertShortcutPlugin";
import { ClickToEditPlugin } from "./plugins/ClickToEditPlugin";
import { ImagePastePlugin } from "./plugins/ImagePastePlugin";
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

function parseEditorState(contentJson: string): string | null {
  try {
    const parsed = JSON.parse(contentJson);
    const root = parsed && parsed.root;
    // A page with any top-level blocks has real content; use it on reload even
    // if a specific node fails our structural validation (Lexical tolerates it,
    // and losing valid imported content is worse than a graceful edge case).
    if (root && Array.isArray(root.children) && root.children.length > 0) {
      return contentJson;
    }
  } catch {
    // fall through to empty
  }
  return null;
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

export function Editor({ contentJson, onSave, autoFocus, pageId, searchQuery }: EditorProps) {
  // Stable block identity: node key → block id, and the persisted ids (in
  // top-level child order) read from the saved document at mount.
  const blockIdMapRef = useRef<Map<string, string>>(new Map());
  const seedIdsRef = useRef<(string | null)[]>(extractSeedIds(contentJson));

  const initialConfig = useMemo(
    () => ({
      namespace: "shuyonote-editor",
      theme,
      nodes: [
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
        AttachmentRefNode,
        TableNode,
        TableCellNode,
        TableRowNode,
      ],
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
          placeholder={<div className="editor-placeholder">输入内容，或使用 "/" 命令 / Markdown 语法…</div>}
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
        <ImagePastePlugin pageId={pageId} />
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
      </div>
    </LexicalComposer>
  );
}

// Expose the active editor instance to the top toolbar (outside the editor tree).
function EditorStoreSync() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    useEditorStore.getState().setEditor(editor);
    return () => {
      useEditorStore.getState().setEditor(null);
    };
  }, [editor]);
  return null;
}
