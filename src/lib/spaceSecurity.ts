// 「这个空间加密了吗」那个**标识**的唯一映射处（`task-27`：owner 2026-10-10「加密空间要做个特殊标识」）。
//
// ⭐ 语义**只有这一条**（`WorkspaceMeta.encrypted_on_disk`）：
//   `true` ＝ 这个空间的**库在磁盘上是密文** ✓ ／ `false` ＝ 明文 ／ `undefined`／`null` ＝ **读不到**。
// ⛔ **不许**把它写成「安全」「别人的看不到」那种话 ✗ —— 那是另一回事（还有"口令在不在钥匙袋里"
//    `in_keyring`／"本会话拿不拿得到钥匙" `key_available` 两件**不同**的事）；
//    ⛔ 也**不许**把三者揉成一句话 ✗（今天已经栽过"一个字段两种说法"✓）。
// ⛔ 也**不许**只靠颜色 ✗（色弱用户看不到）⇒ 标识里必须有**文字** ✓。
//
// ⚠️ 三态**别用 `!x` 一把判** ✗：`undefined`（读不到）与 `false`（确认是明文）**不一样** ——
//   两者都"不显示标识"，但**原因不同** ⇒ 这里把原因也返回出来（`state`），别让下游再猜一次 ✓。
//
// ⚠️ 判定规则（"怎么算密文"）**不在这里**：它是 Rust `crate::security::space_db_is_encrypted`
//   （只读文件头 16 字节 ✓，与 `space_security_overview` 的 `encrypted_on_disk` **同源**）——
//   本模块只管"这一格读数 ⇒ 界面上说什么" ✓。

export type SpaceCryptoState = "encrypted" | "plaintext" | "unknown";

export interface SpaceCryptoBadge {
  /** 这一格读数**是什么**（⚠️ `unknown` ≠ `plaintext` ✓）。 */
  state: SpaceCryptoState;
  /** 要不要显示那个标识 ✓。 */
  show: boolean;
  /** 标识上的**文字**（⛔ 不许只靠颜色 ✗；不显示时是空串 ✓）。 */
  label: string;
  /** 悬停／读屏那句话（不显示时是空串 ✓）。 */
  title: string;
}

/**
 * `WorkspaceMeta.encrypted_on_disk` ⇒ 界面上的那个标识 ✓（**唯一**一处映射）。
 *
 * ⚠️ 三种输入各自落到哪：
 * · `true`            ⇒ 显示「已加密」✓
 * · `false`           ⇒ **不显示**（确认是明文 ✓）
 * · `undefined`/`null` ⇒ **不显示**，且 `state` 是 `"unknown"` ✓（⛔ 不许当成明文 ✗）
 * · 形状坏了（例如 `"true"` 这种字符串）⇒ **也按 unknown** ✓（fail-closed：宁可不显示 ✓）
 */
export function spaceCryptoBadge(encryptedOnDisk: boolean | null | undefined): SpaceCryptoBadge {
  if (encryptedOnDisk === true) {
    return {
      state: "encrypted",
      show: true,
      label: "已加密",
      // ⚠️ 这句只说**磁盘上是什么**（可核的那件事）✗，不说"安全"、不说"看不到" ✓
      title: "这个空间的数据库在磁盘上以密文存储",
    };
  }
  return {
    state: encryptedOnDisk === false ? "plaintext" : "unknown",
    show: false,
    label: "",
    title: "",
  };
}
