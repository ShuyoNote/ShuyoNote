import { useCallback, useEffect } from "react";
import { pushOverlay } from "../lib/overlayStack";
import { useMobileNav } from "../store/mobileNav";

/**
 * **移动端「首次配对」屏 · d1 骨架**（owner 2026-10-17 拍「甲」✓ —— 效果图见
 * `docs/plans/mobile/mockups/2026-10-14-owner-mobile-reference.png` 右屏 ✓）。
 *
 * ## ⛔ 本刀**只做骨架**（如实标注 ✓，⛔ 不假装能用 ✗）
 * · ✅ **屏可到** ✓：从「设备直连」那两颗入口（接入／重新配对 ✓）带着 peer 打开 ✓；
 * · ⛔ **对码未接** ✗：20 格 · 5 组 × 4 位 · 竖排 5 行 —— ⭐ 那 20 格要等 **d2** ✓；
 * · ⛔ **不发任何 api** ✗：码**只许**来自 `api.pairingCodeReading({ peerDeviceId, peerPubkey })` ✓
 *   （`src/lib/api.ts:524` ✓，⭐ **后端算** ✓ ⇒ ⛔ 前端不许自己算码 ✗）；
 *   且 `code: null` ⇒ ⭐ **如实显示 `reason`** ✗（⛔ 不渲染空格子冒充码 ✗）；
 * · ⛔ **不建立信任** ✗：⭐ `SyncPanel` 里 `trustDevice` 第一行就是
 *   `if (!isDesktopPlatform()) { toast("信任设备要在桌面端操作"); return; }` ✓
 *   ⇒ ⭐ **那道守卫不许松动** ✗（安全设计 ✓）；手机上的可信路径是"**人对 20 位码点一下**"✓（d2 ✓）。
 *
 * ⚠️ 【取消】**是真的** ✓：回**来处** ✓（`cameFrom` ✓ —— ⛔ 不写死回首页 ✗）。
 */
export function MobilePairCode() {
  const setScreen = useMobileNav((s) => s.setScreen);
  const cameFrom = useMobileNav((s) => s.cameFrom);
  // ⚠️ 只读它来确认"带着哪一台进来的" ✓（⛔ 本轮不用它做任何请求 ✗）。
  const pairPeer = useMobileNav((s) => s.pairPeer);
  // ⚠️ 兜底回「设备直连」✓（这屏本来就只从那里进 ✓）—— ⛔ 不写死回首页 ✗。
  const goBack = useCallback(() => setScreen(cameFrom ?? "pair"), [setScreen, cameFrom]);
  useEffect(() => pushOverlay("mobile-paircode", goBack), [goBack]);

  return (
    <div className="mshell mpair-code" data-testid="mobile-paircode">
      <header className="mpair-code-head">
        <button className="mpair-code-back" onClick={goBack} aria-label="返回">
          ‹
        </button>
        <span className="mpair-code-head-title">首次配对</span>
      </header>

      <div className="mpair-code-scroll">
        <p className="mpair-code-lead">👋 只需一次 · 两台显示同一串码</p>

        {/**
         * ⛔ **明标未接** ✗（照 08 屏 v1 的老规矩 ✓）：这一格将来显示 **20 位码（5 组 × 4 位 · 竖排 5 行）** ✓，
         * 现在**禁用** ＋ `title` 写清原因 ✓ —— ⛔ 不放一个假码／空格子冒充"已接"✗。
         */}
        <div
          className="mpair-code-pending"
          aria-disabled="true"
          data-testid="mpair-code-pending"
          title="对码还没接：码要走 api.pairingCodeReading（后端算），下一刀接上 —— 未做 ✗"
        >
          <span className="mpair-code-pending-title">对码未接</span>
          <span className="mpair-code-pending-sub">
            这一格将显示 20 位码（5 组 × 4 位 · 竖排 5 行）—— 下一刀接后端 ✓
          </span>
          {pairPeer ? <span className="mpair-code-pending-peer">已带着一台设备进来 ✓</span> : null}
        </div>

        <button className="mpair-code-cancel" onClick={goBack}>
          取消
        </button>
      </div>
    </div>
  );
}
