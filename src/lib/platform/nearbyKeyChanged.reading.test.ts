// ⭐ **P-3a（2026-10-13）**：⭐ **逐台"钥匙变了"** 那条读数的**接线判据** ✗（owner 承诺 R7 ✓）。
//
// ## 这条读数解决什么
// ⚠️ 今天只有**一条全局**读数（`trustState: Reading<TrustStateReading>` ✓，形状 `{state,message,active,pending}` ✓）
// ⇒ ⭐ **推不出逐台** ✗ —— 而承诺是「设备换了／**公钥变了**／撤销信任 ⇒ 都要重新配对」✓。
// ⚠️ 后端那半**已经成立** ✓（换公钥后签名验不过 ⇒ 401 ✓；且**没有任何一条路会自动登记公钥** ✓ ⇒ 登记一律经人 ✓）
// ⇒ ⭐ 缺的只是"界面能显示的那个状态" ✓ ⇒ 本片造**读数** ✓（⛔ 不碰界面 ✗ —— `SyncPanel.tsx` 归别人 ✓）。
//
// ## ⭐ 比的是哪两个字段（⭐ 明写，⛔ 不许猜 ✗）
// · **对面报的那一份** ＝ 公告里的 `pubkey`（`lan::LanAnnounce.pubkey` ✓；上抛在 `sync.rs:5730` ✓
//   ＝ `pubkey: p.announce.pubkey.trim().to_string()` ✓）；
// · **本机记的那一份** ＝ `mesh_paired_devices.pubkey`（读法 `db.rs:285 paired_pubkeys` 逐字
//   `SELECT device_id, pubkey FROM mesh_paired_devices WHERE space_id = ?1 AND TRIM(pubkey) <> ''` ✓；
//   写入是 `db.rs:274-277` 的 upsert ✓）。
// ⇒ 判定 ＝ 两边**都有**且**不相等** ⇒ "变了" ✓（`key_changed: true` ✓）。
//
// ## ⛔ 三条纪律（本片只到读数层）
// 1. ⭐ **可空 ＋ 有原因** ✗（"读不到就说读不到" ✓）：对面没报公钥（老对端 ✓）／本机册子里没记过
//    ⇒ ⛔ **绝不许默认成 `false`（"没变"）或 `true`（"变了"）** ✗ —— 那是拿一个**结论**冒充"读不到" ✓；
// 2. ⛔ **不参与任何判定** ✗（判定仍是 `serves_current` ✓；界面只许**显示** ✓）；
// 3. ⛔ **不动协议** ✗（`pairing.rs` 的 `deny_unknown_fields` ✓／`WIRE_VERSION` ✗）—— 这只是**本机读数** ✓。
//
// ⚠️ **本文件先红后绿**：写下它时 TS 侧那两个字段**都还没有** ✗ ⇒ ① 红 ✓（逐字见交接）；Rust 侧那两处当时也还没落地 ✗
//   —— ⭐ ② 的"改前红"**不用重跑也能核**（HEAD 那份 `sync.rs` 里那三个串的命中数都是 **0** ✓：
//   `key_changed` 0 ／ `no_record` 0 ／ `peer_no_key` 0 ✓）。
//   ⭐ 另有一条**锁**（今天已绿 ✓，⛔ 不是本片的修 ✗）：`serves_current` 仍旧**只**由 `lan::serves_space` 判 ✓。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");

/** `NearbyPeer` 那个 interface 的正文（到下一个顶层 `}` 为止 ✓）。 */
function nearbyPeerBody(): string {
  const ts = read("src/lib/platform/commands.ts");
  const start = ts.indexOf("export interface NearbyPeer");
  if (start < 0) throw new Error("commands.ts 里找不到 `export interface NearbyPeer`");
  const end = ts.indexOf("\n}", start);
  return ts.slice(start, end > start ? end : start + 4000);
}

const SYNC_RS = "src-tauri/src/sync.rs";

describe("P-3a：逐台「钥匙变了」读数（⛔ 只到读数层 ✗）", () => {
  it("① ⭐ TS 契约：`NearbyPeer` 必须有 `key_changed`（**可空** ✓）＋ `key_reason`（今天【红】：两个都没有 ✓）", () => {
    const body = nearbyPeerBody();
    expect(
      body,
      "⭐ 逐台「钥匙变了吗」那一格必须在**平台契约**里（`commands.ts` 的 `NearbyPeer` ✓）—— 今天【红】：没有这一格 ✗",
    ).toContain("key_changed");
    expect(
      body,
      "⛔ `key_changed` **不许写成 `boolean`（非空）** ✗ —— 读不到必须是**另一个值**（`null` ✓）：" +
        "「变了／没变」是**结论**，「读不到」是**没有结论** ✓，两件事长得必须不一样 ✓",
    ).toMatch(/key_changed\??:\s*boolean\s*\|\s*null/);
    expect(
      body,
      "⭐ 每一格都要带**原因**（与 `serves_reason` 同一口径 ✓）⇒ `key_reason: string` 必须在 ✓",
    ).toContain("key_reason");
  });

  it("②（**本片的一部分**，⛔ 不是锁 ✗）Rust 侧：读数由**本机册子**算 ⇒ 走 `paired_pubkeys` ✓ ＋ 保留「读不到」那两支", () => {
    const rs = read(SYNC_RS);
    expect(
      rs,
      "⭐ 比的那一份必须是**本机记的公钥** ⇒ 只许从 `db::paired_pubkeys` 读 ✓（⛔ 别自己另查一张表／另拼一份 ✗）",
    ).toContain("crate::db::paired_pubkeys(");
    expect(rs, "⭐ 逐台格 `key_changed` 要在那条上抛结构里 ✓").toContain("pub key_changed: Option<bool>");
    expect(
      rs,
      "⛔ 本机没记过时**不许**给一个真假值 ✗ ⇒ 必须留着 `no_record` 那一支（⭐ 读不到就说读不到 ✓）",
    ).toContain("no_record");
    expect(
      rs,
      "⛔ 对面没报公钥（老对端）时同样**不许**给真假值 ✗ ⇒ 留着 `peer_no_key` 那一支 ✓",
    ).toContain("peer_no_key");
  });

  it("③ 锁（今天已绿 ✓，⛔ 不是本片的修）：「服务不服务我」的判定**仍旧只有** `lan::serves_space`", () => {
    const rs = read(SYNC_RS);
    expect(
      rs,
      "⛔ 不许拿新加的「钥匙变了」去**参与判定** ✗（判定只有 `lan::serves_space` 一条 ✓ —— " +
        "界面/读数可以多说，判定不许被读数带着走 ✓）",
    ).toContain("serves_current: lan::serves_space(space_id, p)");
  });
});
