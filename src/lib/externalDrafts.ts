// 外部（MCP）写请求送进来的**草稿**：谁来问用户、谁来落库。
//
// 这条线是 M2 的**用户侧承诺**（规格 §2 `INV-MCP-write-requires-confirm` ✓ ＋ owner 的 R87 ✓）：
//   · **默认**（免确认开关关着）⇒ 走**现成**的确认那条路（`confirmAndApplyDrafts` ✓，
//     AI 与插件用的同一份 ✓）—— 用户点「确定」才落库，拒绝就**什么都不写** ✓；
//   · **免确认**（开关开着）⇒ 不弹框直接落库 ✓，但**每一次写都要留痕**：
//     Rust 那侧已经写了审计行 ✓（谁／何时／什么能力／成败 ✓），这里再给用户一句**看得见**的话 ✓
//     （"没有留痕的免确认写不算实现" —— 那条话的用户侧形态就是这句 ✓）。
//
// 为什么把判断抽成纯函数（deps 注入 ✓）：判据要在 happ-dom 里真跑"弹框还是直接落库"这个**岔路** ✓，
// 而不是读源码猜 ✗（这条岔路要是选错了，要么用户被绕过、要么插件/AI 那条路被重复弹框 ✓）。
import { toast } from "../store/toast";
import { confirmAndApplyDrafts } from "./pluginDrafts";
import { applyDraftAndRefresh } from "./applyDraftAndRefresh";
import type { ApplyResult } from "./ai/apply";
import type { PluginDraft } from "../types";

/** Rust 推过来的那件事（`lib.rs` 的 `mcp:external-drafts` ✓）。 */
export interface ExternalDraftMessage {
  source: string;
  /** ⭐ 免确认开关的读数（Rust 那侧算好 ✓，前端**不自己判** ✗）。 */
  auto_apply: boolean;
  drafts: PluginDraft[];
}

/**
 * 解析事件载荷：Rust 发的是 `{ source, payload }`，其中 `payload` 是**一段 JSON 文本** ✓
 * （内含 `{source, auto_apply, drafts}` ✓）；也容忍直接把对象发过来 ✓。
 * 解不出来 ⇒ 返回 `null`（调用方**如实**说一句 ✓，⛔ 不静默吞 ✗）。
 */
export function parseExternalDraftsEvent(raw: unknown): ExternalDraftMessage | null {
  const pick = (v: unknown): ExternalDraftMessage | null => {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o.payload === "string") {
      try {
        return pick(JSON.parse(o.payload));
      } catch {
        return null;
      }
    }
    if (Array.isArray(o.drafts)) {
      return {
        source: typeof o.source === "string" ? o.source : "外部 AI",
        auto_apply: o.auto_apply === true,
        drafts: o.drafts as PluginDraft[],
      };
    }
    return null;
  };
  return pick(raw);
}

/** 注入点（判据用假的 ✓）。 */
export interface ExternalDraftDeps {
  confirmAndApply: (source: string, drafts: PluginDraft[]) => Promise<string>;
  applyOne: (payload: unknown) => Promise<ApplyResult>;
  notify: (message: string, kind: "success" | "info" | "error") => void;
}

export function defaultExternalDraftDeps(): ExternalDraftDeps {
  return {
    confirmAndApply: confirmAndApplyDrafts,
    applyOne: applyDraftAndRefresh,
    notify: toast,
  };
}

/**
 * 处理一条外部草稿事件：**默认问用户，免确认直接落** ✓。返回一句给人看的结果 ✓。
 */
export async function handleExternalDraftsEvent(
  raw: unknown,
  deps: ExternalDraftDeps = defaultExternalDraftDeps(),
): Promise<string> {
  const msg = parseExternalDraftsEvent(raw);
  if (!msg || msg.drafts.length === 0) {
    // 解不出来就是解不出来：说一句，别装作处理过了 ✓
    deps.notify("收到一条看不懂的外部改动通知（已忽略）", "error");
    return "";
  }

  if (!msg.auto_apply) {
    // ① 默认岔路：走**现成**的确认（AI 与插件同一条 ✓）
    return deps.confirmAndApply(msg.source, msg.drafts);
  }

  // ② 免确认岔路：直接落库 ✓，但**逐个**给出结果 ＋ 一句汇总（看得见的留痕 ✓）
  const applied: string[] = [];
  for (const d of msg.drafts) {
    try {
      const r = await deps.applyOne(d.payload);
      applied.push(r.ok ? `✓ ${d.summary}` : `✗ ${d.summary}：${r.message}`);
    } catch (e) {
      applied.push(`✗ ${d.summary}：${String(e)}`);
    }
  }
  const okCount = applied.filter((s) => s.startsWith("✓")).length;
  deps.notify(
    `外部 AI 直接写入 ${okCount}/${msg.drafts.length} 项（${msg.source}）：${applied.join("；")}`,
    okCount === msg.drafts.length ? "success" : "error",
  );
  return applied.join("；");
}
