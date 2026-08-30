// Thin helper to gate an AI capability at its call site. Consumes from the
// entitlements store and returns whether the call may proceed, plus a human
// label for the "升级 Pro" message. Keeps call sites one line.
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
    message: ok ? "" : `免费额度已用完（${label}）。升级 Pro 可继续使用。`,
  };
}

/** True when the user is on the Pro plan (unlimited AI). */
export function isPro(): boolean {
  return useEntitlements.getState().plan === "pro";
}
