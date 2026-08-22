import { useEffect, useState } from "react";
import { $getNodeByKey, $getRoot, $isElementNode, type LexicalEditor, type LexicalNode } from "lexical";
import { $isHeadingNode } from "@lexical/rich-text";
import { useEditorStore } from "../store/editor";

// Page table of contents: lists the page's heading outline (h1–h6, indented by
// level) in a right-hand toggle panel. Clicking an entry scrolls to the heading
// and selects it. Headings are re-collected live as the editor changes.

interface TocItem {
  key: string;
  text: string;
  level: number;
}

function collectHeadings(node: LexicalNode, out: TocItem[]) {
  if ($isHeadingNode(node)) {
    const tag = node.getTag();
    const level = Number(String(tag).replace(/^h/, "")) || 1;
    const text = node.getTextContent().trim();
    if (text) out.push({ key: node.getKey(), text, level });
  }
  if ($isElementNode(node)) {
    for (const c of node.getChildren()) collectHeadings(c, out);
  }
}

function readOutline(editor: LexicalEditor): TocItem[] {
  const out: TocItem[] = [];
  editor.getEditorState().read(() => {
    for (const c of $getRoot().getChildren()) collectHeadings(c, out);
  });
  return out;
}

export function TableOfContents() {
  const editor = useEditorStore((s) => s.editor);
  const [items, setItems] = useState<TocItem[]>([]);
  const [open, setOpen] = useState(true);
  const [active, setActive] = useState<string | null>(null);

  // Collect the heading outline live as the editor changes.
  useEffect(() => {
    if (!editor) return;
    const update = () => setItems(readOutline(editor));
    update();
    return editor.registerUpdateListener(update);
  }, [editor]);

  // Follow scroll: highlight the heading of the section currently at the top of
  // the editor scroll container (GitHub-style).
  useEffect(() => {
    if (!editor) return;
    const rootEl = editor.getRootElement();
    const scrollEl =
      (rootEl?.closest?.(".editor-shell") as HTMLElement | null) ??
      (rootEl?.parentElement as HTMLElement | null) ??
      null;
    if (!scrollEl) return;

    const onScroll = () => {
      const viewportTop = scrollEl.getBoundingClientRect().top;
      let act = items[0]?.key ?? null;
      for (const it of items) {
        const el = editor.getElementByKey(it.key);
        if (el && el.getBoundingClientRect().top <= viewportTop + 48) act = it.key;
      }
      setActive(act);
    };
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, [editor, items]);

  if (!editor) return null;

  const goto = (key: string) => {
    editor.update(() => {
      const node = $getNodeByKey(key);
      if (node && node.isAttached()) node.selectStart();
    });
    const el = editor.getElementByKey(key);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(key);
  };

  return (
    <>
      <button
        className={`toc-toggle ${open ? "open" : ""}`}
        title="目录"
        onClick={() => setOpen((v) => !v)}
      >
        📑
      </button>
      {open && (
        <div className="toc-panel">
          <div className="toc-head">
            <span className="toc-title">目录</span>
            <button className="toc-close" onClick={() => setOpen(false)} title="关闭">
              ×
            </button>
          </div>
          <div className="toc-list">
            {items.length === 0 ? (
              <div className="toc-empty">暂无标题</div>
            ) : (
              items.map((it) => (
                <button
                  key={it.key}
                  className={`toc-item ${active === it.key ? "active" : ""}`}
                  style={{ paddingLeft: `${(it.level - 1) * 12 + 4}px` }}
                  onClick={() => goto(it.key)}
                  title={it.text}
                >
                  {it.text}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}
