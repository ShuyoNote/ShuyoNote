// A1 G0 的纯开关（零依赖，Web / 桌面 / 测试共用；⛔ 不 import 编辑器或平台层）。
//
// 口径：**默认开**（同血统合并今天已经在跑；关掉才是回滚）。
// 只认显式 `0/false/off` 为关；未设置/其它值 ⇒ 开。
export function a1AutoMergeEnabledFrom(value: string | undefined | null): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/** 运行时的 A1 开关值（Vite 环境；Node 侧没有 `import.meta.env` 也不会抛）。 */
export function a1AutoMergeEnabled(): boolean {
  return a1AutoMergeEnabledFrom(
    typeof import.meta !== "undefined" ? import.meta.env?.VITE_CRDT_A1 : undefined,
  );
}
