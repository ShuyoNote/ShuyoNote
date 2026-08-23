import { useEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
} from "lexical";
import { $createLinkNode } from "@lexical/link";
import { $createWebBookmarkNode } from "../nodes/WebBookmarkNode";

// A URL-like check: http(s)://... or bare www.example.com/...
const URL_RE = /^(https?:\/\/)?(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_+.~#?&/=]*)$/i;

function isOnlyUrl(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\s/.test(t)) return false;
  return URL_RE.test(t);
}

export function BookmarkPastePlugin() {
  const [editor] = useLexicalComposerContext();
  const [prompt, setPrompt] = useState<{ url: string; top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (!("clipboardData" in event)) return false;
        const text = event.clipboardData?.getData("text/plain");
        if (!text || !isOnlyUrl(text)) return false;

        // Normalize to a full URL for the node.
        let url = text.trim();
        if (!url.includes("://")) url = `https://${url}`;

        // Position the choice bubble near the caret.
        let top = 0;
        let left = 0;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const anchorDom = editor.getElementByKey(selection.anchor.key);
            if (anchorDom) {
              const r = anchorDom.getBoundingClientRect();
              top = r.bottom + 4;
              left = r.left;
            }
          }
        });

        // Prevent the default paste and offer the choice.
        event.preventDefault();
        setPrompt({ url, top, left });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  // Close the choice bubble on outside click.
  useEffect(() => {
    if (!prompt) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setPrompt(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [prompt]);

  if (!prompt) return null;

  const insertLink = () => {
    editor.update(() => {
      const link = $createLinkNode(prompt.url);
      link.append($createTextNode(prompt.url));
      // $insertNodes inserts both, then places selection at the end (paragraph).
      $insertNodes([link, $createParagraphNode()]);
    });
    setPrompt(null);
  };

  const insertBookmark = () => {
    editor.update(() => {
      const node = $createWebBookmarkNode(prompt.url);
      $insertNodes([node, $createParagraphNode()]);
    });
    setPrompt(null);
  };

  return (
    <div ref={menuRef} className="bookmark-paste-menu" style={{ top: prompt.top, left: prompt.left }}>
      <div className="bookmark-paste-hint">粘贴了链接</div>
      <button className="bookmark-paste-opt primary" onClick={insertBookmark}>
        <span className="bpi-icon">🔗</span> 转换为网址书签
      </button>
      <button className="bookmark-paste-opt" onClick={insertLink}>
        保持链接形式
      </button>
    </div>
  );
}
