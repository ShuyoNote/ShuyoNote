// E2：口令锁的状态中枢。
//
// 为什么要有这一层：E1 的「锁定」原先只活在两个地方——`App` 里一次性的 `useState`
// 和设置页里各自的 `useState`。于是同一个事实有三个副本，谁也不通知谁：
//   · 在设置页点「立即锁定」后，界面**不会**切到锁定屏，用户继续看着已经读不出来的内容；
//   · 反过来 App 拿到锁定态时的早退又破坏了 hooks 顺序（见 App.tsx 里的闸门注释）。
// 现在状态只有一份、改动只有一个入口：谁改了锁的状态，谁就 publish，界面跟着动。
import { api } from "./api";

export type VaultState = {
  /** 是否已开启端到端加密。 */
  enabled: boolean;
  /** 本次会话是否需要口令才能读库（启动默认锁定，`PRAGMA key` 没落盘）。 */
  locked: boolean;
  /** 是否已经从内核拿到过一次真实状态。首帧为 false，此时**不能**渲染应用外壳。 */
  ready: boolean;
};

let state: VaultState = { enabled: false, locked: false, ready: false };
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
  state = { enabled: false, locked: false, ready: false };
  listeners.clear();
}

/** 向内核问一次真实状态。Web 形态下 `encryption_status` 恒返回未开启。 */
export async function refreshVault(): Promise<VaultState> {
  try {
    const s = await api.encryptionStatus();
    return publish({ enabled: !!s?.enabled, locked: !!s?.locked, ready: true });
  } catch {
    // 问不到（无内核 / 命令缺失）时按「未开启」处理：宁可让人用，也不要卡在锁定屏。
    return publish({ enabled: false, locked: false, ready: true });
  }
}

/** 解锁。口令不对时**状态不变**（仍然锁定），异常交给调用方显示。 */
export async function unlockVault(passphrase: string): Promise<VaultState> {
  await api.unlockEncryption(passphrase);
  return publish({ enabled: true, locked: false, ready: true });
}

/** 锁定：丢掉会话主密钥并关掉已解锁的连接，之后读不到内容，同步也会被拒。 */
export async function lockVault(): Promise<VaultState> {
  await api.lockEncryption();
  return publish({ enabled: true, locked: true, ready: true });
}

// ★ owner 第三轮拍板（2026-09-24）：原先还有一对 `enableVault` / `disableVault`
//（＝"应用级加密：全局一把钥匙，一开全加密"那套）。那两条命令与整套口径**一起删掉了** ——
// 加密现在**按空间**做（`SpacePrivacySection` 里的开启/关闭加密，走 `enable_space_encryption`），
// 所以"在这里开一次加密"这件事本身不再存在。
