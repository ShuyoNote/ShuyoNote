// 「设置 · 同步 → 高级」这一页：设备直连的三个手填项（监听地址 / 配对暗号 / 口令）。
//
// ⭐ 2026-10-11（owner 重申「**个人空间是设备级**」）—— 这一页是**本机一份**设置：
//   写的时候 `activeId` 传**空串** ⇒ 后端 `DEVICE_LEVEL_SPACE = ""` ⇒ 所有个人空间共用 ✓
//   （方案 `docs/plans/2026-10-11-personal-mesh-device-level.md` §10.4 ✓）。
//
// ⚠️ 读那一份仍按**当前空间**取（`api.lanStatus(null)` ⇒ 个人档 ✓）—— 设备级落地之后，
//   后端在**读**这一侧自己就会把个人档解析到设备级那一格 ✓，所以读到的与写的是同一份 ✓。
//
// ⚠️ 本步（第 2 步）**刻意不摘面板那一份** ✗：中间态是"两处入口"，但**能用** ✓
//   （面板写的是旧那一格，而读路径有**只读回退** ⇒ 仍旧看得见 ✓）。摘面板 ＋ 改判据是下一步 ✓。

import { useEffect, useState } from "react";

import { api, type LanStatus } from "../lib/api";
import { isDesktopPlatform } from "../lib/platform";

import { MeshAdvancedForm } from "./MeshAdvancedForm";

export function SyncSettingsPane() {
  const [lanStatus, setLanStatus] = useState<LanStatus | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    // 设备直连是桌面专属 ⇒ 非桌面平台连读都不读（与面板 `SyncPanel.tsx:207` 同口径 ✓）。
    if (!isDesktopPlatform()) return;
    let alive = true;
    void (async () => {
      try {
        const st = await api.lanStatus(null);
        if (alive) setLanStatus(st);
      } catch {
        if (alive) setLanStatus(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="set-section">
      <p>
        ⭐ 这里是「这台设备」的设备直连设置 ✗：填一次，「所有个人空间共用」 ✓
        （⛔ 团队空间不受影响 —— 它们各自按空间来 ✓）。
      </p>
      {lanStatus ? (
        <MeshAdvancedForm
          // ⭐ 空串 ＝ 设备级（后端 `DEVICE_LEVEL_SPACE` ✓）。⛔ 别改成 `null` ✗：
          //   `mesh_set_config` 里有一句 `.filter(|w| !w.trim().is_empty())` ⇒ 两者可能不同 ✓。
          activeId=""
          lanStatus={lanStatus}
          onStatus={setStatus}
          onMeshChanged={(mesh) => setLanStatus((prev) => (prev ? { ...prev, mesh } : prev))}
        />
      ) : (
        <p>正在读取本机的设备直连设置…</p>
      )}
      {status ? <p>{status}</p> : null}
    </section>
  );
}
