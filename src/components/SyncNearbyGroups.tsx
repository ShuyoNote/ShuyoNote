// 「附近的设备」那三段（刀二十，2026-10-14）—— 主视图里"三段设备"那一块。
//
// ## 这一块长什么样（owner 设计图）
// 每段 = ⭐ 一行标题 `「label」· N 台` ✓ ＋ ⭐ 这一段的卡片（名字／身份／右侧动作）✓；
// 这一段**一台都没有** ⇒ ⭐ 一行高的虚线框 ✓（一句实话，⛔ 不编数字 ✗ —— 与「读不到 ≠ 0」同一把尺 ✓）。
//
// ## ⛔ 三条不许动
// · ⭐ 段标题那三个 `data-testid` **逐字**（判据钉着：`nearby-group-keychanged` ／
//   `nearby-group-trusted` ／ `nearby-group-pending` ✓）；
// · ⭐ 段标题的文案**来自调用方**（`NEARBY_GROUPS` 那三条 label ✓）—— ⛔ 这里不另抄一份 ✗
//   （两份写法迟早漂开 ✓）；
// · ⭐ 卡片**内容**由调用方给（`renderPeer` ✓）：名字／身份行／那几句原因／右侧那几颗按钮
//   **全都带 handler** ✓ ⇒ 它们必须留在有那些 handler 的那个组件里 ✓，⛔ 不搬进来 ✗
//   （搬进来就得再造一套 props 把 `duUnpair`／`syncOne`／`trustDevice` 一个个穿过来 ✓ ——
//    那正是"数据接线一个字不许动"要挡的事 ✓）。
//
// ## ⚠️ 两处**结构**约束（都有判据在上面，别改成"套一层 div"）
// · ⭐ 段标题与它那几行卡片必须是**兄弟** ✗ —— `SyncPanel.trustDevicePanel.wiring.test.tsx`
//   的 `groupBefore()` 就是从卡片往上找 `previousElementSibling` 里最近的
//   `data-testid^="nearby-group-"` ✓ ⇒ ⛔ **不许**给每段套一个容器 ✗（套了就找不到段了 ✓）。
// · ⭐ 段序由调用方给的 `sections` 决定 ✓（bucket 的序是 `0/1/2` ✓ —— 排序键与分段键同一个 ✓）。
import { Fragment, type ReactNode } from "react";
import type { NearbyPeer } from "../lib/api";

export interface NearbyGroupSection {
  /** 段标题的 `data-testid`（⭐ 逐字，判据钉着那三个 ✓）。 */
  testid: string;
  /** 段标题（⭐ 取自 `NEARBY_GROUPS`，⛔ 这里不硬编码 ✗）。 */
  label: string;
  /** 这一段里的设备（⭐ 排序由调用方保证 ✓ —— 与 `nearbyBucket` 同一个键 ✓）。 */
  peers: NearbyPeer[];
  /**
   * 这一段**一台都没有**时还渲染吗（⭐ 默认渲染 ✓ —— 设计图要的是「`label · 0 台` ＋ 一行高虚线框」✓）。
   * ⚠️ 调用方会把**异常段**（「需要重新配对」✓）置 `false` ✗ —— 0 台时整段不出现 ✓，
   *    理由是既有判据钉着那一条（见 `SyncPanel.tsx` 里那个 `showWhenEmpty` 的注释 ✓）。
   */
  showWhenEmpty?: boolean;
}

export interface SyncNearbyGroupsProps {
  sections: NearbyGroupSection[];
  /** 一台设备的卡片内容（⭐ handler 在调用方那边 ✓ —— 见文件头那条边界 ✓）。 */
  renderPeer: (p: NearbyPeer) => ReactNode;
  /** 三段**之外**的总说明（例：`还没发现别的设备… 正在找` ✓）—— 没有就不渲染 ✓。 */
  totalNote?: string;
  /**
   * 空段那一行虚线框里的实话。
   * ⚠️ 默认值就是既有那句（⛔ 不新造说法 ✗）；调用方也可以显式传同一个串 ✓。
   */
  emptyText?: string;
}

export function SyncNearbyGroups({
  sections,
  renderPeer,
  totalNote,
  emptyText = "这一轮没找到这一段的设备",
}: SyncNearbyGroupsProps) {
  return (
    <>
      {totalNote ? <div className="sync-hint">{totalNote}</div> : null}
      {sections
        // ⚠️ 空且**不该露脸**的那些段整段略去 ✓（⛔ 不是渲染成"0 台"再藏 ✗ —— 那会留下一个空标题 ✓）。
        .filter((s) => s.peers.length > 0 || s.showWhenEmpty !== false)
        .map((s) => (
          <Fragment key={s.testid}>
            <div className="sync-hint" data-testid={s.testid}>
              {s.label} · {s.peers.length} 台
            </div>
            {s.peers.length === 0 ? (
              // ⭐ 一行高的虚线框 ✓（样式来自 `App.css` 的
              //    `[data-testid^="nearby-group-"] + .sync-empty-state` ✓ —— 那正是「标题的下一个兄弟」✓）。
              <div className="sync-hint sync-empty-state" style={{ paddingLeft: 12 }}>
                {emptyText}
              </div>
            ) : (
              s.peers.map((p) => (
                <div className="sync-nearby-row" key={p.device_id}>
                  {renderPeer(p)}
                </div>
              ))
            )}
          </Fragment>
        ))}
    </>
  );
}
