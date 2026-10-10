/**
 * 「对方身份」那一行的**唯一实现** —— 信任前展示（规格 **J21**：「信任前必须展示对方的身份
 * （**设备名 ＋ 短标识**）」✓，08-c 的 08 屏用它 ✓）。
 *
 * ⛔ **只吃 `(deviceName, shortId)`** ✗ —— ⭐ **不接受 `device_id`** ✓。
 * 于是「**不许回落成设备号（或它的前几位／哈希）**」是**结构上**保证的 ✓
 * （它压根拿不到那个值 ✓），⛔ 不是靠"我们记得没这么写" ✗ —— 与后端 `new_short_id()`
 * 「不接受任何身份输入」用的是**同一把尺子** ✓。
 *
 * ⚠️ **两台一起升级的过渡期**：老对端发的公告里**没有**短标识这一格
 * （`LanAnnounce.short_id` 是 `#[serde(default)]` ✓ ⇒ 读到就是空串 ✓）⇒ 这里**如实**说
 * 「**对方没报短标识**」✓ —— ⭐ 这**不是降级处理** ✗，它正是那段过渡期的**正确答案** ✓
 * （`sync.rs` 的 `NearbyPeer::device_id` 注释逐字禁"拿 id 凑一格" ✓）。
 */
export function peerIdentityLine(deviceName: string, shortId: string): string {
  const sid = shortId.trim();
  // ⭐ 空 ⇒ **恰好**这句如实文案 ✓（⛔ 不回落 ✗、⛔ 不编一个 ✗）
  if (!sid) return "对方没报短标识";
  const name = deviceName.trim();
  // 名字也没报 ⇒ 只显示短标识（那仍然**可辨认** ✓，而且不含任何内部 id ✓）
  return name ? `${name} · ${sid}` : sid;
}
