// 租约自动续：**用手里那张卡**向发卡站换一张新的短期租约，并写进中继配置。
//
// 为什么需要它：中继只认 ≤30 天租约；租约到期后 `relay_probe` 只会报 "missing/expired"，
// 不会自己去换。用户卡还有一年，跨网却先停了 —— 2026-10-23 实测到的断点。
//
// 三条边界：
// ① 只在**本机有卡**且**发卡站地址已配**时才会发请求（否则如实返回原因，⛔ 不抛异常炸面板）；
// ② 换回来的租约**先验签再落盘**由 `license_apply_lease` 做（Rust 侧），这里不自己写文件；
// ③ 只换租约，⛔ 不动卡（卡的有效期只能由付费换卡延长）。
import { api } from "../api";
import { parseCard, pickCurrent } from "./card";
import { readCards } from "./cardStore";
import { nowTs, renewBytes } from "./signedBytes";

export type LeaseRefresh =
  | { ok: true; leaseExp: number }
  | { ok: false; reason: string };

/** 手里**当前生效**的那张卡（与许可证面板同一个 pickCurrent 口径）。 */
export function currentCardText(): string | null {
  const parsed = readCards()
    .map((c) => ({ text: c.text, parsed: parseCard(c.text) }))
    .filter(
      (x): x is { text: string; parsed: Extract<ReturnType<typeof parseCard>, { ok: true }> } => x.parsed.ok,
    )
    .map((x) => ({ ...x.parsed, text: x.text }));
  const current = pickCurrent(parsed);
  return current ? current.text : null;
}

/** 换一张 29 天租约（失败时给一句人话，⛔ 不抛）。 */
export async function refreshLease(): Promise<LeaseRefresh> {
  try {
    const issuer = await api.licenseIssuerReady();
    if (!issuer.ready) return { ok: false, reason: issuer.why || "没配发卡站地址" };

    const card = currentCardText();
    if (!card) return { ok: false, reason: "本机没有可续期的许可证" };

    const id = await api.licenseDevice();
    const ts = nowTs();
    const sig = await api.licenseSign(renewBytes(card, id.dev, ts));

    const res = await api.licenseHttpRequest({
      method: "POST",
      path: "/v1/renew",
      headers: [["content-type", "application/json"]],
      body: JSON.stringify({ card, dev: id.dev, ts, sig }),
    });
    if (res.status !== 200) return { ok: false, reason: `发卡站回了 HTTP ${res.status}` };

    let json: { lease?: string };
    try {
      json = JSON.parse(res.body) as { lease?: string };
    } catch {
      return { ok: false, reason: "续期响应读不懂" };
    }
    if (!json.lease) return { ok: false, reason: "续期响应里没有租约" };

    // ⚠️ 落盘前由 Rust 侧 `relay_license::verify_lease` 验签 + 对设备位
    const applied = await api.licenseApplyLease(json.lease);
    return { ok: true, leaseExp: applied.leaseExp };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
