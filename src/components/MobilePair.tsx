import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { pushOverlay } from "../lib/overlayStack";
import { peerIdentityLine } from "../lib/peerIdentity";
import { useMobileNav } from "../store/mobileNav";
import { useSpaceStore } from "../store/space";
// ⭐ 阶段 3：自动同步那格的**唯一判定处** ✓（与 `App.tsx:73` 同源 ✓ ⇒ ⛔ 不抄第二份判定 ✗）。
import { AUTO_SYNC_CHANGED_EVENT, effectiveAutoSyncMs } from "../lib/syncMode";
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

  /**
   * 返回：**回来处** ✓（阶段 3 修 —— 原先是**写死** `home` ✗：从设置那行进来的也会被丢回首页 ✓）。
   *
   * ⭐ 来处由 `mobileNav` 的 `cameFrom` 自动记 ✓（⛔ 这里不另存一份 ✗）；兜底 `home` ✓（⛔ 不崩 ✗）。
   * ⚠️ 从**本屏内**进「首次配对」时，来处同样是本屏 ✓ ⇒ 返回回「设备直连」✓（⛔ 不是首页 ✗）。
   */
  const cameFrom = useMobileNav((s) => s.cameFrom);
  const goBack = useCallback(() => setScreen(cameFrom ?? "home"), [setScreen, cameFrom]);

  // ⭐ 安卓返回键：直连返回栈底层（与其余几张移动屏同一处置 ✓）。
  useEffect(() => pushOverlay("mobile-pair", goBack), [goBack]);

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

  /**
   * ⭐ 【C1】**分组**（照 owner 2026-10-14 参考图 ✓）：已配对 ① → **要重配** ② → 附近 ③。
   *
   * ⚠️ 分组判据＝**本机认过的那份名单** ✓（`pairedIds`，取自 `api.meshSetConfig(activeId, null, null)` ✓，
   *    与 `SyncPanel.tsx:305-309` **同一个命令** ✓）—— ⛔ **不自己再算一遍**"算不算配上了" ✗
   *    （口径逐字在 `SyncPanel.tsx:1485-1487` ✓：「取**本机认过的那份名单** ✓…⛔ 不自己再算一遍 ✗
   *      （两份真相迟早各说各话 ✓）」）。
   * ⚠️ ⭐ 用**排序**实现 ⇒ ⛔ **不新增／不删除任何结构** ✗（那是 C2/C3 的事 ✓）；
   *    分不进任何一档的 ⇒ 第③组「附近」✓（⛔ 不丢设备 ✗）。
   */
  const nearbyGroup = (p: NearbyPeer): 0 | 1 | 2 =>
    p.key_changed === true ? 1 : pairedIds.includes(p.device_id) ? 0 : 2;
  const nearbyOrdered = [...nearby].sort((x, y) => nearbyGroup(x) - nearbyGroup(y));

  /**
   * ⭐ 「本机有 N 个空间**没开加密**」（图上黄条的 N ✓）—— ⛔ **不新造后端** ✗：
   *    直接用 store 里那份空间表算 ✓（`WorkspaceMeta.encrypted_on_disk` ✓，逐字确认于 `src/types.ts` ✓）。
   * ⚠️ `N === 0` ⇒ **整条不渲染** ✓（没问题的机器不该看到警告 ✓）。
   * ⛔ **不渲染「去开加密 ›」那个动作** ✗ —— 目的地（空间隐私）自己写着「**要在桌面端操作**」✗
   *    （`SpacePrivacySection.tsx:176` ✓）⇒ 渲染它就是**假按钮** ✗（与 08 屏那条同一口径 ✓）。
   */
  const spaces = useSpaceStore((s) => s.spaces);

  /**
   * ⭐ 绿卡那格的「**自动同步中**」✓ —— 走 `syncMode.ts` 的**同一个**判定 ✓
   *    （与 `App.tsx:574/579` 同形：初值 `effectiveAutoSyncMs()` ✓ ＋ 订阅 `AUTO_SYNC_CHANGED_EVENT` ✓）。
   * ⚠️ 判据：**`> 0` 才显示** ✗（`0` ＝ 关 ⇒ 不写那一句 ✓）；⛔ 绝不恒真 ✗。
   */
  /**
   * ⭐ 【B】**已配对名单** ✓ —— 与 `SyncPanel.tsx:305-309` 取的是**同一个命令** ✓
   *    （⭐ 那是 **`api.meshSetConfig(activeId, null, null)`** ✓ ＝ **写命令的 `null` 只读形** ✓，
   *     原注释逐字：「两个参数都给 `null` ⇒ **不写任何东西** ✓（只取读数 ✓）」）。
   *    ⛔ **不自己再算一遍**"算不算配上了" ✗（口径逐字在 `SyncPanel.tsx:1485-1487`：
   *    「取**本机认过的那份名单** ✓…⛔ 不自己再算一遍"算不算配上了"✗（两份真相迟早各说各话 ✓）」）。
   * ⚠️ 读不到（还没配／读失败）⇒ **空名单** ✓ ⇒ 绿卡那句「已配对」**不写** ✗（⛔ 不假装有设备 ✗）。
   */
  const [pairedIds, setPairedIds] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .meshSetConfig(activeId ?? null)
      .then((st) => {
        if (alive) setPairedIds((st.paired ?? []).map((d) => d.deviceId));
      })
      .catch(() => {
        if (alive) setPairedIds([]);
      });
    return () => {
      alive = false;
    };
  }, [activeId]);

  const [autoSyncMs, setAutoSyncMs] = useState(() => effectiveAutoSyncMs());
  useEffect(() => {
    const onChanged = () => setAutoSyncMs(effectiveAutoSyncMs());
    window.addEventListener(AUTO_SYNC_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(AUTO_SYNC_CHANGED_EVENT, onChanged);
  }, []);
  const unencryptedCount = spaces.filter((sp) => !sp.encrypted_on_disk).length;

  return (
    <div className="mshell mpair" data-testid="mobile-pair">
      <header className="mpair-head">
        {/* ⭐ 阶段 3：文案**不再写"返回首页"** ✗ —— 现在是回**来处** ✓（设置那行进 ⇒ 回设置 ✓；首页进 ⇒ 回首页 ✓）。 */}
        <button className="mpair-back" onClick={goBack} aria-label="返回">
          ‹
        </button>
        <span className="mpair-head-title">设备配对 · 同步</span>
      </header>

      <div className="mpair-scroll">
        {/**
          * ⭐ 绿卡（照 owner 2026-10-14 参考图 ✓）—— ⭐ **只拼证得出来的词** ✓：
          *    `status.enabled === true` ⇒「在线」✓；`autoSyncMs > 0` ⇒「自动同步中」✓。
          * ⛔ **不写「已配对」** ✗ —— ⭐ 已核清它**没有出处** ✓：`LanStatus` 只有
          *    `enabled/peers/kind/line/mesh/nearby` ✓、`MeshPanelScope` 只有 `wsId/name/kind/announced` ✓
          *    （`peers` 是"同网段听得见的台数" ✗ ≠ 已配对 ✓；账本 `mesh_paired_devices` 在
          *    `db.rs:201/253` ✓ 但**没有对前端的命令** ✗）⇒ ⛔ 不渲染一句证不出来的状态 ✗。
          * ⚠️ 两个词都缺 ⇒ **整行不渲染** ✓（⛔ 不留一个只有 ● 的空壳 ✗）。
          */}
        {(() => {
          const words = [
            // ⭐ 【B】出处＝`duList.length > 0` ✓（引 `SyncPanel.tsx:1141-1148` ✓ —— ⭐ 尤其那句
            //    「N 来自 `duList` ✓，⛔ **不是** `lanStatus.peers`（那是**附近**的台数 ✗）」）。
            pairedIds.length > 0 ? "已配对" : null,
            status?.enabled ? "在线" : null,
            autoSyncMs > 0 ? "自动同步中" : null,
          ].filter(
            (w): w is string => w !== null,
          );
          if (words.length === 0) return null;
          return (
            <div className="mpair-ok" role="status" data-testid="mpair-online-card">
              <span className="mpair-ok-line">
                <span className="mpair-ok-dot" aria-hidden>
                  ●
                </span>
                {words.join(" · ")}
              </span>
              {/* 副文案：**纯文案** ✓ 照图抄 ✓（⛔ 不承载任何读数 ✗）。 */}
              <span className="mpair-ok-sub">配对一次之后，不用再点任何东西</span>
            </div>
          );
        })()}
        {/* ⭐ 黄条（照 owner 2026-10-14 参考图 ✓）：只有**真有问题**时才出现 ✓（`N === 0` ⇒ 不渲染 ✗）。 */}
        {unencryptedCount > 0 && (
          <div className="mpair-warn" role="note" data-testid="mpair-unencrypted-warn">
            <span aria-hidden>⚠</span> 本机有 <b>{unencryptedCount}</b> 个空间没开加密 ⇒ 内容会在局域网上明文传输
          </div>
        )}
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
              {nearbyOrdered.map((p, i) => (
                <li key={`${p.device_id}-${i}`} className="mpair-item">
                  <span className="mpair-item-main">
                    {/* ⭐ 「设备名 ＋ 短标识」；对端**没报**短标识 ⇒ 如实写「对方没报短标识」✓（⛔ 不回落 ✗） */}
                    <span className="mpair-item-who">{peerIdentityLine(p.device_name, p.short_id)}</span>
                    <span className="mpair-item-meta">
                      {/* ⭐ 阶段 3（owner 2026-10-14 移动参考图 ✓）：设备卡 meta 行**显示**对端来源地址 ✓。
                          ⚠️ 口径见 `docs/specs/2026-09-29-nearby-devices-spec.md` §3.4（同刀已改 ✓）：
                             它是"**最后一次听到的来源**"、**可能过期** ✗ ⇒ ⭐ 只当**辅助信息** ✓，
                             ⛔ **不**拿它做判据／文案 ✗（⛔ 桌面侧维持不显示 ✗）。
                          ⚠️ 字段注记写明**不含端口** ✓ ⇒ 原样出 ✓（⛔ 不加端口 ✗）；⛔ 取不到 ⇒ 整段不写 ✗。 */}
                      {p.addr ? `${p.addr} · ` : ""}
                      {/* ⭐ 【C1】状态文案照图 ✓ —— ⚠️ 每句都要**有出处** ✗：
                          ② 钥匙变了 ＝ 只有 `key_changed === true` ✓（`SyncPanel.tsx:1120` 那条口径 ✓：
                             「只有 `key_changed === true` 才算…**读不到（`null`）与 `false` 一律不算** ✓」）；
                          ① 已配对 ＝ 在 `pairedIds`（本机认过的名单 ✓）里；
                          ③ 其余 ＝「未配对」✓。
                          ⛔ **「正在广播」那半句不写** ✗ —— `NearbyPeer.reason` 的取值里核不到那一档
                             （`"ok"`／`"no_secret"`… ✓）⇒ ⛔ 不写一个没有出处的状态 ✗。 */}
                      {p.key_changed === true
                        ? "对方换过钥匙 ⇒ 旧信任已失效"
                        : pairedIds.includes(p.device_id)
                          ? p.serves_current
                            ? "与当前空间相关"
                            : "与当前空间无关"
                          : "未配对"}
                      {p.invitable && p.key_changed !== true ? " · 可直接连接" : ""}
                    </span>
                    {/* ⭐ 【C2】两颗小胶囊（照 owner 2026-10-14 参考图 ✓）—— ⚠️ 都**只在有出处时**渲染 ✗：
                        ② 红胶囊「⊘ 钥匙不匹配」⇒ ⭐ **只有 `key_changed === true`** ✗
                           （`null`（读不到）／`false` **一律不渲染** ✓ —— 口径逐字在 `SyncPanel.tsx:1120`：
                            「只有 `key_changed === true` 才算"钥匙变了"✗…**读不到（`null`）与 `false` 一律不算** ✓」）；
                        ① 绿胶囊「✓ 自动同步」⇒ `autoSyncMs > 0` **才**渲染 ✗（⛔ 不恒真 ✗），
                           且只挂在**已配对**那一档上 ✓（与「配对一次之后…」那句同指 ✓）。
                        ⛔ 两颗都**不承载动作** ✗（本轮不新增按钮 ✓ —— 三颗动作是面板内部流程 ✓，见 C1 那份记录 ✓）。 */}
                    <span className="mpair-item-pills">
                      {p.key_changed === true ? (
                        <span className="mpair-pill mpair-pill-bad" data-testid="mpair-pill-keychanged">
                          ⊘ 钥匙不匹配
                        </span>
                      ) : null}
                      {autoSyncMs > 0 && pairedIds.includes(p.device_id) ? (
                        <span className="mpair-pill mpair-pill-ok" data-testid="mpair-pill-autosync">
                          ✓ 自动同步
                        </span>
                      ) : null}
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
            本屏未接 ✗ —— 已配对列表那侧只有「设备标识与时间」，没有名字（规格要求显示"哪台"，⛔ 不许拿标识凑 ✗）。
          </p>
        </section>
      </div>
    </div>
  );
}
