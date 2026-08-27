import { memo, useEffect, useMemo, useRef, useState } from "react";
import { LexicalNestedComposer } from "@lexical/react/LexicalNestedComposer";
import { createEditor, type EditorState, type LexicalEditor } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { SHUYONOTE_TRANSFORMERS } from "../editor/markdownTransformers";
import { EDITOR_NODES, editorTheme, ALLOWED_NODE_TYPES } from "../editor/config";
import { SlashMenuPlugin } from "../editor/plugins/SlashMenuPlugin";
import { InsertShortcutPlugin } from "../editor/plugins/InsertShortcutPlugin";
import { BlockInsertPlugin } from "../editor/plugins/BlockInsertPlugin";
import { lexicalStateValid } from "../lib/lexicalValidate";

// A single column editor (Route B): one NESTED Lexical editor sharing the page
// editor's nodes/theme, hosting its own EditorState JSON. `onChange` is called with
// the column's serialized editor-state JSON (a valid Lexical doc) after each edit so
// the parent ColumnsNode can persist it.
//
// Memoized: the parent ColumnsBlockView re-renders on every column layout change
// (and used to on every drag frame); a column's props are stable unless its own
// content changes, so memo avoids re-rendering this heavy nested-editor tree.
//
// IMPORTANT: this must be a *nested* editor, not a standalone LexicalComposer. The
// column editors are rendered inside the outer page editor's React tree (via
// ColumnsBlockNode.decorate()). If we built them with a bare LexicalComposer, the
// created editor would have `_parentEditor === null`; Lexical (0.49) wouldn't know
// they're children of the page editor, and on mousedown the OUTER editor would
// steal focus back from the column — so typing/clicking inside a column would go
// to the page editor instead ("分栏不能输入"). Setting `parentEditor` (via
// createEditor) + LexicalNestedComposer keeps Lexical's nested-editor semantics.

export const ColumnEditor = memo(function ColumnEditor({
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
  // The page (outer) editor this column belongs to.
  const [parentEditor] = useLexicalComposerContext();

  // Sanitize + validate a saved column doc; fall back to an empty paragraph so a
  // malformed column never crashes the editor.
  const safeJson = (() => {
    if (!column) return null;
    const v = lexicalStateValid(column, ALLOWED_NODE_TYPES);
    return v;
  })();

  // Create the nested editor once; pass the outer editor as `parentEditor` so
  // Lexical treats this as a nested child and lets typing/click stay inside it.
  const editor: LexicalEditor = useMemo(() => {
    const e = createEditor({
      namespace: `shuyonote-column-${columnKey}`,
      nodes: EDITOR_NODES,
      theme: editorTheme as never,
      onError: (error: Error) => {
        setErr(error.message || String(error));
      },
      parentEditor: parentEditor ?? undefined,
    });
    if (safeJson) {
      try {
        e.setEditorState(e.parseEditorState(safeJson));
      } catch (err) {
        setErr(err instanceof Error ? err.message : String(err));
      }
    }
    return e;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnKey]);

  // Track the last JSON this editor itself emitted. When the incoming `column` prop
  // differs from that (i.e. the PARENT changed it — a column was inserted/removed/
  // reordered and this component instance was reused for a different index), re-apply
  // the prop so we don't show stale content. When the change is our OWN edit the JSON
  // matches and we leave the editor untouched (no cursor jump).
  const lastEmitted = useRef<string | null>(null);
  useEffect(() => {
    if (column !== null && column !== lastEmitted.current) {
      try {
        const parsed = lexicalStateValid(column, ALLOWED_NODE_TYPES);
        if (parsed) editor.setEditorState(editor.parseEditorState(parsed));
      } catch (err) {
        setErr(err instanceof Error ? err.message : String(err));
      }
      lastEmitted.current = column;
    }
  }, [column, editor]);

  const onChange = (_state: EditorState, ed: LexicalEditor) => {
    const json = JSON.stringify(ed.getEditorState().toJSON());
    lastEmitted.current = json;
    onSerialize?.(columnKey, json);
  };

  return (
    <div className="editor-column-body" data-column-key={columnKey}>
      {err ? <div className="editor-column-error">{err}</div> : null}
      <LexicalNestedComposer initialEditor={editor}>
        <RichTextPlugin
          contentEditable={<ContentEditable className="editor-column-editable" />}
          placeholder={null}
          ErrorBoundary={(props) => <div className="editor-error">{props.children}</div>}
        />
        <HistoryPlugin />
        <ListPlugin />
        <CheckListPlugin />
        <HorizontalRulePlugin />
        <TablePlugin hasHorizontalScroll />
        <MarkdownShortcutPlugin transformers={SHUYONOTE_TRANSFORMERS} />
        <SlashMenuPlugin pageId={pageId} />
        <InsertShortcutPlugin />
        <BlockInsertPlugin pageId={pageId} gutterOffset={4} />
        <OnChangePlugin onChange={onChange} />
      </LexicalNestedComposer>
    </div>
  );
});
