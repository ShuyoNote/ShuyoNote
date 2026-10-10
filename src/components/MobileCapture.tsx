import { useEffect, useRef, useState } from "react";
import { markdownToPageContent } from "../lib/mdPreview";
import { pushOverlay } from "../lib/overlayStack";
import { useNotes } from "../store/notes";
import { useMobileNav } from "../store/mobileNav";

/**
 * **快速记录**（效果图 `docs/plans/mobile/mockups/02-capture.svg`，规格 §4.2）。
 *
 * 照规格逐条 ✓：
 * - 输入区 ＋ **键盘上方的快捷工具栏 6 项**（段落／标题／列表／待办／引用／图片 ✓）＋ 主按钮「存」✓
 * - 草稿态写明「**草稿保存在本机 · 无需登录**」✓
 * - 落库走**仓里现成的那一层构造器**（`markdownToPageContent()` ✓）⇒ 本文件**不直接碰**
 *   页面内容的两个字段 ✗（`check-doc-content-access` 连注释里的字样都算 ✓，所以这里刻意不写它们 ✓），
 *   且**一次调用写完**（教训 1／§7.4 ✓）——
 *   即 `markdownToPageContent()` ＋ `createPage(null, content)` **一次**调用 ✓，⛔ 不拆成"先建页再写内容"两次 ✗。
 * - 与桌面端的差别：桌面是块编辑器全功能；本屏只做「记一条」✓。
 *
 * ⚠️ 如实标注（不许编 ✗）：
 * - 效果图里那行「分段： 拍摄现场」在**说明书与需求文档里都查不到** ✗（`grep 分段` 零命中 ✓）
 *   ⇒ 那是**效果图的美术装饰**，我**不发明**这个功能 ✗（等 owner 说它是什么再补 ✓）。
 * - 「图片」按钮：本屏先只往文本里插 Markdown 图片语法 ✓，⛔ 还没接系统相册／文件选择器 ✗。
 * - 工具栏按效果图钉在**底部**：`index.html` 的 viewport 带了
 *   `interactive-widget=resizes-content` ✓ ⇒ 软键盘弹出时内容区会缩短 ✓
 *   ⇒ 底部这条自然就落在**键盘上方** ✓（这正是效果图要的位置 ✓）。
 */
const BAR = [
  { id: "p", label: "段落", insert: "\n" },
  { id: "h", label: "标题", insert: "## " },
  { id: "ul", label: "列表", insert: "- " },
  { id: "todo", label: "待办", insert: "- [ ] " },
  { id: "quote", label: "引用", insert: "> " },
  { id: "img", label: "图片", insert: "![]()" },
] as const;

export function MobileCapture() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const createPage = useNotes((s) => s.createPage);
  const setScreen = useMobileNav((s) => s.setScreen);

  // ⭐ **安卓返回键**（实测真事故 ✗）：这一屏刚做出来时，在它上面按返回键**直接退出了整个应用** ✗
  //   （截图停在了系统 launcher ✓）。仓库早有桥 —— `installBackBridge()` 定义
  //   `window.__SHUYONOTE_BACK__`（`src/main.tsx:26` ✓），栈空时壳层才退出应用 ✓。
  //   ⚠️ 这里**不用** `useOverlayLayer()` ✗：那条路要求把 id 登记进
  //   `verify-mobile-overlays.mjs` 的 `OVERLAYS` 清单 ✓，而那份清单会在**每个视口**打开它 ✓ ——
  //   可本屏只在手机档渲染（`useMobile()` ⇒ innerWidth ≤ 768 ✓）⇒ 塞进去会造**假红** ✗。
  //   ⇒ 直连**同一套返回栈**的底层 API `pushOverlay(id, close)`（`src/lib/overlayStack.ts:47` ✓）
  //   ✓：返回键 ⇒ 回首页 ✓（不是退出应用 ✓），且**不冒充浮层** ✓。
  useEffect(() => pushOverlay("mobile-capture", () => setScreen("home")), [setScreen]);

  /** 在光标处插入工具栏那一小段（并在插完后把光标放到新位置 ✓）。 */
  function insert(snippet: string) {
    const el = areaRef.current;
    if (!el) {
      setText((t) => t + snippet);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = el.value.slice(0, start) + snippet + el.value.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + snippet.length;
      el.setSelectionRange(pos, pos);
    });
  }

  /** 「存」：**一次调用写完** ✓（`markdownToPageContent` ⇒ `createPage` ✓）。 */
  async function save() {
    if (busy) return;
    const content = markdownToPageContent(text);
    if (!content) {
      setErr("先写一句再存 ✓");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // 标题取第一行（去掉 Markdown 前缀），与「记一条」的直觉一致 ✓
      const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
      const title = firstLine.replace(/^[#>\-\s\[\]x]*/i, "").trim().slice(0, 60);
      // ⭐ 关键：**传 `{ select: false }`** ✓ —— 默认的 `createPage` 会"选中新页 ＋
      //   切回笔记视图" ✗，于是手机档会**落进桌面编辑器**，而那个屏按返回键**直接退出应用** ✗，
      //   重启还回编辑器 ✗、抽屉里也没有「首页」✗ ⇒ **除 `pm clear` 没有回首页的路** ✗
      //   （这是队友逐屏审计实测出来的，见 `_workspace/notes/2026-10-10-mobile-screen-audit.md` ✓）。
      //   不选中 ⇒ 存完**留在首页** ✓，新笔记自己出现在「最近笔记」第一行 ✓（这就是确认 ✓）。
      await createPage(null, { ...content, title }, { select: false });
      // ⭐ 2026-10-10 第二次修（第一次只加 `select: false` **不够** ✗，实拍复核仍在编辑器 ✗）：
      //   真因是 `src/store/notes.ts:139` 那段"**恢复上次那一页**"的 effect ✓ ——
      //   `createPage` 存完会 `loadPages()` ✓，而 `lastPageId` 已是刚存那页 ⇒ 它又把页面打开了 ✗。
      //   ⇒ 这里**显式清掉当前页** ✓（不依赖对那段 effect 的猜测 ✓）：
      //   `currentId === null` ⇒ `App.tsx` 的手机分支才会渲染 `MobileHome` ✓。
      //   ⚠️ 用 `setState` 而不是新加 store 方法：`useNotes` 是 zustand store ✓，`currentId`／`current`
      //   是它自己的状态字段 ✓（`notes.ts:96` 初始值就是这两个 ✓），改它们不引入新 API ✓。
      useNotes.setState({ currentId: null, current: null });
      setScreen("home");
      setText("");
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e).slice(0, 120));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="main mcap" data-testid="mobile-capture">
      <header className="mcap-head">
        <h1 className="mcap-title">快速记录</h1>
        <button className="mcap-save" onClick={() => void save()} disabled={busy}>
          {busy ? "存…" : "存"}
        </button>
      </header>

      <textarea
        ref={areaRef}
        className="mcap-area"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="想一句就记一句…"
        autoFocus
        rows={8}
        aria-label="快速记录输入区"
      />

      {err && <div className="mcap-err">{err}</div>}

      <p className="mcap-hint">草稿保存在本机 · 无需登录</p>

      {/* 键盘上方的快捷工具栏（6 项 ✓，与效果图同一组词 ✓） */}
      <div className="mcap-bar" role="toolbar" aria-label="快捷工具栏">
        {BAR.map((b) => (
          <button key={b.id} className="mcap-bar-btn" onClick={() => insert(b.insert)}>
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}
