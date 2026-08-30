// Pure entitlement/gating logic (smoke-testable, no platform deps). Free tier
// gets a monthly allowance per AI capability; Pro is unlimited. This mirrors the
// monetization plan §9 "额度/门控占位" — real payment/license is a later step.

export type Aicap =
  | "vision" // 视觉识别（公式/页面 OCR）
  | "imagegen" // 文生图
  | "outline" // AI 一键目录
  | "pdf" // PDF 帮读 / 提问
  | "draft" // 内联 AI 起草
  | "semantic"; // 语义检索（embedding）

/** Monthly free allowance per capability (hard gate). 0 = not available on free. */
export const FREE_ALLOWANCE: Record<Aicap, number> = {
  vision: 5,
  imagegen: 3,
  outline: 3,
  pdf: 5,
  draft: 10,
  semantic: 50,
};

/** Pro is unlimited (until a real licensing server enforces more). */
export const PRO_LIMIT = -1;

/** True when a use of `cap` at `count` (cumulative this month) is allowed. */
export function isCapAllowed(cap: Aicap, count: number): boolean {
  const limit = FREE_ALLOWANCE[cap] ?? 0;
  // count is the total this month; allow while it's <= limit (last allowed use
  // is at count === limit).
  return count <= limit;
}

/** Human label for a capability, for the gating message. */
export function capLabel(cap: Aicap): string {
  const map: Record<Aicap, string> = {
    vision: "AI 视觉识别",
    imagegen: "AI 文生图",
    outline: "AI 一键目录",
    pdf: "PDF AI 帮读",
    draft: "内联 AI 起草",
    semantic: "AI 语义检索",
  };
  return map[cap];
}
