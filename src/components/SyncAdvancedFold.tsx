// 「设备直连」主视图里**唯一**那个折叠（刀二十，2026-10-14）。
//
// ## 它装什么
// ⭐ **其余全部** ✗：所有设置行（同步方式／监听地址／端口／拉取间隔／中继／设备直连那组／
// 配对与设备／同步预算／同步历史）、三条条件块（Web 档说明、冲突裁决、待取回的远端版本）
// 与底部那条常驻读数/进度（`.sync-foot`）✓ —— 主视图因此只剩：
// 未加密提醒 ⇒ 标题 ⇒ 状态条 ⇒ 三段设备 ⇒ 这一个折叠 ✓（owner 2026-10-14 的设计图 ✓）。
//
// ## 为什么是 `<details>` 而不是自己写一套开关
// 本仓既有口径（`App.css:1404` 逐字）：「用原生 `<details>/<summary>` ⇒ 不引入新的 JS 状态」✓；
// ⛔ 默认**收起** ✗ —— 不给 `open`（主视图要的是"少"，不是"多一个东西要点开" ✓）。
//
// ## ⚠️ 内容**不搬进来**（这一点是有意的）
// `children` 由 `SyncPanel.tsx` 传 ✓ —— ⛔ 那些块一个字节都没挪 ✗：
// 三个 `nearby-group-*` 段标题的 testid、`nearby-sync`／`nearby-unpair`、`device-pair`／
// `device-pair-advanced`／`device-unpair`、`<RelayStatusSection` 这些针
// **都长在 `SyncPanel.tsx` 里** ✓，而 `syncPanelMesh.wiring` / `syncPanelDevicePair.wiring` /
// `syncPanelDeviceUnpair.wiring` / `SyncPanel.trustDevicePanel.wiring` 是**源码级**判据
// （逐字读 `SyncPanel.tsx` ✓）⇒ ⭐ 把 JSX 搬进别的文件会把它们**一起弄红** ✓
// （那不是本笔要的"重写"，那是拆判据 ✓）。
// ⚠️⭐ 反例（2026-10-14）：⭐「空间隐私」那一节**确实**从面板删掉了 ✓（owner 拍：与设置的安全面板
// 重复 ✓）—— ⭐ 但它的两条接线判据是**换了对象**（改指 `SettingsDialog.tsx` 那个挂载点 ＋ 钉死
// 面板里**不再**有它 ✓），⛔ 不是把断言删掉 ✗（本仓 R192「换对象不删断言」✓）。
import type { ReactNode } from "react";

export interface SyncAdvancedFoldProps {
  /** 折叠里的全部内容（设置行 ＋ 条件提醒 ＋ 底部读数区）—— 由 `SyncPanel.tsx` 给 ✓。 */
  children: ReactNode;
}

export function SyncAdvancedFold({ children }: SyncAdvancedFoldProps) {
  return (
    // ⚠️ 类名沿用手边那个 `.sync-advanced`（它就是原来那个"高级（已自动填好）"折 ✓）：
    //    ⛔ 不新造类名 ✗（新类名要配 `App.css` 规则 ✓，而本笔不碰样式表 ✓）。
    <details className="sync-advanced">
      <summary>高级（已自动填好，一般不用动）</summary>
      {children}
    </details>
  );
}
