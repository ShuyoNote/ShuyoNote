// E2：口令锁的状态中枢。
//
// 为什么要有这一层：E1 的「锁定」原先只活在两个地方——`App` 里一次性的 `useState`
// 和设置页里各自的 `useState`。于是同一个事实有三个副本，谁也不通知谁：
//   · 在设置页点「立即锁定」后，界面**不会**切到锁定屏，用户继续看着已经读不出来的内容；
//   · 反过来 App 拿到锁定态时的早退又破坏了 hooks 顺序（见 App.tsx 里的闸门注释）。
// 现在状态只有一份、改动只有一个入口：谁改了锁的状态，谁就 publish，界面跟着动。
import { api } from "./api";

export type VaultState = {
  /**
   * ⭐ **「这个空间加密了吗」的唯一读数** —— 闸门（`App.tsx`）与设置页「会话锁定」那一节**同一把尺** ✓。
   *
   * 它说的是 ⭐「**当前活动空间**是不是加密的」✓ ——
   * ⛔ **不是**"本机有没有加密空间" ✗，⛔ **也不是**"整个应用开没开加密" ✗。
   * ⚠️ 这里原来那句注释把两种说法写在同一行里（前半句"本机有没有"✗ ＋ 后半句"读的是活动空间读数"✓）
   * ⇒ **只读前半句的人会得到错误结论** ✗（2026-10-10 lead 就是这么被误导的 ✓）。
   * ⇒ 现在**只保留一种说法** ✓，出处逐字：
   *   · `security.rs:717` `enabled = encryption_enabled(&c) || active_space.encrypted_on_disk || active_space.in_keyring`
   *   · `security.rs:36` `encryption_enabled(c)` 读的是 **`c.path()` 那个当前连接的空间**
   *   · `security.rs:837-851` 启动时 `LOCKED` 只看**活动空间**的文件头
   * ⇒ 两边都按活动空间算 ⇒ **加密是"按空间"的** ✓，明文空间不该被别人的口令挡住 ✓。
   *
   * ⚠️ TS 侧拿不到内核的 `active_space` 字段（`commands.ts` 的 `encryption_status.result` 里只有
   * `enabled/locked/format/...` ✓）⇒ 这里用内核的 `enabled` ✓（它按活动空间算 ✓）。
   */
  activeSpaceEncrypted: boolean;
  /**
   * ⭐ **"当前这个活动空间现在读不出来（需要口令）"** —— ⚠️ **不是**"整个会话锁着" ✗
   * （owner 2026-10-10 拍 A：明文空间与加密空间**各算各的** ✓）。
   *
   * 算法在内核一处定义 ✓：**活动空间是密的 且 本会话拿不到它的钥匙**
   * （`security.rs::active_space_needs_passphrase` ✓ —— `encrypted_on_disk && !key_available` ✓）。
   * ⇒ 明文活动空间恒为 `false` ✓；切到加密空间且没解锁 ⇒ `true` ✓（闸门弹锁屏 ✓）；解锁后 ⇒ `false` ✓。
   *
   * ⚠️ ⛔ 别把它读成"进程级的锁" ✗ —— 内核里**另有**一个进程级 `LOCKED`
   * （供 `gate_sync` 与 `lock/unlock` 用 ✓），那是"**整个会话**"的语义，和这一格不是一回事 ✓。
   * ⚠️ 所以**切空间之后必须重读**（`store/space.ts::switchTo` 里那次 `refreshVault()` ✓），
   * 否则界面拿着的还是上一个空间的答案 ✗。
   *
   * ⚠️ 搭配：设置页「会话锁定」那一节的判据是**上面那个**（活动空间加不加密）而不是这个 ✓，理由可核：
   * 那一段给的是「**立即锁定**」，而内核 `lock_encryption_impl` 对**明文活动空间**是**直接报错拒绝**的
   * （逐字：「这个空间没有加密，没有什么可锁的」`security.rs`）⇒ 在明文空间上摆那颗按钮
   * ＝**给一个按下去就报错的按钮** ✗。
   * ⛔ 所以本类型**刻意没有**"本机有没有加密空间"那个字段 ✗ —— 它在本仓**没有正确的使用点**
   * （＝死读数 ✗），而两个真相源是靠"**两处说同一句话**"消掉的 ✓，不是靠多加一个字段 ✓。
   */
  locked: boolean;
  /** 是否已经从内核拿到过一次真实状态。首帧为 false，此时**不能**渲染应用外壳。 */
  ready: boolean;
  /**
   * ⭐ **锁定屏的出路**：本机上**没有加密**的那些空间（可以直接进，不需要口令 ✓）。
   *
   * ⚠️ **它不在 `refreshVault()` 里取** ✗ —— 那会让每次刷新都多打一次
   * `spaceSecurityOverview`，而既有用例拿"这条命令被调了几次"当"这一节重读过没有"的判据
   * （`SpacePrivacySection.test.ts:215`）⇒ 实测**当场红** ✓（+1 变成 +2 ✓）。
   * ⇒ 改成**按需取**：只有锁定屏真的要用它时才调 [`listPlaintextSpaces`] ✓
   * （锁定屏出现 ⇒ 闸门为真 ⇒ 那时才需要出路 ✓；平时**零额外调用** ✓）。
   */
  plaintextSpaces: { id: string; name: string }[];
  /**
   * ⚠️ **兼容别名，只有一个意思**：恒等于 [`activeSpaceEncrypted`] ✓。
   *
   * 留着它的唯一原因：本仓还有**两处写域之外**的既有用例读它
   * （`src/components/SpacePrivacySection.test.ts`、`src/components/lockScreen.test.ts`）✓。
   * ⛔ 它不是第二个语义 ✗ —— ⛔ 别往它上面加含义 ✗；新代码一律用上面那两个名字 ✓。
   */
  enabled: boolean;
};

