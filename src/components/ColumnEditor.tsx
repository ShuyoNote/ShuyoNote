import { useState } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import type { EditorState, LexicalEditor } from "lexical";
import { SHUYONOTE_TRANSFORMERS } from "../editor/markdownTransformers";
import { EDITOR_NODES, editorTheme, ALLOWED_NODE_TYPES } from "../editor/config";
import { SlashMenuPlugin } from "../editor/plugins/SlashMenuPlugin";
import { InsertShortcutPlugin } from "../editor/plugins/InsertShortcutPlugin";
import { lexicalStateValid } from "../lib/lexicalValidate";

// A single column editor (Route B): one nested LexicalComposer sharing the page
// editor's nodes/theme, hosting its own EditorState JSON. `onChange` is called with
// the column's serialized editor-state JSON (a valid Lexical doc) after each edit so
// the parent ColumnsNode can persist it.

const COLUMN_PLACEHOLDER = "输入 / 选择块…";

export function ColumnEditor({
  column,
  columnKey,
  pageId,
  onSerialize,
}: {
  columnKey: string;
  column: string | null; // serialized EditorState JSON (or null for an empty column)
  pageId: string;
  onSerialize?: (key: string, json: string) => void;
}) {
  const [err, setErr] = useState<string | null>(null);

  // Sanitize + validate a saved column doc; fall back to an empty paragraph so a
  // malformed column never crashes the editor.
  const safeJson = (() => {
    if (!column) return null;
    const v = lexicalStateValid(column, ALLOWED_NODE_TYPES);
    return v;
  })();

  const initialConfig = {
    namespace: `shuyonote-column-${columnKey}`,
    nodes: EDITOR_NODES,
    theme: editorTheme as never,
    onError: (error: Error) => {
      setErr(error.message || String(error));
    },
    editorState: safeJson as never,
  };

  const onChange = (_state: EditorState, editor: LexicalEditor) => {
    const json = JSON.stringify(editor.getEditorState().toJSON());
    onSerialize?.(columnKey, json);
  };

  return (
    <div className="editor-column" data-column-key={columnKey}>
      {err ? <div className="editor-column-error">{err}</div> : null}
      <LexicalComposer initialConfig={initialConfig}>
        <RichTextPlugin
          contentEditable={<ContentEditable className="editor-column-editable" />}
          placeholder={<div className="editor-column-placeholder">{COLUMN_PLACEHOLDER}</div>}
          ErrorBoundary={(props) => <div className="editor-error">{props.children}</div>}
        />
        <HistoryPlugin />
        <ListPlugin />
        <CheckListPlugin />
        <HorizontalRulePlugin />
        <MarkdownShortcutPlugin transformers={SHUYONOTE_TRANSFORMERS} />
        <SlashMenuPlugin pageId={pageId} />
        <InsertShortcutPlugin />
        <OnChangePlugin onChange={onChange} />
      </LexicalComposer>
    </div>
  );
}
