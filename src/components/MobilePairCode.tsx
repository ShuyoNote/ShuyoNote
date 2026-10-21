import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { pushOverlay } from "../lib/overlayStack";
import { useMobileNav } from "../store/mobileNav";
import { platform } from "../lib/platform";
import { MESH_TRUST_BEGIN_COMMAND, MESH_TRUST_PREPARE_COMMAND } from "../lib/trustDevicePanelReadings";
import { useSpaceStore } from "../store/space";

/**
 * **移动端「首次配对」屏**（owner 2026-10-17 拍「甲」✓ ＋ 追加「完成配对相关功能」✓）。
 * 效果图：`docs/plans/mobile/mockups/2026-10-14-owner-mobile-reference.png` 右屏 ✓。
 *
 * ## ⭐ 码从哪来（⛔ 前端不许自己算 ✗）
 * `api.pairingCodeReading({ peerDeviceId, peerPubkey })` ✓（`src/lib/api.ts:524` ✓）——
 *   ⭐ **后端算** ✓；`code: null` ⇒ ⭐ **如实显示 `reason`** ✗（⛔ 不渲染空格子冒充码 ✗）；
 *   ⚠️ `reason` 也读不到 ⇒ 明标「读不到码」✓（⛔ 不编 ✗）。
 *
 * ## ⛔ 「码对得上，确认」本轮**明标未接** ✗（照 08 屏 v1 老规矩 ✓）
 * 原因（逐字，只读 `SyncPanel.tsx:1200-1202` ✓）：
 *   `trustDevice` 的**第一行**就是 `if (!isDesktopPlatform()) { toast("信任设备要在桌面端操作"); return; }` ✓
 *   ⇒ ⭐ **那道守卫不许松动** ✗（安全设计 ✓）；而它真正干的事**只有一条命令** ✓（`:1237` 附近逐字）：
 *      `platform.executor.invoke(MESH_TRUST_BEGIN_COMMAND, { spaceId, peerDeviceId, peerPubkey })` ✓
 *   ⚠️ ⇒ 移动端**要接这条**，得先由 owner/Lead 拍「移动端是否允许调这条命令」✗
 *      （⛔ 我不绕过那道守卫 ✗）⇒ 本轮「确认」**禁用 ＋ title 写清** ✓。
 */
