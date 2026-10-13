import { peerIdentityLine } from "../lib/peerIdentity";
import { timeAgo } from "../lib/timeAgo";

/**
 * **融合历史 ＋ 撤销** 的界面原型（R203 ⇒ win 早先邀请画的原型 ✓）。
 *
 * ## ⛔ 本轮是「组件 ＋ 判据」，**不接进任何用户可见路径** ✗
 * ⛔ **没有**接进 `mobileNav` 的屏栈 ✗、⛔ 没有接进 `App.tsx` ✗ —— 理由：**账本没有命令出口** ✗
 * （见下面那条横幅 ✓）。⇒ 于是：**没有任何用户能点到一个假按钮** ✓，也**不会出现死屏** ✗，
 * 但**形状出来了** ✓（win 照它实现命令就能接上 ✓）。
 *
 * ## 数据形状（⭐ 与 Rust `MergeRecord` / `PairMark` 同形 ✓ —— 见 `mesh_merge_ledger.rs:148-178` ✓）
 * · 何时 ＝ `at_ms` ✓ ／ 从哪台 ＝ 设备名＋短标识 ✓ ／ 合了多少条 ＝ `moved.len()` ✓
 * · `undone_at_ms === null` ⇒ **那一行仍可撤** ✓（⛔ 已撤的、以及压根没记录的，**都不许**出现可点的「撤销」✗）
 *   —— 这正对应 `SpaceView::undoable` 的注释「**还没撤的那些融合（只有这些才显示可撤回）**」✓。
 *
 * ## ⛔ 三条不许破的口径
 * ① ⛔ **`peer_device` 不进用户可见的句子** ✗（`INV-UI-copy-no-internal-ids` ✓）⇒ 身份行一律走
 *    `peerIdentityLine(deviceName, shortId)` ✓ —— 它**根本接收不到** `device_id` ✓（结构上保证 ✓）；
 *    对方没报短标识 ⇒ 如实显示「对方没报短标识」✓，⛔ 不回落成设备号前几位 ✗。
 * ② ⛔ **不造假数据／不造假接口** ✗：拿不到真读数 ⇒ **如实标未接** ✓（与 08 屏同一口径 ✓）。
 * ③ ⛔ JSX 文本里**不写 markdown** ✗（`**` 会被原样画到屏上 ✓ —— 这条踩过一次 ✓）。
 */

/** 一行融合记录 —— ⭐ 与 `MergeRecord` 同形（只把"要动的行"折成条数 ✓）。 */
export interface MergeHistoryRow {
  /** `MergeRecord.id`（账本内单调递增 ✓ ⇒ 也当 React key ✓）。 */
  id: number;
  /** `MergeRecord.at_ms` ⇒ 「何时」✓。 */
  at_ms: number;
  /** `MergeRecord.peer_device` —— ⚠️ **只作技术标识**（key／去重 ✓），⛔ 不进句子 ✗。 */
  peer_device: string;
  /** 对方设备名；拿不到 ⇒ 空 ✓（界面如实说"未报"✓）。 */
  peer_name?: string;
  /** 对方短标识；拿不到 ⇒ 空 ✓。 */
  peer_short_id?: string;
  /** `MergeRecord.moved.len()` ⇒ 「合了多少条」✓。 */
  moved_count: number;
  /** `MergeRecord.kept_before` ⇒ 撤完要对得上的读数 ✓。 */
  kept_before: number;
  /** `MergeRecord.undone_at_ms`：`null` ＝ **仍可撤** ✓。 */
  undone_at_ms: number | null;
}

/** 一条「这次并对了，别再问」标记 —— ⭐ 与 `PairMark` 同形 ✓。 */
export interface MergeHistoryMark {
  name_display: string;
  peer_name?: string;
  peer_short_id?: string;
  marked_at_ms: number;
}

export interface MobileMergeHistoryProps {
  rows: MergeHistoryRow[];
  marks?: MergeHistoryMark[];
}

export function MobileMergeHistory({ rows, marks = [] }: MobileMergeHistoryProps) {
  return (
    <section className="mmerge" data-testid="mobile-merge-history">
      {/* ⑤ 数据层**明标未接** ✓（⛔ 不造假数据 ✗）—— 逐字写清为什么本屏拿不到真读数 ✓ */}
      <p className="mmerge-unwired">
        本组件尚未接数据：账本已经进构建（src-tauri/src/lib.rs:129），但
        <strong>没有命令、也没有生产调用者</strong>
        ⇒ 本屏拿不到真读数。所以这里只定形状，⛔ 不显示任何编造的融合记录。
      </p>

      <h2 className="mmerge-title">融合历史</h2>
      {rows.length === 0 ? (
        <p className="mmerge-empty">
          还没有融合记录 —— 所以这里连一颗「撤销」都没有。
          （账本里没有记录时，⛔ 不会渲染出可撤销的东西。）
        </p>
      ) : (
        <ul className="mmerge-list">
          {rows.map((r) => (
            <li key={r.id} className="mmerge-item">
              <span className="mmerge-when">{timeAgo(r.at_ms)}</span>
              {/* ⭐ 「从哪台」＝设备名 ＋ 短标识 ✓；⛔ 不传 device_id ✗（拿不到就说"没报"✓） */}
              <span className="mmerge-who">{peerIdentityLine(r.peer_name ?? "", r.peer_short_id ?? "")}</span>
              <span className="mmerge-count">
                合入 {r.moved_count} 条（原有 {r.kept_before} 条）
              </span>
              {r.undone_at_ms === null ? (
                // ⭐ 只有**还没撤**的那一行才有「撤销」✓；⛔ 它是常驻禁用态：本组件没接数据层 ✗
                <button
                  className="mmerge-undo"
                  disabled
                  title="本组件未接数据层：账本没有命令出口（见上方说明）—— 未做 ✗"
                >
                  撤销
                </button>
              ) : (
                <span className="mmerge-undone">已撤销</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2 className="mmerge-title">这次并对了，别再问</h2>
      {marks.length === 0 ? (
        <p className="mmerge-empty">还没有标记过的设备。</p>
      ) : (
        <ul className="mmerge-marks">
          {marks.map((m, i) => (
            <li key={`${m.name_display}-${i}`} className="mmerge-mark">
              <span className="mmerge-who">{peerIdentityLine(m.peer_name ?? "", m.peer_short_id ?? "")}</span>
              <span className="mmerge-mark-note">
                对「{m.name_display}」已标记：下次同名融合不再问（{timeAgo(m.marked_at_ms)}）
              </span>
            </li>
          ))}
        </ul>
      )}
      <button className="mmerge-mark-btn" disabled title="本组件未接数据层：账本没有命令出口（见上方说明）—— 未做 ✗">
        这次并对了，别再问
      </button>
    </section>
  );
}
