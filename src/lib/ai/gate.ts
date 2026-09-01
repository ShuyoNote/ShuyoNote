// Thin helper to gate an AI capability at its call site. Consumes from the
// entitlements store and returns whether the call may proceed.
//
// 当前**不拦截**：用量只做统计，`ok` 恒为 true（见 `entitlements.ts` 的
// ENFORCE_QUOTA 与其中的原因说明）。保留这层薄封装，是为了将来真的提供托管
// 推理时，只改一处即可恢复门槛，而不必回头改六个调用点。
import { useEntitlements } from "../../store/entitlements";
import { capLabel, type Aicap } from "./entitlements";

export interface GateResult {
  ok: boolean;
  label: string;
  /** Error message to show when !ok. */
  message: string;
}

/** Attempt to consume one unit of `cap`. Returns ok + label (+ message if not). */
export function tryConsume(cap: Aicap): GateResult {
  const label = capLabel(cap);
  const ok = useEntitlements.getState().consume(cap);
  return {
    ok,
    label,
    // 不再提示「升级 Pro」——那是一个不存在的购买入口；真要收费也得先由我方
    // 承担推理成本。这里保留 message 字段供将来使用。
    message: ok ? "" : `${label}暂时不可用，请稍后再试。`,
  };
}

/** True when the user is on the Pro plan (unlimited AI). */
export function isPro(): boolean {
  return useEntitlements.getState().plan === "pro";
}
