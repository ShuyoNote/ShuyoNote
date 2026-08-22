import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection, type LexicalNode } from "lexical";
import { $isLinkNode, type LinkNode } from "@lexical/link";

// Small popover shown when the caret is inside a link: open / edit / unlink.

function $getLinkNode(node: LexicalNode | null): LinkNode | null {
  let current = node;
  while (current) {
    if ($isLinkNode(current)) return current;
    current = current.getParent();
  }
  return null;
}

function $unlink(linkNode: LinkNode) {
  const children = linkNode.getChildren();
  const parent = linkNode.getParent();
  if (!parent) return;
  const index = linkNode.getIndexWithinParent();
  linkNode.remove();
  parent.splice(index, 0, children);
}

export function LinkPopoverPlugin() {
  const [editor] = useLexicalComposerContext();
  const [state, setState] = useState<{ url: string; top: number; left: number } | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          setState(null);
          setEditing(false);
          return;
        }
        const linkNode = $getLinkNode(selection.anchor.getNode());
        if (!linkNode) {
          setState(null);
          setEditing(false);
          return;
        }
        const dom = editor.getElementByKey(linkNode.getKey());
        if (dom) {
          const rect = dom.getBoundingClientRect();
          setState({ url: linkNode.getURL(), top: rect.bottom + 4, left: rect.left });
        }
      });
    });
  }, [editor]);

  // Close link popover when clicking outside it (e.g. on the sidebar).
  useEffect(() => {
    if (!state) return;
    const onDown = (e: MouseEvent) => {
      const el = document.querySelector(".link-popover");
      if (el && !el.contains(e.target as Node)) {
        setState(null);
        setEditing(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [state]);

  if (!state) return null;

  const applyUrl = (url: string) => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      const linkNode = $getLinkNode(selection.anchor.getNode());
      if (linkNode) linkNode.setURL(url.trim());
    });
    setEditing(false);
  };

  const open = () => {
    if (state.url) openUrl(state.url).catch(() => {});
    setState(null);
  };

  const unlink = () => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      const linkNode = $getLinkNode(selection.anchor.getNode());
      if (linkNode) $unlink(linkNode);
    });
    setState(null);
  };

  return (
    <div className="link-popover" style={{ top: state.top, left: state.left }}>
      {editing ? (
        <input
          className="link-input"
          autoFocus
          defaultValue={state.url}
          onKeyDown={(e) => {
            if (e.key === "Enter") applyUrl((e.target as HTMLInputElement).value);
            else if (e.key === "Escape") setEditing(false);
          }}
          onBlur={(e) => applyUrl(e.target.value)}
        />
      ) : (
        <span className="link-url" title={state.url}>
          {state.url}
        </span>
      )}
      <button className="link-btn" onClick={open} title="打开链接">
        打开
      </button>
      <button className="link-btn" onClick={() => setEditing((v) => !v)} title="编辑链接">
        编辑
      </button>
      <button className="link-btn danger" onClick={unlink} title="取消链接">
        取消链接
      </button>
    </div>
  );
}
