import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { pushOverlay } from "../lib/overlayStack";
import { peerIdentityLine } from "../lib/peerIdentity";
import { useMobileNav } from "../store/mobileNav";
import { useSpaceStore } from "../store/space";
import type { NearbyPeer } from "../lib/platform/commands";

/**
 * **移动端「设备配对 · 同步」屏**（效果图 `docs/plans/mobile/mockups/08-pair.svg`，规格 §4.8）。
 *
 * ⛔ **本屏是 v1「只读」那一半** ✗ —— 交付得到的两件：
 * ① **附近设备列表** ✓（每条「设备名 ＋ 短标识」✓，走 `peerIdentityLine` ✓）；
 * ② **如实同步状态** ✓（原样显示后端那句 `line` ✓）。
 *
 * ## ⛔ 硬口径（照 owner 2026-10-10 拍的去码化形状 ✓ / 规格 J14、J21 ✓）
 * · ⛔ **「点一下即可信任」本轮不做** ✗ —— `disabled` ＋ `title` 写明「未接」✓
 *   （原因：信任/配对的后端**尚未定形状** ✗ —— `secret` 从哪来、握手怎么走，那是**安全相关设计** ✓，
 *    已挂成待办等 win 那侧给形状 ✓；⛔ 我**没有**自造命令 ✗、也⛔ 不碰 `db::pair_device`／`secret_sha256` 那条线 ✓）。
 * · ⛔ **「逐台解除」同样明标未接** ✗（`MeshPairedDevice` 那侧**只有** `device_id ＋ added_at_ms` ✗
 *   没有名字 ⇒ 显示出来会说谎 ✗；⛔ 也**不加**那个"可空名字列" ✗ —— 它只对信任功能有意义，而信任这轮不做 ✓）。
 * · ⛔ **默认流程里零"码"类字样** ✗（规格 J14 逐字：出现「配对暗号」⇒ 红 ✗）⇒
 *   效果图 `08-pair.svg` 上那三行**整块废止** ✗，本屏**一个都不抄** ✓；
 *   ⛔ **也不设计"要用户念／填／比对"的交互** ✗。
 * · ⛔ **不读任何密钥／暗号进 UI** ✗（规格 §4.8 末条 ✓）。
 * · ⛔ **`device_id` 不进用户可见的句子** ✗ ⇒ 每次身份行都只喂 `(deviceName, shortId)` 两个参数 ✓
 *   （`peerIdentityLine` 的签名里**根本没有** `device_id` ✓ ⇒ 这是**结构上**的保证 ✓）。
 *
 * ⚠️ 同步状态那一段**只做转述** ✓：`kind` 按注释**只能拿它换标题** ✓（⛔ 不许按地址形状自己再判档 ✗，
 * 判据 ⑭ 钉的正是它 ✓）⇒ 所以这里**原样显示 `line`** ✓ ＋ 那几个读数 ✓。
 */
export function MobilePair() {
  // ⚠️ 一律**字段级选择器**（`check-store-subscriptions` 挡整店订阅 ✓）。
  const setScreen = useMobileNav((s) => s.setScreen);
  // 与 `SyncPanel` **同一个口径**：`api.lanStatus(activeId)` 是按空间查的 ✓（`SyncPanel.tsx:197` ✓）
  const activeId = useSpaceStore((s) => s.activeId);

  const [status, setStatus] = useState<{
    enabled: boolean;
    peers: number;
    kind: string;
    line: string;
    nearby: NearbyPeer[];
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /** 返回：回首页（与 03／04／10 同一处置 ✓，不新造第二种口径 ✓）。 */
  const goHome = useCallback(() => setScreen("home"), [setScreen]);

  // ⭐ 安卓返回键：直连返回栈底层（与其余几张移动屏同一处置 ✓）。
  useEffect(() => pushOverlay("mobile-pair", goHome), [goHome]);

  // 读数：一处取（`lan_status` ✓）—— ⛔ 不自己算"档位"、不按地址形状猜 ✗。
  useEffect(() => {
    let alive = true;
    api
      .lanStatus(activeId ?? null)
      .then((s) => {
        if (!alive) return;
        setStatus({ enabled: s.enabled, peers: s.peers, kind: s.kind, line: s.line, nearby: s.nearby ?? [] });
      })
      .catch((e) => {
        if (alive) setErr(String(e instanceof Error ? e.message : e).slice(0, 120));
      });
    return () => {
      alive = false;
    };
  }, [activeId]);

  const nearby = status?.nearby ?? [];

  return (
    <div className="main mpair" data-testid="mobile-pair">
      <header className="mpair-head">
        <button className="mpair-back" onClick={goHome} aria-label="返回首页">
          ‹
        </button>
        <span className="mpair-head-title">设备配对 · 同步</span>
      </header>

      <div className="mpair-scroll">
        {/* ② 如实同步状态：**原样显示后端那句 line** ✓ ＋ 三个读数 ✓ */}
        <section className="mpair-card">
          <div className="mpair-card-title">本机同步</div>
          {err ? (
            <p className="mpair-line">读不到同步状态：{err}</p>
          ) : !status ? (
            <p className="mpair-line mpair-dim">正在读取…</p>
          ) : (
            <>
              <p className="mpair-line">{status.line}</p>
              <p className="mpair-line mpair-dim">
                {status.enabled ? "附近发现：已开启" : "附近发现：未开启"}
                {` · 附近 ${status.peers} 台`}
              </p>
            </>
          )}
        </section>

        {/* ① 附近设备列表：每条「设备名 ＋ 短标识」✓（⛔ 不传 device_id ✓） */}
        <section className="mpair-card">
          <div className="mpair-card-title">附近设备</div>
          {!status ? (
            <p className="mpair-line mpair-dim">正在读取…</p>
          ) : nearby.length === 0 ? (
            <p className="mpair-line mpair-dim">这个网络里还没发现别的设备。</p>
          ) : (
            <ul className="mpair-list">
              {nearby.map((p, i) => (
                <li key={`${p.device_id}-${i}`} className="mpair-item">
                  <span className="mpair-item-main">
                    {/* ⭐ 「设备名 ＋ 短标识」；对端**没报**短标识 ⇒ 如实写「对方没报短标识」✓（⛔ 不回落 ✗） */}
                    <span className="mpair-item-who">{peerIdentityLine(p.device_name, p.short_id)}</span>
                    <span className="mpair-item-meta">
                      {p.serves_current ? "与当前空间相关" : "与当前空间无关"}
                      {p.invitable ? " · 可直接连接" : ""}
                    </span>
                  </span>
                  {/* ⛔ 信任/配对后端尚未定形状 ⇒ **明标未接** ✗（禁用 ＋ title 写原因 ✓，⛔ 不做假按钮 ✗） */}
                  <button
                    className="mpair-trust"
                    disabled
                    title="本屏未接：信任/配对的后端尚未定形状（`secret` 从哪来、握手怎么走还没定）—— 未做 ✗"
                  >
                    信任
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ④ 逐台解除：同样明标未接 ✓（那侧只有 device_id ＋ 时间，没有名字 ⇒ 显示会说谎 ✗） */}
        <section className="mpair-card">
          <div className="mpair-card-title">已配对的设备</div>
          <p className="mpair-line mpair-dim">
            本屏未接 ✗ —— 已配对列表那侧**只有设备标识与时间**，没有名字（规格要求显示"哪台"，⛔ 不许拿标识凑 ✗）。
          </p>
        </section>
      </div>
    </div>
  );
}
