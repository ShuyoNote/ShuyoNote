/**
 * 宿主事件的**公告口**（零依赖）。
 *
 * 为什么要这么一层：`notes` / `space` / `App` 这些地方只该"播报事实"（打开了页面、
 * 删了页面、切了空间），而不该知道插件、权限、草稿确认这些事。让它们直接 import
 * 插件 store 会立刻绕成循环依赖（插件 → 草稿 → applyDraftAndRefresh → notes → 插件）。
 *
 * 所以：宿主各处调用 `emitHostEvent(...)`，插件层在启动时用 `registerHostEventEmitter`
 * 注册真正的派发实现。没有插件层时这里什么都不做，也不会报错。
 */

export type HostEventEmitter = (event: string, payload?: Record<string, unknown>) => void;

let emitter: HostEventEmitter | null = null;

/** 由插件层在模块加载时注册（见 store/plugins.ts）。 */
export function registerHostEventEmitter(fn: HostEventEmitter): void {
  emitter = fn;
}

/** 播报一个宿主事件。没人听就什么都不发生。 */
export function emitHostEvent(event: string, payload?: Record<string, unknown>): void {
  emitter?.(event, payload);
}
