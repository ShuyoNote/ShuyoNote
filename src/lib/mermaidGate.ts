// mermaid 的**串行闸门** —— 全应用唯一一条渲染通道。
//
// ⚠️ 为什么要有它（owner 2026-10-06：「**开发版没有错误，正式版有**」✗）：
//   `mermaid.initialize()` 与 `mermaid.render()` 动的是**同一个模块级全局状态** ✗。
//   而这套代码里有**三处**渲染入口（编辑器图块 `MermaidNode`、md 预览 `mdMermaid`、
//   绘图弹窗 `DrawingEditorModal`）✓，编辑器里**一屏能有十几个图块** ✓（owner 那篇实测 12 个 ✓），
//   每个图块的 effect 都会 `initialize()` ＋ `render()` ✓。
//
//   ⭐ 两个构建的差别正在这里 ✓：
//     · **开发版**：`import("mermaid")`（动态）与 `import mermaid from "mermaid"`（静态）在 Vite 的
//       开发模块图里**可能是两份实例** ✓ ⇒ 各初始化各的、互不干扰 ⇒ **看不出问题** ✓；
//     · **正式版**：`vite.config.ts` 开了 `inlineDynamicImports: true` ✓ ⇒ 动态 import 被**内联**、
//       全局只剩**一个** mermaid 实例 ✗ ⇒ 十几个 `initialize()/render()` **同时开跑** ✓，
//       全局状态互相覆盖 ⇒ 抛错 ✓；这错还是从 **Lexical 的 decorator** 里抛出来的 ✓
//       ⇒ 被 Lexical 接住、报成 `Minified Lexical error #335` ✗ —— 编号与正文对不上，就是这么来的 ✓。
//
//   ⇒ 修法：**所有** mermaid 渲染都过这一道闸门 ✓ ——
//     ① 初始化**按主题一次** ✓（主题变了才重来 ✓，mermaid 换主题必须重新 initialize ✓）；
//     ② 渲染**串行** ✓（同一时刻只跑一个 render ✓ —— 图多的时候慢一点，但不再打架 ✓）。
//
//   ⚠️ 这是**纯逻辑**（mermaid 实例由调用方传进来 ✓）：本文件不 import mermaid ✗
//      ⇒ 判据可以在 Node 里用假件真跑 ✓（见 `mermaidGate.test.ts` ✓）。

export interface MermaidGate {
  /** 把一次"初始化（按需）＋ 渲染"排进队列 ✓；返回渲染结果 ✓，错误原样抛给调用方 ✓。 */
  run<T>(theme: string, init: (theme: string) => void, render: () => Promise<T>): Promise<T>;
  /** 仅供判据 / 排错看：当前已初始化的主题（没初始化过 ⇒ null ✓）。 */
  readyTheme: () => string | null;
  /** 仅供判据：还排在队里没跑完的个数（含正在跑的那个 ✓）。 */
  pending: () => number;
}

export function createMermaidGate(): MermaidGate {
  let readyTheme: string | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  /**
   * ⭐ 2026-10-07（owner：「在**时间复盘**点击条目跳转，卡死」✗）：
   * **每次渲染前先把控制权还给浏览器一次** ✓。
   *
   * 为什么：mermaid 的布局（dagre）是**同步 CPU 活** ✓，一张图几百毫秒 ✓。
   * 一页十几张图连着跑 ⇒ 主线程被连续占满 ⇒ 用户看到的就是"窗口卡死" ✗
   *（点复盘条目跳到那种笔记最容易撞上：编辑器一挂载，十几个图块同时排队 ✓，
   *  而这道闸门刻意让它们**一个接一个** ✓ ⇒ 卡顿被拉成"一段一段" ✓）。
   *
   * `setTimeout(0)` 让浏览器有机会**画一帧、处理输入** ✓ ⇒ 从"整段卡死"变成
   * "图一张张出现、窗口始终能点" ✓。⛔ 它**不减少**总 CPU（渲染本身仍是同步的 ✗，
   *    真正的解是"离屏不渲染"，那是另一笔 ✓）。
   */
  const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  return {
    run(theme, init, render) {
      pending += 1;
      const task = tail.then(async () => {
        await yieldToBrowser(); // ← 见上面那段：先还一帧给浏览器 ✓
        // ① 初始化：没初始化过、或主题变了 ⇒ 来一次 ✓（同一主题绝不重复 initialize ✓）
        if (readyTheme !== theme) {
          init(theme);
          readyTheme = theme;
        }
        // ② 渲染：在队列里跑 ⇒ 同一时刻只有一个 ✓
        return render();
      });
      // ⛔ 一次失败**不许把队列卡死** ✗：`tail` 只用来排队，错误已经原样抛给调用方了 ✓。
      tail = task.then(
        () => undefined,
        () => undefined,
      );
      // 完事（不管成败）都减一个 ✓
      const done = () => {
        pending -= 1;
      };
      task.then(done, done);
      return task;
    },
    readyTheme: () => readyTheme,
    pending: () => pending,
  };
}

/**
 * **全应用唯一那一个**闸门 ✓。
 *
 * ⚠️ 三处入口必须共用这**同一份** ✗ —— 各建各的等于没建 ✓（那正是"两份实例看不出来"的翻版 ✓）。
 */
export const mermaidGate = createMermaidGate();