const EMPTY: VaultState = {
  activeSpaceEncrypted: false,
  locked: false,
  ready: false,
  plaintextSpaces: [],
  enabled: false,
};

let state: VaultState = { ...EMPTY };
const listeners = new Set<(s: VaultState) => void>();

export function vaultState(): VaultState {
  return state;
}

export function subscribeVault(fn: (s: VaultState) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function publish(patch: Partial<VaultState>): VaultState {
  state = { ...state, ...patch };
  for (const fn of [...listeners]) fn(state);
  return state;
}

/** 仅供测试：把模块级状态复位，避免用例之间互相污染。 */
export function __resetVaultForTests(): void {
  state = { ...EMPTY };
  listeners.clear();
}

/** 一个空间算不算"加密空间" —— **就和内核同一把尺**（文件头是密的 或 袋里有它的盒子）✓。 */
function isEncryptedSpace(v: { encrypted_on_disk: boolean; in_keyring: boolean }): boolean {
  return v.encrypted_on_disk || v.in_keyring;
}

/**
 * 向内核问一次真实状态。Web 形态下 `encryption_status` 恒返回未开启。
 *
 * ⚠️ **只打 `encryption_status` 一条命令** ✓ —— 出路的清单走 [`listPlaintextSpaces`] 按需取 ✓
 * （为什么不能顺手在这里取：见 `plaintextSpaces` 的注释 —— 那会让既有判据红 ✓）。
 */
export async function refreshVault(): Promise<VaultState> {
  try {
    const s = await api.encryptionStatus();
    // ⭐ 内核的 `enabled` 就是按**活动空间**算的（见类型注释里的逐字出处 ✓）。
    return publish({
      activeSpaceEncrypted: !!s?.enabled,
      locked: !!s?.locked,
      ready: true,
      enabled: !!s?.enabled, // 兼容别名：恒等于 activeSpaceEncrypted ✓
    });
  } catch {
    // 问不到（无内核 / 命令缺失）时按「未开启」处理：宁可让人用，也不要卡在锁定屏。
    return publish({ ...EMPTY, ready: true });
  }
}

/**
 * ⭐ **按需**取"本机哪些空间是明文" —— 只有锁定屏要用（那条出路 ✓），所以**不放进** `refreshVault()` ✓。
 *
 * ⚠️ 读不到就**如实给空**：⛔ 不许摆一个点不动的空间名 ✗（那比没有出路更坏 ✓）。
 * ⚠️ 两个读数都走内核**本来就有**的面 ✓（`spaceSecurityOverview` ＋ `listWorkspaces` ✓ —— ⛔ 不新造命令 ✗）。
 */
export async function listPlaintextSpaces(): Promise<{ id: string; name: string }[]> {
  try {
    const [views, spaces] = await Promise.all([
      api.spaceSecurityOverview(),
      api.listWorkspaces(),
    ]);
    const nameOf = new Map(spaces.map((w) => [w.id, w.name]));
    return views
      .filter((v) => !isEncryptedSpace(v))
      .map((v) => ({ id: v.space_id, name: nameOf.get(v.space_id) ?? v.space_id }));
  } catch {
    return [];
  }
}

/** 解锁。口令不对时**状态不变**（仍然锁定），异常交给调用方显示。 */
export async function unlockVault(passphrase: string): Promise<VaultState> {
  await api.unlockEncryption(passphrase);
  return publish({ activeSpaceEncrypted: true, enabled: true, locked: false, ready: true });
}

/** 锁定：丢掉会话主密钥并关掉已解锁的连接，之后读不到内容，同步也会被拒。 */
export async function lockVault(): Promise<VaultState> {
  await api.lockEncryption();
  return publish({ activeSpaceEncrypted: true, enabled: true, locked: true, ready: true });
}

/**
 * ⭐ 从锁定屏**换到另一个（明文）空间** —— 闸门的出路 ✓。
 *
 * 换完**必须**再问一次内核：`activeSpaceEncrypted` 是按活动空间算的 ⇒ 新空间是明文的话
 * 它自己会变成 `false`，闸门随之放开 ✓（⛔ 不需要在这里判、也不许在这里判 ✗ ——
 * 那会变成"界面自己决定谁能开"✓）。
 */
export async function switchToSpace(id: string): Promise<VaultState> {
  await api.setActiveWorkspaceId(id);
  return refreshVault();
}

// ★ owner 第三轮拍板（2026-09-24）：原先还有一对 `enableVault` / `disableVault`
//（＝"应用级加密：全局一把钥匙，一开全加密"那套）。那两条命令与整套口径**一起删掉了** ——
// 加密现在**按空间**做（`SpacePrivacySection` 里的开启/关闭加密，走 `enable_space_encryption`），
// 所以"在这里开一次加密"这件事本身不再存在。
