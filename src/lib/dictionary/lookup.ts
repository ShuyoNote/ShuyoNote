// 划词查词 —— 前端侧（第一期：应用内划词 ＋ ECDICT 英汉）。
//
// ## 这一层**故意做得很薄**（只有三件事）
//
// 1. **值不值得发一次命令**（空白/纯标点直接不发）；
// 2. 把命令的三种状态映射成界面能直接渲染的东西（`presentOutcome`，**纯函数**）；
// 3. 把"命令失败"也归到 `unavailable` —— 命令面出错时**不许**静默空白。
//
// ⛔ 它**不判断**"这是不是中文词条""这个词该不该收" —— 那些是词典的事，
//    单一来源在 `src-tauri/src/dictionary.rs`（判据也在那边）。前端再判一遍 =
//    两份真相源，而"两份真相源"正是本仓花最多代价去消灭的东西。
//
// ## 为什么文案要"如实"（评估文档 §3-③/§3-④）
//
// ECDICT 是**英汉**词典 ⇒ "方法论"/"核聚变"这类中文术语**一定**查不到。
// 这时界面必须**明说**"未收录 ⇒ 可走 AI"，⛔ 不许静默空白、⛔ 不许编一个释义出来。
// `presentOutcome` 的那条不变量（`title` 与 `body` **不许同时为空**）由单测机器钉住，
// 见 `lookup.test.ts`。

import type {
  DictionaryLookupOutcome,
  DictionaryMissKind,
  DictionaryStatus,
} from "../platform/commands";

/** 执行后端命令的最小面（**注入**进来：单测不必起 Tauri，见 `lookup.test.ts`）。 */
export interface DictionaryInvoker {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

/** 未选中任何文本时界面显示的那句话（与 Rust 侧 `MissKind::Empty` 同一口径）。 */
export const EMPTY_SELECTION_MESSAGE = "没有选中文本 —— 划词查词不会凭空给释义。";

/** 选中文本的**规范化**（只做不会有歧义的事：去首尾空白）。
 *
 *  ⚠️ 刻意**不**在这里折叠大小写/去标点 —— 那两件在 Rust 侧做（`dictionary::normalize`），
 *  它们会影响"命中的是哪个词形"，属于词典口径，不该有两个实现。 */
export function normalizeSelection(raw: string): string {
  return raw.trim();
}

/** 有没有**可查的字符**（字母或数字）。
 *
 *  纯标点/纯空白（划词经常只选中一个逗号或一个空格）不值得发一次 IPC。
 *  ⚠️ 这里**不**判语言：中文术语照样发出去，由词典侧如实回答"英汉词典不含中文词条"。 */
export function hasLookupChars(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/** 查一次（返回的三种状态见 `DictionaryLookupOutcome`）。 */
export async function lookupWord(
  invoker: DictionaryInvoker,
  raw: string,
): Promise<DictionaryLookupOutcome> {
  const word = normalizeSelection(raw);
  if (!hasLookupChars(word)) {
    return { status: "not_found", query: word, kind: "empty", message: EMPTY_SELECTION_MESSAGE };
  }
  try {
    return await invoker.invoke<DictionaryLookupOutcome>("dictionary_lookup", { word });
  } catch (e) {
    // 命令面失败（没实现 / IPC 错 / 权限）**也是**一个必须说出来的状态。
    // ⛔ 不许因它变成空白浮层 —— 那与"编造"是同一类问题：用户以为查过了。
    return {
      status: "unavailable",
      message: `本地词典查询失败：${describeError(e)} ⇒ 这次**没查到**，不编造释义。`,
    };
  }
}

/** 词典状态读数（界面用它决定显不显示"本地词典"那一档）。 */
export async function dictionaryStatus(invoker: DictionaryInvoker): Promise<DictionaryStatus> {
  try {
    return await invoker.invoke<DictionaryStatus>("dictionary_status");
  } catch (e) {
    return {
      available: false,
      path: null,
      bytes: null,
      entries: null,
      source: null,
      verified: null,
      message: `读词典状态失败：${describeError(e)} ⇒ 按「未安装」处理，不假装查过。`,
    };
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/** 界面渲染用的形状（与具体 CSS 无关，便于单测）。 */
export interface LookupPresentation {
  /** `found` = 查到释义；`miss` = 词典在但没这条；`unavailable` = 词典不在/命令面失败。 */
  tone: "found" | "miss" | "unavailable";
  /** 浮层标题（⛔ 不许为空 —— 见文件头的不变量）。 */
  title: string;
  /** 正文：`found` 时是释义，其余是**后端那句人话**（原样显示，不加工）。 */
  body: string;
  /** 音标/词性这类小字（没有就是空串）。 */
  meta: string;
  /** 要不要显示"走 AI 解释"那个入口。
   *
   *  ⚠️ 只有"**有一个词值得解释**"时才为真：中文词条/未收录 ⇒ 真；
   *  "没选中"与"选太长"⇒ 假（前者没有对象，后者该先让用户缩小选择）。 */
  aiHint: boolean;
}

/** 未收录的那几类里，哪些值得给"走 AI"的入口。
 *
 *  纯函数（可单测）：把这条策略写在一处，⛔ 不要散在各个组件里各判一次。 */
export function aiHintForMiss(kind: DictionaryMissKind): boolean {
  return kind === "not_english" || kind === "not_found";
}

/** 把后端结果映射成界面形状。**纯函数** —— 这一层是"文案如实"的落点。 */
export function presentOutcome(outcome: DictionaryLookupOutcome): LookupPresentation {
  switch (outcome.status) {
    case "found": {
      const { entry } = outcome;
      // 释义优先中文译文（本词典的 `translation` 就是英汉释义）；没有译文才退到英文定义。
      // ⚠️ 两者都没有时**如实说"这条词条只有词形"** —— ⛔ 不许留空，那与"编造"是同一类问题
      //    （用户分不清"查到了但没内容"与"卡住了"）。
      const body =
        entry.translation ||
        entry.definition ||
        "（词典里这条词条只有词形，没有译文/定义 —— 如实显示，不补写。）";
      return {
        tone: "found",
        title: entry.word || outcome.query || outcome.matched,
        body,
        meta: [entry.phonetic, entry.pos].filter(Boolean).join(" · "),
        // 查到了也给"AI 深入解释"的入口 —— 但那不是"未收录"那档的事，这里保持一致：
        // 本期不做 AI 接线，留 false，别让界面出现一个按下去什么也不发生的按钮。
        aiHint: false,
      };
    }
    case "not_found":
      return {
        tone: "miss",
        title: outcome.query || "未收录",
        body: outcome.message,
        meta: "",
        aiHint: aiHintForMiss(outcome.kind),
      };
    case "unavailable":
      return {
        tone: "unavailable",
        title: "本地词典未就绪",
        body: outcome.message,
        meta: "",
        // 词典都没装，用户手上那个词仍可能值得解释 ⇒ 给入口，但由界面去提示"需配置 AI"。
        aiHint: true,
      };
  }
}
