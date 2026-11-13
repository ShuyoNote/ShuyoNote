// U4 片 1（2026-11-13，owner 拍 D1=B / D2=A / D3=A / D4=A）：
// **冲突裁决的建议与差异摘要 —— 纯函数，唯一实现。**
//
// 纪律（契约 C1/C2/C3/C5）：
//   · 差异只给**摘要 ＋ ≤40 字短片段**（D1=B）——⛔ 不把正文整段搬进来；
//   · 只有**安全情形**给推荐（D2=A）：一边没改／两边都是纯追加且不重叠；
//   · 两边都改且互相覆盖 ⇒ **两难**（`ask`），⛔ 不替人猜；
//   · 推荐必须带**一句规则推出的理由**（D4=A）。
//
// ⚠️ 调用方传进来的 `localSnippet` / `remoteSnippet` 必须**已经裁到 ≤ SNIPPET_MAX**（或原样短文本），
//   本模块再裁一次兜底；⛔ 不要传整段正文 —— 本模块没有能力从整段里"只取一点"而不读它。

/** 片段上限（owner D1=B：≤40 字）。超过则截断并加省略号。 */
export const SNIPPET_MAX = 40;

export type ConflictBlockType = "paragraph" | "heading" | "list" | "code" | "other";

export interface ConflictSide {
  /** 这一侧是否改过（调用方按修订/哈希判断，⛔ 不在这里比较正文）。 */
  changed: boolean;
  /** 改动量级：字符数（区间/粗略值即可；调用方给）。 */
  chars: number;
  /** 改动量级：行数。 */
  lines: number;
}

export interface ConflictShape {
  blockType: ConflictBlockType;
  local: ConflictSide;
  remote: ConflictSide;
  /** 两边是否都是"只追加、没有删除/覆盖"（调用方算）。 */
  appendOnly: boolean;
  /** 两边的改动是否落在同一区域（调用方算）。 */
  overlap: boolean;
  /** 识别用短片段（≤ SNIPPET_MAX 字；本模块会再裁）。 */
  localSnippet: string;
  remoteSnippet: string;
}

export type ConflictChoice = "local" | "remote" | "merge" | "ask";

export interface ConflictAdvice {
  choice: ConflictChoice;
  /** 一句人话理由（规则推出，⛔ 不编）。 */
  reason: string;
  /** 真两难（两边都改且互相覆盖）——界面必须**问人**，⛔ 不自动裁。 */
  twoWayTie: boolean;
}

const BLOCK_LABEL: Record<ConflictBlockType, string> = {
  paragraph: "段落",
  heading: "标题",
  list: "列表",
  code: "代码块",
  other: "块",
};

/** 裁短片段（超长截断 + `…`）。 */
export function clipSnippet(text: string, max: number = SNIPPET_MAX): string {
  const s = String(text ?? "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/** 推荐哪个选择 + 一句理由（D2=A：只对安全情形给推荐；两难 ⇒ ask）。 */
export function conflictAdvice(shape: ConflictShape): ConflictAdvice {
  const localChanged = !!shape.local.changed;
  const remoteChanged = !!shape.remote.changed;

  if (!localChanged && !remoteChanged) {
    return { choice: "local", reason: "两边都没有实际改动 ⇒ 保留本地这一版", twoWayTie: false };
  }
  if (!localChanged && remoteChanged) {
    return { choice: "remote", reason: "只有远端改过 ⇒ 用远端这一版", twoWayTie: false };
  }
  if (localChanged && !remoteChanged) {
    return { choice: "local", reason: "只有本地改过 ⇒ 用本地这一版", twoWayTie: false };
  }
  // 两边都改过：
  if (shape.appendOnly && !shape.overlap) {
    return {
      choice: "merge",
      reason: "两边都是纯追加、且不重叠 ⇒ 合并（两边都保留）",
      twoWayTie: false,
    };
  }
  return {
    choice: "ask",
    reason: "两边都改过同一块且互相覆盖 ⇒ 这是真两难，请你选",
    twoWayTie: true,
  };
}

/**
 * 差异摘要（给界面显示）：块类型 ＋ 哪边改过 ＋ 量级 ＋ 追加/覆盖 ＋ ≤40 字片段。
 *
 * ⛔ 红线：只允许出现**短片段**，不许把正文整段搬进来（契约 C1；判据用"夹具正文反例"钉）。
 */
export function conflictSummary(shape: ConflictShape): string {
  const side = (label: string, s: ConflictSide) =>
    s.changed ? `${label}改（${s.chars} 字 / ${s.lines} 行）` : `${label}未改`;
  const kind = shape.appendOnly ? "纯追加" : "含覆盖";
  const mine = clipSnippet(shape.localSnippet);
  const theirs = clipSnippet(shape.remoteSnippet);
  return [
    BLOCK_LABEL[shape.blockType],
    side("本地", shape.local),
    side("远端", shape.remote),
    kind,
    `本地片段：${mine || "（空）"}`,
    `远端片段：${theirs || "（空）"}`,
  ].join(" ｜ ");
}
