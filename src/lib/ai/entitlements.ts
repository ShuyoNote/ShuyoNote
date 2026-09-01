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

/**
 * 每能力的月度用量**仅作统计**，不再作为硬门槛。
 *
 * 原因（2026-09-01 决策）：AI 推理成本**不在我们这边**——用户自带本地 Ollama
 * 或自己的 OpenAI 兼容密钥。既然不代付算力，就没有理由限制用户使用自己的钥匙；
 * 何况当时的 `plan` 只存 localStorage、改一行即为 Pro，提示还指向一个并不存在
 * 的购买入口。**等真的提供托管推理（我方承担成本）时，再把门槛打开。**
 *
 * 保留这张表与 `isCapAllowed` 的结构，是为了那一天不必重写调用点。
 */
export const FREE_ALLOWANCE: Record<Aicap, number> = {
  vision: 5,
  imagegen: 3,
  outline: 3,
  pdf: 5,
  draft: 10,
  semantic: 50,
};

/** 是否启用硬门槛。当前为 false：自带密钥不限额。 */
export const ENFORCE_QUOTA = false;

/** Pro is unlimited (until a real licensing server enforces more). */
export const PRO_LIMIT = -1;

/** True when a use of `cap` at `count` (cumulative this month) is allowed. */
export function isCapAllowed(cap: Aicap, count: number): boolean {
  if (!ENFORCE_QUOTA) return true;
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
