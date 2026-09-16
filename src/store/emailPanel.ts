import { create } from "zustand";
import { api, type EmailAccount } from "../lib/api";
import { accountKey } from "../lib/emailAccount";

// 邮箱（聚合收件箱）面板开关。用 store 以便：侧栏低调入口、全局快捷键 Ctrl+Shift+E、
// 命令面板等都能打开同一个面板，而不用各自维护 popover。
//
// 账号列表也放在这里，**作为唯一数据源**：设置（增/删/改账号）与邮箱面板
// （角标 / 定时收取 / 账号多选 / 账号下拉）读的是同一份。
export interface EmailPanelState {
  open: boolean;
  /** 未读数量（收件箱中未读邮件数），用于侧边栏邮箱图标角标。 */
  unread: number;
  /**
   * 已保存的 IMAP 账号列表——**单一数据源**。
   *
   * ⚠️ 为什么必须共享：这两处原先各持一份 `useState` 副本，靠各自挂载时读一次后端。
   * 于是「在设置里加账号」只改了后端与设置自己那份，**已经挂载的邮箱面板并不知情**
   * （2026-09-15 用户报障：加了账号，聚合邮箱不及时更新）。
   * 面板上受影响的是一整串：账号下拉、来源账号小标、多选筛选、未读角标、定时收取的 `auto_fetch` 过滤，
   * 以及"配置 IMAP 账号"那句空态提示（面板挂载时若一个账号都没有，加完账号它仍会一直那么显示）。
   */
  accounts: EmailAccount[];
  /** 是否已从后端读过一次账号列表（供面板挂载时判断要不要拉）。 */
  accountsLoaded: boolean;
  openPanel: () => void;
  closePanel: () => void;
  toggle: () => void;
  setUnread: (n: number) => void;
  /**
   * 从后端重读账号列表，返回读到的列表。
   *
   * ⚠️ **设置里增删改账号后必须调用**——面板手上那份列表不会自己变。
   * 这是本次修 bug 的关键动作：它不是"顺手刷新一下 UI"，而是唯一的跨组件同步点。
   */
  reloadAccounts: () => Promise<EmailAccount[]>;
  /** 只改本地列表里的某一项（如信任发件人后更新 `trusted_domains`），不重读后端。 */
  patchAccount: (a: EmailAccount) => void;
  /**
   * 保存（新增或更新）账号，然后重读列表——设置里点「保存」走这里。
   *
   * 之所以把"写后端 + 刷新列表"合成一个动作放进 store：只要它还散在组件里，
   * 就总有人写成"只改自己那份 state"，而**跨组件同步正是靠这个动作完成的**。
   * 合成在这里，设置与面板都不可能各改各的。
   */
  saveAccount: (a: EmailAccount) => Promise<EmailAccount[]>;
  /** 删除账号，然后重读列表。 */
  removeAccount: (a: EmailAccount) => Promise<EmailAccount[]>;
}

export const useEmailPanel = create<EmailPanelState>((set, get) => ({
  open: false,
  unread: 0,
  accounts: [],
  accountsLoaded: false,
  openPanel: () => set({ open: true }),
  closePanel: () => set({ open: false }),
  toggle: () => set((s) => ({ open: !s.open })),
  setUnread: (n) => set({ unread: n }),
  reloadAccounts: async () => {
    const list = await api.emailListAccounts();
    set({ accounts: list, accountsLoaded: true });
    return list;
  },
  patchAccount: (a) =>
    set((s) => {
      const k = accountKey(a);
      return { accounts: s.accounts.map((x) => (accountKey(x) === k ? a : x)) };
    }),
  saveAccount: async (a) => {
    await api.emailSaveAccount(a);
    return get().reloadAccounts();
  },
  removeAccount: async (a) => {
    await api.emailRemoveAccount(a);
    return get().reloadAccounts();
  },
}));
