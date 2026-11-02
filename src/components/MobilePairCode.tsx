import { useCallback, useEffect, useState } from "react";
import { pushOverlay } from "../lib/overlayStack";
import { useMobileNav } from "../store/mobileNav";
import { platform } from "../lib/platform";
import { MESH_TRUST_BEGIN_COMMAND } from "../lib/trustDevicePanelReadings";
import { peerIdentityLine } from "../lib/peerIdentity";
import { useSpaceStore } from "../store/space";

/**
 * **移动端「首次配对」屏**（owner 2026-10-17 拍「甲」✓ ＋ 追加「完成配对相关功能」✓）。
 * 效果图：`docs/plans/mobile/mockups/2026-10-14-owner-mobile-reference.png` 右屏 ✓。
 *
 * ## ⭐⭐ **R176-A（2026-10-29，owner 拍）**：⭐ 屏上**不再有任何要人逐位比对的长串** ✗
 *   ⛔ 旧的「读那一串」那条路（`api.pairingCodeReading`）与「先开一轮」那条命令**整条撤掉** ✓
 *   ⇒ ⭐ 屏上只显示**对方的身份**：**设备名 ＋ 短标识** ✓ —— 唯一实现是
 *   [`peerIdentityLine`](../lib/peerIdentity.ts) ✓（⛔ 不自己拼 ✗、⛔ 不显示设备号 ✗）。
 *   ⚠️ 对端**没报短标识** ⇒ 唯一实现会如实说「对方没报短标识」✓（⛔ 不回落成设备号 ✗）。
 *
 * ## ⭐ 信任怎么成立：**两边各点一次「接入」、再各点一次「确认」** ✓
 *   ⛔ 没有"自动通过" ✗ —— 命令**只在人真的点了这颗按钮**时才发（见 `confirmTrust` ✓）。
 *
 * ## ⭐ 「确认」那一下真发命令（`mesh_trust_begin` ✓），且**守卫一条不松** ✗
 *   桌面那条 `trustDevice` 的**第一行**是 `if (!isDesktopPlatform()) { … return; }` ✓（安全设计 ✓）；
 *   本屏**不改它** ✗ —— 只**直接调同一条命令** ✓（`platform.executor.invoke` ✓，
 *   参数形状照 `SyncPanel.tsx` 的确认那一下抄 ✓：`{ spaceId, peerDeviceId, peerPubkey }` ✓）。
 *   ⚠️ 缺 `pubkey`／没有活动空间 ⇒ **如实报错、不发命令** ✓（见 `confirmTrust` ✓）。
 */
export function MobilePairCode() {
  const setScreen = useMobileNav((s) => s.setScreen);
  const cameFrom = useMobileNav((s) => s.cameFrom);
  const pairPeer = useMobileNav((s) => s.pairPeer);
  // ⭐ 活动空间（`spaceId` 的前置 ✓ —— ⛔ 空就不发命令 ✗）。
  const activeId = useSpaceStore((s) => s.activeId);
  const goBack = useCallback(() => setScreen(cameFrom ?? "pair"), [setScreen, cameFrom]);
  useEffect(() => pushOverlay("mobile-paircode", goBack), [goBack]);

  /**
   * ⭐ **只有人真的点了这颗按钮**才发命令 ✗（⛔ 不在挂载／effect 里自动发 ✗ ——
   *   与图上那句「**没有"自动通过"**」一致 ✓）。
   * ⚠️ 两条前置校验都**不发命令** ✗：没有活动空间 ✓／缺 `pubkey` ✓。
   * ⚠️ ⛔ 不碰 `SyncPanel.tsx` 那道 `isDesktopPlatform()` 守卫 ✗ —— 只是**调同一条命令** ✓（参数形状照
   *   `SyncPanel.tsx:1226` 抄 ✓：`{ spaceId, peerDeviceId, peerPubkey }` ✓，⛔ 不自创参数 ✗）。
   */
  const [busy, setBusy] = useState(false);
  const [errText, setErrText] = useState("");
  const confirmTrust = async () => {
    if (!pairPeer) return setErrText("没带着设备进来 ✗（回「设备直连」重选一台 ✓）");
    if (!activeId) return setErrText("没有活动空间 ✗ —— 先在桌面端选一个空间，再回来配对 ✓");
    if (!pairPeer.pubkey) return setErrText("这台设备还没报出身份（缺 pubkey）✗ —— 它需要这一版的程序，并且开过一次设备直连 ✓");
    setBusy(true);
    setErrText("");
    try {
      await platform.executor.invoke(MESH_TRUST_BEGIN_COMMAND, {
        spaceId: activeId,
        peerDeviceId: pairPeer.deviceId,
        peerPubkey: pairPeer.pubkey,
      });
      goBack(); // ⭐ 成功 ⇒ 回「设备直连」✓（`cameFrom` 那套 ✓，⛔ 不写死首页 ✗）
    } catch (e) {
      // ⚠️ 失败**如实显示** ✓（⛔ 不吞 ✗、⛔ 不假装成功 ✗）＋ 就地停在这屏 ✓（可重试 ✓）。
      setErrText(`建立信任失败：${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mshell mpair-code" data-testid="mobile-paircode">
      <header className="mpair-code-head">
        <button className="mpair-code-back" onClick={goBack} aria-label="返回">
          ‹
        </button>
        <span className="mpair-code-head-title">首次配对</span>
      </header>

      <div className="mpair-code-scroll">
        <p className="mpair-code-lead">🔒 只需一次 · 两边都点过「确认」才算建立信任</p>

        {/* ⚠️ 身份行走**唯一实现** ✓（⛔ 不自己拼 ✗、⛔ 不把设备号显示出来 ✗）。 */}
        <p
          className="mpair-code-caption"
          data-testid="mpair-device-identity"
          aria-label="对方的身份：设备名与短标识"
        >
          {pairPeer ? peerIdentityLine(pairPeer.deviceName, pairPeer.shortId) : "没带着设备进来"}
        </p>

        <p className="mpair-code-note">两台设备上各点一次「接入」，再各点一次「确认」就会通。</p>
        <p className="mpair-code-note">对不上就点「取消」—— 同一个网段里可能有别的设备。</p>

        <div className="mpair-code-actions">
          <button className="mpair-code-cancel" onClick={goBack}>
            取消
          </button>
          {/* ⭐ 真按钮 ✓ —— ⛔ 点之前**不发任何命令** ✗（⛔ 没有"自动通过" ✗）。 */}
          <button
            className="mpair-code-confirm"
            disabled={busy}
            data-testid="mpair-code-confirm"
            onClick={() => void confirmTrust()}
            title="就是这台，确认（会建立信任）"
          >
            {busy ? "正在建立信任…" : "就是这台，确认"}
          </button>
        </div>

        {errText ? (
          <p className="mpair-code-error" role="alert" data-testid="mpair-code-error">
            {errText}
          </p>
        ) : null}

        <p className="mpair-code-star">
          ★ 这一步没有"自动通过"：第一次必须由人点一下。
        </p>
      </div>
    </div>
  );
}