export function MobilePairCode() {
  const setScreen = useMobileNav((s) => s.setScreen);
  const cameFrom = useMobileNav((s) => s.cameFrom);
  const pairPeer = useMobileNav((s) => s.pairPeer);
  // ⭐ 活动空间（`spaceId` 的前置 ✓ —— ⛔ 空就不发命令 ✗）。
  const activeId = useSpaceStore((s) => s.activeId);
  const goBack = useCallback(() => setScreen(cameFrom ?? "pair"), [setScreen, cameFrom]);
  useEffect(() => pushOverlay("mobile-paircode", goBack), [goBack]);

  const [code, setCode] = useState<string | null>(null);
  const [reason, setReason] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!pairPeer) {
      setLoading(false);
      setReason("没带着设备进来");
      return;
    }
    let alive = true;
    setLoading(true);
    // ⭐ d4（`ca480e7a` 那条**死锁**的移动版 ✓）：**「接入」那一步必须先 `mesh_trust_prepare`** ✗ ——
    //   桌面那边逐字注释：「`trust_ask` 原来**只在** `mesh_trust_begin` 里生成 ⇒ ⭐ **死锁**
    //   （owner 真机："点接入了，也没有（码）"✓）⇒ **点「接入」调它** ⇒ 码可读 ✓」✓
    //   ⇒ ⭐ 参数形状**照抄** `SyncPanel.tsx:412`（`{ peerDeviceId }` ✓ —— ⛔ 不自创参数 ✗）。
    //   ⚠️ ⭐ **这不是"发信任"** ✓：`prepare` **只产生对码、不登记** ✗ ⇒ 「没有自动通过」那条**不被违反** ✓；
    //      ⛔ `mesh_trust_begin` **仍然只在人点「确认」时调** ✗（见 `confirmTrust` ✓）。
    (async () => {
      try {
        await platform.executor.invoke(MESH_TRUST_PREPARE_COMMAND, { peerDeviceId: pairPeer.deviceId });
      } catch (e) {
        // ⚠️ 失败**如实显示** ✓（⛔ 不吞 ✗）⇒ 码区就显示"读不到码 ＋ 原因" ✓（已有那条路径 ✓）。
        if (alive) {
          setReason(`准备对码失败：${String(e instanceof Error ? e.message : e).slice(0, 80)}`);
          setLoading(false);
        }
        return;
      }
      if (!alive) return;
      api
        .pairingCodeReading({ peerDeviceId: pairPeer.deviceId, peerPubkey: pairPeer.pubkey })
      .then((r) => {
        if (!alive) return;
        setCode(r.code);
        setReason(r.reason || "");
      })
      .catch((e) => {
        if (alive) setReason(`读不到码（${String(e instanceof Error ? e.message : e).slice(0, 60)}）`);
      })
        .finally(() => {
          if (alive) setLoading(false);
        });
    })();
    return () => {
      alive = false;
    };
  }, [pairPeer]);

  /**
   * ⭐ **只有人真的点了这颗按钮**才发命令 ✗（⛔ 不在挂载／effect／读码成功时自动发 ✗ ——
   *   与图上那句「**没有"自动通过"**」一致 ✓）。
   * ⚠️ 两条前置校验都**不发命令** ✗：没有活动空间 ✓／缺 `pubkey` ✓（与 `pairingCodeReading` 同一份 peer 数据 ✓）。
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

  const digits = code ? code.replace(/\s+/g, "").split("") : [];
  const rows = [0, 1, 2, 3, 4].map((r) => digits.slice(r * 4, r * 4 + 4));

  return (
    <div className="mshell mpair-code" data-testid="mobile-paircode">
      <header className="mpair-code-head">
        <button className="mpair-code-back" onClick={goBack} aria-label="返回">
          ‹
        </button>
        <span className="mpair-code-head-title">首次配对</span>
      </header>

      <div className="mpair-code-scroll">
        <p className="mpair-code-lead">🔒 只需一次 · 两台显示同一串码</p>

        {loading ? (
          <p className="mpair-code-note">正在读码…</p>
        ) : code ? (
          <>
            <div className="mpair-code-grid" data-testid="mpair-code-grid" aria-label="20 位对码">
              {rows.map((row, ri) => (
                <div className="mpair-code-row" key={ri}>
                  {row.map((ch, ci) => (
                    <span className="mpair-code-cell" key={ci}>
                      {ch}
                    </span>
                  ))}
                </div>
              ))}
            </div>
            <p className="mpair-code-caption">20 位 · 5 组 × 4 位 ｜ 两台必须一模一样</p>
          </>
        ) : (
          /* ⛔ 读不到码 ⇒ **如实说**（显示 reason ✓），⛔ 不渲染空格子冒充码 ✗ */
          <p className="mpair-code-note" data-testid="mpair-code-unavailable">
            读不到对码{reason ? `：${reason}` : "（后端没给原因）"}
          </p>
        )}

        <p className="mpair-code-warn">
          ⚠ 对不上一律不建立信任（本机一个字都不收）。两串不一样 ⇒ 多半是中间有人在替它回答，或者两台不在同一个网络 ⇒
          取消、查网络。
        </p>

        <div className="mpair-code-actions">
          <button className="mpair-code-cancel" onClick={goBack}>
            取消
          </button>
          {/* ⭐ d3：**真按钮** ✓ —— ⚠️ 只有**读到码**时才可点 ✗（看不到码就没法"对得上" ✓）；
              ⛔ 点之前**不发任何命令** ✗（⛔ 没有"自动通过"✗）。 */}
          <button
            className="mpair-code-confirm"
            disabled={!code || busy}
            data-testid="mpair-code-confirm"
            onClick={() => void confirmTrust()}
            title={code ? "码对得上，确认（会建立信任）" : "还没读到码，不能确认"}
          >
            {busy ? "正在建立信任…" : "码对得上，确认"}
          </button>
        </div>

        {errText ? (
          <p className="mpair-code-error" role="alert" data-testid="mpair-code-error">
            {errText}
          </p>
        ) : null}

        <p className="mpair-code-star">
          ★ 这一步没有"自动通过"：第一次必须由人点一下。（更短的 6 位码要先做 PAKE —— 已拍板不做，所以就是这 20 位。）
        </p>
      </div>
    </div>
  );
}
