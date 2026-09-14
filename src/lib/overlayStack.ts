// 「打开中的覆盖层栈」——Android 返回键的第一顺位消费者。
//
// ## 为什么需要它
//
// Tauri 的 Android 壳把返回键交给了 **Kotlin 的 `AppPlugin`**（`app/tauri/AppPlugin.kt`
// 的 `init` 里注册了一个 `OnBackPressedCallback`）：
//   · 若 **web 层没有** 注册 `back-button` 监听 ⇒ 它走 `canGoBack()`，
//     SPA 没有历史 ⇒ `false` ⇒ `activity.onBackPressed()` ⇒ **直接退出应用**；
//   · 若注册了 ⇒ 它 emit 一个事件，由 web 决定。
// 而"由 web 决定"这条路上，**web 没法自己退出应用**：`plugin:app|exit` 那条命令
// 不在 `core:app` 的权限清单里（见 `src-tauri/gen/schemas/acl-manifests.json`，
// `core:app.permissions` 有 `allow-register-listener` 但**没有** `allow-exit`），
// 调它会被 ACL 直接拒掉。所以在移动端**必须由壳层（Kotlin）来退出**。
//
// 于是本模块只做一件事：**让壳层能问「现在有没有浮层开着，能不能关掉一层」**。
// `scripts/android-mobile-shell.mjs` 注入的 Kotlin 会调用
// `window.__SHUYONOTE_BACK__.handle()`：
//   · 返回 `true`  ⇒ web 关掉了最上层浮层，壳层什么也不做；
//   · 返回 `false` ⇒ 栈是空的，壳层放行返回键（AppPlugin 那条回调会把应用关掉）。
//
// ## 栈的语义
//
// - **后进先出**：最后打开的那一层最先被关（与用户看到的层叠顺序一致）。
// - 由各浮层组件用 `useOverlayLayer(open, close)` 登记（见 `src/hooks/useOverlayLayer.ts`），
//   而不是去猜 DOM 里哪个 `[class*="overlay"]` 在最上面——那种做法在
//   "面板里再开一个面板"（设置 → 存储）时会关错层。
// - 登记顺序 = 打开顺序（组件在打开时挂载/生效），所以 LIFO 天然正确。
//
// 这个模块**不碰 DOM、不碰 React**，因此可以直接单测（`overlayStack.test.ts`）。

/** 一层可关闭的覆盖层。 */
interface OverlayLayer {
  /** 便于诊断/测试的标识（组件名）。 */
  id: string;
  close: () => void;
}

/** 当前打开中的层（栈底在前）。 */
const layers: OverlayLayer[] = [];

/**
 * 登记一层，返回"注销"函数。
 *
 * 返回的函数是**幂等**的：重复调用只会注销一次（React 18 的 StrictMode 会把
 * effect 跑两遍，若不幂等，栈里会留下幽灵层 ⇒ 返回键要按两次才退出应用）。
 */
export function pushOverlay(id: string, close: () => void): () => void {
  const layer: OverlayLayer = { id, close };
  layers.push(layer);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
  };
}

/** 当前浮层层数（0 = 没有浮层）。 */
export function overlayDepth(): number {
  return layers.length;
}

/** 当前浮层的标识（栈底在前）——诊断/验收用。 */
export function overlayIds(): string[] {
  return layers.map((l) => l.id);
}

/**
 * 关掉最上层，返回"是否真的关掉了一层"。
 *
 * 先出栈再调用 `close()`：`close()` 是组件自己的状态变更（可能是异步的），
 * 让它同步地再登记/注销会很容易把自己绕进去；先出栈保证"关一次只掉一层"。
 */
export function closeTopOverlay(): boolean {
  const top = layers.pop();
  if (!top) return false;
  try {
    top.close();
  } catch (e) {
    // 关不掉也不能让返回键挂在这里：这一层已经从栈里出来了，调用方拿到 true。
    console.error(`[overlay] 关闭浮层 ${top.id} 失败：`, e);
  }
  return true;
}

/** 仅供测试：清空栈（不调用任何 close）。 */
export function resetOverlayStackForTest(): void {
  layers.length = 0;
}

/** 壳层调用的桥名（Kotlin 侧 `evaluateJavascript` 里硬编码同一个字符串）。 */
export const BACK_BRIDGE_KEY = "__SHUYONOTE_BACK__";

/** 壳层看到的桥对象。 */
export interface BackBridge {
  /** 关掉最上层浮层；栈空返回 false（⇒ 壳层放行返回键、退出应用）。 */
  handle: () => boolean;
  /** 当前层数（诊断用）。 */
  depth: () => number;
  /** 当前层的标识（诊断用）。 */
  ids: () => string[];
}

/**
 * 把桥挂到 `window` 上；返回卸载函数。
 *
 * ⚠️ `handle()` 必须返回**真布尔值**：Kotlin 侧用
 * `(window.__SHUYONOTE_BACK__ && window.__SHUYONOTE_BACK__.handle()) === true`
 * 取值，`evaluateJavascript` 的回调拿到的是 `"true"` / `"false"`。
 */
export function installBackBridge(target: Window = window): () => void {
  const bridge: BackBridge = {
    handle: () => closeTopOverlay(),
    depth: () => overlayDepth(),
    ids: () => overlayIds(),
  };
  (target as unknown as Record<string, unknown>)[BACK_BRIDGE_KEY] = bridge;
  return () => {
    delete (target as unknown as Record<string, unknown>)[BACK_BRIDGE_KEY];
  };
}
