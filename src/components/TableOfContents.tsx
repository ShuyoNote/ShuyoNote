import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { $getNodeByKey, $getRoot, $isElementNode, type LexicalEditor, type LexicalNode } from "lexical";
import { $isHeadingNode } from "@lexical/rich-text";
import { useEditorStore } from "../store/editor";
import { useRightPanel } from "../store/rightPanel";
import { useViewStore, clampTocWidth, TOC_W_DEFAULT, TOC_W_MAX, TOC_W_MIN } from "../store/view";
import { useOverlayLayer } from "../hooks/useOverlayLayer";

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
  const open = useRightPanel((s) => s.toc);
  // ⛔ 这里**故意不锁滚动**（2026-10-02，owner：「目录打开不能影响页面内容阅览和滚动」）。
  //    原来这里有一句 `useOverlayScrollLock(open)` —— 那个 hook 是给**模态**用的
  //    （它自己的注释：「只要有任意一个浮层开着，外壳就是锁的」），而**目录是侧栏** ✓
  //    ⇒ 后果是：开着目录时正文**滚不动** ✗（读到一半想往前翻却发现滚轮没反应）。
  //    ⚠️ 目录面板自己的长列表照旧能滚：`.toc-list { flex: 1; overflow-y: auto }` ✓。 */
  // Android 返回键：优先关掉最上层浮层（见 lib/overlayStack.ts）。
  useOverlayLayer("toc", open, () => useRightPanel.getState().openToc(false));
  const setOpen = useRightPanel((s) => s.openToc);
  const [active, setActive] = useState<string | null>(null);
  // ⭐ 目录宽度（2026-10-02 owner：「并排停靠 ＋ 鼠标拖拽调宽」）—— 存在 view store 里 ✓（与内容宽度同一套 ✓）。
  const tocWidth = useViewStore((s) => s.tocWidth);
  const setTocWidth = useViewStore((s) => s.setTocWidth);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  // ⭐ 2026-10-02（owner 给了参考图）：目录**并排停靠** —— 正文在左、目录在右、互不覆盖 ✓。
  //    宽度写进 CSS 变量 `--toc-w`，两侧一起读它（`.toc-panel { width: var(--toc-w) }` ✓
  //    ＋ `body.is-toc-open .main { padding-right: var(--toc-w) }` ✓）⇒ 拖动时两边**同步** ✓。
  //    ⚠️ 更正我上一轮的读法：owner 先前那句「不能影响阅览」我读成了"别重排正文" ✗，
  //       其实指的是"**别盖住正文**" ✓ —— 参考图里正是并排 ✓。
  //    ⚠️ 滚动**仍然不锁** ✓（上面那条 `useOverlayScrollLock` 保持删除状态 ✓）。
  useEffect(() => {
    document.documentElement.style.setProperty("--toc-w", `${tocWidth}px`);
    document.body.classList.toggle("is-toc-open", open);
    return () => document.body.classList.remove("is-toc-open");
  }, [open, tocWidth]);

  /** 拖拽把手：指针按下 ⇒ 记录起点；移动 ⇒ 按"指针左移＝目录变宽"换算（目录在右边 ✓）。 */
  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { startX: e.clientX, startW: tocWidth };
    document.body.classList.add("is-toc-resizing");
    setDragging(true);
  };
  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setTocWidth(clampTocWidth(d.startW + (d.startX - e.clientX)));
  };
  const onResizeUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    document.body.classList.remove("is-toc-resizing");
    setDragging(false);
  };
  /** 键盘也能调（读屏/无鼠标时用 ✓）：←/→ 各 16px；Home 回默认 ✓。 */
  const onResizeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowLeft") setTocWidth(clampTocWidth(tocWidth + step));
    else if (e.key === "ArrowRight") setTocWidth(clampTocWidth(tocWidth - step));
    else if (e.key === "Home") setTocWidth(TOC_W_DEFAULT);
    else return;
    e.preventDefault();
  };

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
      <div className={`toc-panel ${open ? "open" : ""}`}>
        {/* ⭐ 拖拽把手（2026-10-02）：贴在左缘 ✓。用 `role="separator"` ＋ aria-value*，
            读屏能读出"可调的竖直分隔条" ✓；双击/Home 恢复默认宽度 ✓。 */}
        <div
          className={`toc-resizer${dragging ? " is-dragging" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整目录宽度"
          aria-valuenow={tocWidth}
          aria-valuemin={TOC_W_MIN}
          aria-valuemax={TOC_W_MAX}
          tabIndex={0}
          title="拖动调整目录宽度（双击恢复默认）"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          onDoubleClick={() => setTocWidth(TOC_W_DEFAULT)}
          onKeyDown={onResizeKey}
        />
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
                style={{ paddingLeft: `${(it.level - 1) * 12 + 12}px` }}
                onClick={() => goto(it.key)}
                title={it.text}
              >
                {it.text}
              </button>
            ))
          )}
        </div>
      </div>
    </>
  );
}
