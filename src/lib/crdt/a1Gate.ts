// A1 G0 的纯开关（零依赖，Web / 桌面 / 测试共用；⛔ 不 import 编辑器或平台层）。
//
// 口径（2026-11-24 起）：**默认关**。只有显式 `1/true/on` 才开；
// 未设置/0/false/off ⇒ 关。运行时可用 localStorage `shuyonote:crdt.autoMerge=1` 开（设备级）。
export function a1AutoMergeEnabledFrom(value: string | undefined | null): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/** 运行时的 A1 开关值（Vite 环境；Node 侧没有 `import.meta.env` 也不会抛）。 */
export function a1AutoMergeEnabled(): boolean {
  const raw = typeof import.meta !== "undefined" ? import.meta.env?.VITE_CRDT_A1 : undefined;
  // 显式构建开关优先（0/false/off 仍是强制关）；未设置才看设备级 localStorage。
  if (raw !== undefined && raw !== null) return a1AutoMergeEnabledFrom(raw);
  try {
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("shuyonote:crdt.autoMerge") === "1"
    );
  } catch {
    return false;
  }
}
