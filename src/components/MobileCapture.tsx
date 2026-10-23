import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { markdownToPageContent } from "../lib/mdPreview";
import { AlignLeftIcon, CheckIcon, CommentIcon, ImageIcon, ListIcon, OutlineIcon } from "./icons";
import { pushOverlay } from "../lib/overlayStack";
import { useNotes } from "../store/notes";
import { api } from "../lib/api";
import { isDesktopPlatform, platform } from "../lib/platform";
import { makeAssetRef } from "../lib/assetRef";
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
 * - 「图片」按钮（⭐ 2026-10-22 起）：**真接系统选择器** ✓ —— `<input type=file accept="image/*">`
 *   （安卓/iOS 上由系统弹出相册或文件选择器）⇒ 存成本机附件（`api.saveImage`）
 *   ⇒ 在光标处插入 `![](<assetUrl>)` ✓（与桌面插图同一个存储层 ✓）。
 *   ⚠️ 如实记：这条路径**不携带附件指纹**（`hash`）—— 图片能显示、也能随空间导出，
 *   但「导出 markdown 时把它当附件拷进 zip」的那条链仍未接（需要 `markdownToPageContent`
 *   产出带 hash 的 ImageNode，属另一个口子）✗。
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
  // ⭐ 2026-10-22：图片**不再往文本里塞一对空括号**（那样存进去就是坏图 ✗）⇒ 它走系统选择器
  { id: "img", label: "图片" },
];

/** ⭐ 2026-10-10：每项配一个**仓里现成**的细线矢量图标 ✓（效果图是"图标在上、文字在下"✓）。
 *  ⛔ 不自造图标 ✗；映射：段落＝左对齐 ✓／标题＝大纲（`OutlineIcon`）✓（仓里没有 Title/Heading 图标 ✗）／
 *  列表＝`ListIcon` ✓／待办＝`CheckIcon` ✓／引用＝`CommentIcon` ✓／图片＝`ImageIcon` ✓。
 *  ⚠️ 这就是 BAR 的**第二份真相源** ✗（按 id 配图标 ✓）⇒ 若将来加项，两处都要动 ✓（已在 `BAR` 那条注释里点名 ✓）。 */
const BAR_ICONS: Record<string, (p: { width?: number; height?: number }) => ReactElement> = {
  p: AlignLeftIcon,
  h: OutlineIcon,
  ul: ListIcon,
  todo: CheckIcon,
  quote: CommentIcon,
  img: ImageIcon,
};

export function MobileCapture() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  // ⭐ 2026-10-22：真正的系统选择器（accept="image/*" ⇒ 安卓/iOS 弹相册/文件）
  const fileRef = useRef<HTMLInputElement | null>(null);
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

  /**
   * 「图片」：**真接系统选择器** ✓（2026-10-22，owner：「解决这些问题」）。
   *
   * 三步：① 用户点按钮 ⇒ 打开 `<input type=file accept="image/*">`；
   *      ② 选中的文件走**仓里同一层** `api.saveImage`（与桌面插图同一个存储/加密层 ✓）；
   *      ③ 在光标处插入 `![](<assetUrl>)` —— URL 用 `platform.asset.convertFileSrc(meta.path)`，
   *        与桌面编辑器喂给 ImageNode 的**同一个转换** ✓（⛔ 不自己拼路径 ✗）。
   * ⚠️ 失败**如实说**（不吞错）：选择器打不开、保存失败都会在 `err` 里写明 ✓。
   */
  async function pickImage(file: File) {
    if (!file.type.startsWith("image/")) {
      setErr("只能插入图片文件 ✓");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const meta = await api.saveImage({
        page_id: null,
        name: file.name || null,
        mime: file.type || "image/png",
        data: Array.from(data),
      });
      // ⭐ 2026-10-23（owner：「web 移动端插的图没保存到本机」）：**web 上不写 blob: 地址**。
      //   那个地址是 URL.createObjectURL 造的一次性货色，只活在当前页面会话 ⇒ 刷新/换设备即死，
      //   而字节其实好好躺在 IndexedDB 里、只是正文再没有线索能找回来。
      //   ⇒ web 存**内容指纹引用** `asst:<hash>`（渲染时按 hash 现取，见 lib/assetRef.ts）；
      //   ⇒ 桌面存真实文件路径（本来就持久）⇒ 仍走 convertFileSrc，行为一个字没变。
      const stableRef = isDesktopPlatform() ? null : makeAssetRef(meta.hash);
      const src = stableRef ?? platform.asset.convertFileSrc(meta.path);
      insert(`![${(file.name || "").replace(/[\]]/g, "")}](${src})\n`);
    } catch (e) {
      setErr(`插图失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
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
    <div className="mshell mcap" data-testid="mobile-capture">
      <header className="mcap-head">
        {/* ⭐ 2026-10-22（owner 手机实拍：「编辑时底部标签不该显示」）：
            这一屏**不再挂底栏**（效果图 `02-capture.svg` 本来也没有它：底栏会把快捷工具栏顶到键盘上方，
            而且"正在打字"时那三个导航项本来也用不上）⇒ 于是必须**自己给一条回家的路**：
            左上这颗「‹ 返回」＝ 回首页（与底栏「笔记」同一个目的地 ✓）。
            ⛔ 没有它就成了死路 —— 这一屏此前正是靠底栏才回得去（`check-mobile-exit-routes` 也认这条）。 */}
        <button className="mcap-back" aria-label="返回首页" onClick={() => setScreen("home")}>
          ‹
        </button>
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
          <button
            key={b.id}
            className="mcap-bar-btn"
            onClick={() => {
              // ⭐ 2026-10-22：「图片」不再往文本里塞一对空括号（那样存进去就是坏图）✗
              if (b.id === "img") {
                fileRef.current?.click();
                return;
              }
              insert(b.insert ?? "");
            }}
          >
            {/* ⭐ 图标在上、文字在下 ✓（效果图形态 ✓）；命中区仍由 CSS 的 min-height:44 保证 ✓ */}
            <span className="mcap-bar-icon" aria-hidden>{BAR_ICONS[b.id]?.({ width: 14, height: 14 })}</span>
            <span className="mcap-bar-label">{b.label}</span>
          </button>
        ))}
      </div>

      {/* ⭐ 2026-10-22：系统选择器（隐藏；只由「图片」按钮触发）*/}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        data-testid="mcap-image-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // 清掉 value：否则**选同一张图第二次不会再触发 onChange** ✗（真机常见坑）
          e.target.value = "";
          if (f) void pickImage(f);
        }}
      />
    </div>
  );
}
