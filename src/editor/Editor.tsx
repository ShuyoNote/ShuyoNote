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
import { TRANSFORMERS } from "@lexical/markdown";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, type EditorState, type LexicalEditor } from "lexical";
import { useEffect, useMemo } from "react";
import { toast } from "../store/toast";
import { useEditorStore } from "../store/editor";
import { CalloutNode } from "./nodes/CalloutNode";
import { ImageNode } from "./nodes/ImageNode";
import { VideoNode } from "./nodes/VideoNode";
import { SlashMenuPlugin } from "./plugins/SlashMenuPlugin";
import { ImagePastePlugin } from "./plugins/ImagePastePlugin";
import { SearchHighlightPlugin } from "./plugins/SearchHighlightPlugin";
import { FindPlugin } from "./plugins/FindPlugin";
import { SelectionToolbarPlugin } from "./plugins/SelectionToolbarPlugin";
import { LinkPopoverPlugin } from "./plugins/LinkPopoverPlugin";
import { BlockDragPlugin } from "./plugins/BlockDragPlugin";

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
  tableCell: "editor-table-cell",
  tableCellHeader: "editor-table-cell-header",
  tableRow: "editor-table-row",
};

interface EditorProps {
  contentJson: string;
  onSave: (contentJson: string, contentText: string) => void;
  autoFocus?: boolean;
  pageId: string;
  searchQuery?: string;
}

function isValidLexicalNode(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  if (typeof node.type !== "string") return false;
  // listitem must have a paragraph (or another block) child, never bare text.
  if (node.type === "listitem") {
    const kids = Array.isArray(node.children) ? node.children : [];
    for (const k of kids) {
      if (k && k.type === "text") return false;
    }
  }
  const children = Array.isArray(node.children) ? node.children : [];
  return children.every(isValidLexicalNode);
}

function parseEditorState(contentJson: string): string | null {
  try {
    const parsed = JSON.parse(contentJson);
    const root = parsed && parsed.root;
    // An empty root (no children) is not a valid editor state; let Lexical
    // seed a default paragraph instead.
    if (
      root &&
      Array.isArray(root.children) &&
      root.children.length > 0 &&
      isValidLexicalNode(root)
    ) {
      return contentJson;
    }
  } catch {
    // fall through to empty
  }
  return null;
}

export function Editor({ contentJson, onSave, autoFocus, pageId, searchQuery }: EditorProps) {
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
        VideoNode,
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

  const onChange = (_editorState: EditorState, editor: LexicalEditor) => {
    const json = JSON.stringify(editor.getEditorState().toJSON());
    const text = editor.getEditorState().read(() => $getRoot().getTextContent());
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
        <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
        <SlashMenuPlugin pageId={pageId} />
        <ImagePastePlugin pageId={pageId} />
        <BlockDragPlugin />
        {searchQuery && <SearchHighlightPlugin query={searchQuery} />}
        <FindPlugin />
        <SelectionToolbarPlugin />
        <LinkPopoverPlugin />
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
