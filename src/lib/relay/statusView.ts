// 中继那两格（图⑤「中继」／图⑧「中继许可证」）· **读数映射**（界面上唯一一处碰后端读数的地方）。
//
// ⭐ 这一层**刻意做得极薄**，因为 owner 的口径是「**数字必须来自后端读数**」✗：
//   · 那句人话（「已连上中继」／「剩余 N 天」／「已到期」／「读不到有效期」）**由 Rust 出** ✓
//     ⇒ 这里只**原样透传**，⛔ 一个字都不重算、⛔ 一天都不自己算 ✗；
//   · 这里唯一该做的事是**形状守门 ＋ 如实兜底**：后端没给读数（或形状坏了）时，
//     说"读不到"，⛔ 不许编 0 天 ✗、⛔ 不许把那格显示成"已连上" ✗。
//
// 判据：`src/lib/relay/statusView.test.ts`（含"数字与那句话打架时以**话**为准"这一条 ✓）。
import type { RelayStatus } from "../platform/commands";

/** 后端没给许可证读数时，界面**唯一**允许说的那句话（⛔ 不许换成任何带数字的说法 ✗）。 */
export const RELAY_UNREADABLE = "许可证状态未接线（读不到有效期）";

/** 后端没给连接读数时，界面**唯一**允许说的那句话（⛔ 不许说成"已连上" ✗）。 */
export const RELAY_CONNECTION_UNREADABLE = "未连上中继（读不到连接读数）";

export type RelayTone = "ok" | "warn" | "bad" | "muted";

export interface RelayStatusView {
  /** 这一档在当前平台能不能用（Web 版 false ⇒ 那一格说"不可用"）。 */
  available: boolean;
  /** 图⑤ 那句：「已连上中继」／「未连上中继…」（**后端原文** ✓）。 */
  connectionLabel: string;
  /** 连接那一格的补充原因（可空；中继给的原因原样在这儿 ✓）。 */
  connectionDetail: string;
  /** 图⑧ 那句：「剩余 27 天」／「已到期」／「读不到有效期」（**后端原文** ✓）。 */
  licenseLabel: string;
  /** 后端到底给没给许可证读数 ✓（false ⇒ 界面上那句一定是"读不到" ✓）。 */
  licenseReadable: boolean;
  /**
   * ⭐ 这一格的读数**从哪来的** ✗（⭐ 后端原文，⛔ 界面不自己判 ✓）：
   * `verified` ／ `refused` ／ `placeholder` ／ `unstated`（⭐ 后端没说 ⇒ 空串 ✓）。
   */
  licenseSource: string;
  /** ⭐ 拒收那一档的机器可读码（⭐ 其余档为空串 ✓）。 */
  licenseRefusal: string;
  /** 色调 —— ⚠️ 由后端的**状态字**决定，⛔ 不从天数算 ✗。 */
  tone: RelayTone;
  /** 后端附的一句说明（可空）。 */
  note: string;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 后端的三个字面量状态字 ⇒ 色调（⛔ 不看数字 ✗）。 */
function toneOf(licenseState: string, connectionState: string): RelayTone {
  if (licenseState === "ok") return "ok";
  if (licenseState === "grace") return "warn";
  if (licenseState === "expired") return "bad";
  // ⭐ 2026-10-11：⭐ 验不过 ⇒ ⭐ 与"已到期"同一档（⭐ 跨网就是不能用 ✓），
  //    ⛔ 但**不是**"读不到"（⭐ 后端明明给了拒收原因 ✓）
  if (licenseState === "refused") return "bad";
  if (licenseState === "not_yet" || licenseState === "missing") return "muted";
  return connectionState === "connected" ? "ok" : "muted";
}

/**
 * 后端读数 ⇒ 界面用的那份（**唯一**映射点 ✓）。
 *
 * ⚠️ `payload` 收 `unknown`：网络/契约出问题时它可能是 `null` 或形状坏掉的东西 ——
 * 那种情况下这一层**必须**给出"读不到"的说法，而不是抛异常、也不是编一个数 ✓。
 */
export function relayStatusView(payload: RelayStatus | null | undefined | unknown): RelayStatusView {
  const p = (payload ?? null) as Partial<RelayStatus> | null;
  const note = text((p as { note?: unknown } | null)?.note);

  // ① 这一档压根不可用（Web 版）：如实说 —— ⛔ 不许显示"已连上"、⛔ 不许显示天数 ✗
  if (!p || p.available !== true) {
    return {
      available: false,
      connectionLabel: "中继这一档在当前平台不可用",
      connectionDetail: "",
      licenseLabel: RELAY_UNREADABLE,
      licenseReadable: false,
      licenseSource: "",
      licenseRefusal: "",
      tone: "muted",
      note: note || "中继这一档在当前平台不可用（Web 版没有本地中继连接面）",
    };
  }

  const connectionState = text(p.connection?.state);
  const connectionLabel = text(p.connection?.label);
  const licenseState = text(p.license?.state);
  const licenseLabel = text(p.license?.label);

  return {
    available: true,
    // 后端给了就**原样**用；没给（形状坏了）⇒ 兜底也**只能**说"未连上" ✓
    connectionLabel: connectionLabel || RELAY_CONNECTION_UNREADABLE,
    connectionDetail: text(p.connection?.detail),
    // 后端给了就**原样**用（⛔ 不解析它、⛔ 不按 days_left 重算 ✗）；没给 ⇒ 明说读不到 ✓
    licenseLabel: licenseLabel || RELAY_UNREADABLE,
    licenseReadable: licenseLabel.length > 0 && licenseState !== "missing",
    // ⭐ 来源照抄后端（⭐ 形状坏了 ⇒ 空串：⛔ 不许猜成"验过了" ✗）
    licenseSource: text(p.license?.source),
    licenseRefusal: text(p.license?.refusal),
    tone: toneOf(licenseState, connectionState),
    note,
  };
}
