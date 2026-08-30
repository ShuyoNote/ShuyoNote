import { create } from "zustand";
import type { Aicap } from "../lib/ai/entitlements";
import { isCapAllowed } from "../lib/ai/entitlements";

// Local-first entitlement stub (S9 of the monetization plan). No real payment /
// license validation yet — a placeholder so the UI can gate AI capabilities and
// surface an "升级 Pro" prompt. Free users get a small monthly allowance; Pro
// users are unlimited until a real licensing server exists.
const PLAN_KEY = "shuyonote.entitlement.plan";
const USAGE_KEY = "shuyonote.entitlement.usage";

export type Plan = "free" | "pro";

export interface UsageRecord {
  /** ISO month bucket, e.g. "2026-08". Resets the count each month. */
  month: string;
  cap: Aicap;
  count: number;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function loadPlan(): Plan {
  try {
    return localStorage.getItem(PLAN_KEY) === "pro" ? "pro" : "free";
  } catch {
    return "free";
  }
}

function loadUsage(): UsageRecord[] {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveUsage(u: UsageRecord[]) {
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(u));
  } catch {
    // ignore
  }
}

interface EntitlementsState {
  plan: Plan;
  usage: UsageRecord[];
  setPlan: (plan: Plan) => void;
  /** Record one use of a capability and return true if it was allowed. */
  consume: (cap: Aicap) => boolean;
}

export const useEntitlements = create<EntitlementsState>((set, get) => ({
  plan: loadPlan(),
  usage: loadUsage(),

  setPlan: (plan) => {
    try {
      localStorage.setItem(PLAN_KEY, plan);
    } catch {
      // ignore
    }
    set({ plan });
  },

  consume: (cap) => {
    const { plan, usage } = get();
    if (plan === "pro") return true; // unlimited until a real backend exists
    // Free: allowed but recorded; hard-block only when over the cap.
    const month = currentMonth();
    const rec = usage.find((u) => u.month === month && u.cap === cap);
    const count = (rec?.count ?? 0) + 1;
    const next = { month, cap, count };
    const usageNext = [
      ...usage.filter((u) => !(u.month === month && u.cap === cap)),
      next,
    ];
    saveUsage(usageNext);
    set({ usage: usageNext });
    return isCapAllowed(cap, count);
  },
}));
