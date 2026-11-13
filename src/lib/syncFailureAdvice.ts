// U3 片 3 扩展（2026-11-13）：**失败行的一句话建议 ＋ 动作** —— 纯函数，唯一实现。
//
// 契约（docs/plans/2026-11-12-u3-failure-recovery-contract.md C2/C3）：
//   · 每条失败给一句人话「下一步」＋ 一个**已存在**的入口（手动重试 / 打开连接体检 / 复制诊断 / 去配对）；
//   · ⛔ 不新造执行路径、⛔ 不出现裸设备号、⛔ 文案不许把"身份类"写成"网络问题"；
//   · 分类规则**必须与 Rust 的自动重试判定同源**：`src-tauri/src/lan_state.rs` 的
//     `auto_retryable()` 里 IDENTITY / TRANSIENT 两组标记；本文件的 MARKER 列表由判据
//     `syncFailureAdvice.test.ts` **逐条对照 Rust 源码**（改一边不改另一边 ⇒ 判据红）。
//
// ⚠️ 顺序即语义：**身份类先判**（即使文案里同时出现"超时"也不许当网络类）。

export type FailureTone = "none" | "network" | "identity" | "locked" | "space" | "unknown";
/** 只能映射到**已有**入口（契约 C3）。 */
export type FailureAction = "retry" | "diagnose" | "pair" | null;

export interface SyncFailureAdvice {
  tone: FailureTone;
  /** 这一条失败**是否可能自己好**（与 Rust `auto_retryable` 同义）。 */
  retriable: boolean;
  /** 一句人话「下一步」（界面直接显示；⛔ 不出现内部标识/设备号）。 */
  oneLiner: string;
  /** 建议的按钮：只能取已存在入口；`null` = 只给文案。 */
  action: FailureAction;
}

/** 身份类标记 —— ⚠️ 必须与 `src-tauri/src/lan_state.rs::auto_retryable` 的 IDENTITY 逐条一致。 */
export const IDENTITY_MARKERS = [
  "401",
  "没被信任过",
  "没有登记过这台设备的公钥",
  "已被移出",
  "已被逐台解除",
  "没配对过",
  "还没配对过",
  "不匹配",
  "锁着",
] as const;

/** 网络/环境类标记 —— ⚠️ 必须与 `src-tauri/src/lan_state.rs::auto_retryable` 的 TRANSIENT 逐条一致。 */
export const TRANSIENT_MARKERS = [
  "timeout",
  "超时",
  "连接被拒",
  "connection refused",
  "connection reset",
  "error sending request",
  "端口被占",
  "地址已被占用",
] as const;

const has = (s: string, list: readonly string[]) => list.some((m) => s.includes(m));

/** 一条失败原文 ⇒ 一句话建议 ＋ 动作（纯函数；空/非失败 ⇒ tone "none"）。 */
export function syncFailureAdvice(message: string | null | undefined): SyncFailureAdvice {
  const s = String(message ?? "").trim();
  if (!s) {
    return { tone: "none", retriable: false, oneLiner: "", action: null };
  }

  // ① 身份类：先判（顺序即语义；"超时 + 401" 仍算身份类）
  if (has(s, IDENTITY_MARKERS)) {
    if (s.includes("锁着")) {
      return {
        tone: "locked",
        retriable: false,
        oneLiner: "对方的空间锁着：先在那台设备上解锁，再回来重试",
        action: "diagnose",
      };
    }
    if (s.includes("不匹配")) {
      return {
        tone: "space",
        retriable: false,
        oneLiner: "两台设备打开的不是同一个空间：先核对空间，再重试",
        action: "diagnose",
      };
    }
    return {
      tone: "identity",
      retriable: false,
      oneLiner: "对面不再信任这台设备（可能被移出，或还没配对过）：去配对/邀请一次",
      action: "pair",
    };
  }

  // ② 网络/环境类：可能自己好
  if (has(s, TRANSIENT_MARKERS)) {
    return {
      tone: "network",
      retriable: true,
      oneLiner: "网络这一刻没通（多半会自己好）：可以先手动重试，或等自动重试",
      action: "retry",
    };
  }

  // ③ 未知：先拿读数，再决定要不要重试（⛔ 不瞎猜）
  return {
    tone: "unknown",
    retriable: false,
    oneLiner: "这轮没成（原因见下面原文）：先打开连接体检/复制诊断，再决定是否重试",
    action: "diagnose",
  };
}
