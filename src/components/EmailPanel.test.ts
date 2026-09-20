// **「设置里加了邮箱账号，聚合邮箱要立刻知道」——2026-09-15 用户报障的回归测试。**
//
// 事故：设置（`SettingsDialog` 的邮箱区）与邮箱面板（`EmailPanel`）**各持一份 `useState` 账号副本**，
// 各自只在自己挂载时读一次后端。于是「在设置里加账号」只改了后端与设置自己那份，
// **已经挂载的面板并不知情**——账号下拉、来源账号小标、多选筛选、未读角标、
// 定时收取的 `auto_fetch` 过滤，全都停在旧列表。
// 最扎眼的一种：面板挂载时一个账号都没有，用户去设置里加完回来，
// 它仍然显示「去配置邮箱账号」。
//
// 修法：账号列表收敛到 `store/emailPanel` 作为**单一数据源**，设置那边增删改后调用
// `reloadAccounts()`。本文件盯两件事：
//   ① store 的契约（reload 后订阅者读到新列表；patch 只改匹配项）；
//   ② **真正的回归**——不重挂载面板，只把 store 的列表换掉，面板必须跟着变。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

const mocks = vi.hoisted(() => ({
  listAccounts: vi.fn<() => Promise<unknown[]>>(),
  listFolders: vi.fn<() => Promise<string[]>>(),
  listMonths: vi.fn<() => Promise<string[]>>(),
  fetchAll: vi.fn<() => Promise<unknown>>(),
  unseen: vi.fn<() => Promise<number>>(),
  saveAccount: vi.fn<() => Promise<void>>(),
  removeAccount: vi.fn<() => Promise<void>>(),
  moveMany: vi.fn<() => Promise<number>>(),
  getMessage: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../lib/api", () => ({
  api: {
    emailListAccounts: mocks.listAccounts,
    emailListFolders: mocks.listFolders,
    emailFetchAllMonths: mocks.listMonths,
    emailFetchAll: mocks.fetchAll,
    emailUnseenCount: mocks.unseen,
    emailSaveAccount: mocks.saveAccount,
    emailRemoveAccount: mocks.removeAccount,
    emailMoveManyToTrash: mocks.moveMany,
    emailGetMessage: mocks.getMessage,
  },
}));

vi.mock("../lib/platform", () => ({
  emailSupported: () => true,
  isDesktopPlatform: () => true,
  platform: {
    event: { listen: async () => () => {} },
    dialog: { open: async () => null },
  },
}));

// 面板只用到 editor 的 openSettings（空态按钮里），以及 notes/ai 的读取。
vi.mock("../store/editor", () => ({
  useEditorStore: Object.assign(() => ({}), { getState: () => ({ openSettings: () => {} }) }),
}));
vi.mock("../store/notes", () => ({
  useNotes: Object.assign(() => ({}), { getState: () => ({}) }),
}));
vi.mock("../store/ai", () => ({
  useAiStore: Object.assign(() => ({}), { getState: () => ({ config: null }) }),
}));
vi.mock("../store/toast", () => ({ toast: () => {} }));

import { EmailPanel } from "./EmailPanel";
import { useEmailPanel } from "../store/emailPanel";
import { accountKey } from "../lib/emailAccount";
import type { EmailAccount, EmailMeta } from "../lib/api";

/** 一个完整形状的账号（`toAccount` 会按这些字段补全）。 */
function acc(username: string): EmailAccount {
  return {
    host: "imap.example.com",
    port: 993,
    username,
    password: "p",
    use_tls: true,
    auto_fetch: false,
    interval_minutes: 15,
    smtp_host: "",
    smtp_port: 465,
    smtp_security: "ssl",
    smtp_user: "",
    smtp_pass: "",
    trusted_domains: [],
    auto_trust_senders: true,
  };
}

let root: ReturnType<typeof createRoot> | null = null;

const mount = () => {
  flushSync(() => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    root.render(React.createElement(EmailPanel));
  });
};

/** 等挂载期那些 promise 效应落地：微任务 + 一个宏任务各刷一次。 */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync(() => {});
  await new Promise((r) => setTimeout(r, 0));
  flushSync(() => {});
};

beforeEach(() => {
  mocks.listAccounts.mockReset();
  mocks.listFolders.mockReset();
  mocks.listMonths.mockReset();
  mocks.fetchAll.mockReset();
  mocks.unseen.mockReset();
  mocks.saveAccount.mockReset();
  mocks.removeAccount.mockReset();
  mocks.moveMany.mockReset();
  mocks.getMessage.mockReset();
  mocks.moveMany.mockResolvedValue(0);
  mocks.getMessage.mockResolvedValue({ text: "", html: "" });
  mocks.saveAccount.mockResolvedValue(undefined);
  mocks.removeAccount.mockResolvedValue(undefined);
  mocks.listFolders.mockResolvedValue(["INBOX"]);
  mocks.listMonths.mockResolvedValue([]);
  mocks.fetchAll.mockResolvedValue({ emails: [], unread: 0, accounts: [] });
  mocks.unseen.mockResolvedValue(0);
  // 面板挂了 4 处未加保护的 `new ResizeObserver`：happy-dom 未必提供，显式 stub 掉。
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useEmailPanel.setState({ open: true, unread: 0, accounts: [], accountsLoaded: false });
});

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("邮箱账号列表是单一数据源（store/emailPanel）", () => {
  it("reloadAccounts 后，任何订阅者读到的都是新列表", async () => {
    mocks.listAccounts.mockResolvedValue([acc("a@x.com")]);
    await useEmailPanel.getState().reloadAccounts();
    expect(useEmailPanel.getState().accounts.map((a) => a.username)).toEqual(["a@x.com"]);
    expect(useEmailPanel.getState().accountsLoaded).toBe(true);

    // 模拟「用户在设置里又加了一个账号」→ 设置那边 reload
    mocks.listAccounts.mockResolvedValue([acc("a@x.com"), acc("b@x.com")]);
    await useEmailPanel.getState().reloadAccounts();
    expect(useEmailPanel.getState().accounts.map((a) => a.username)).toEqual(["a@x.com", "b@x.com"]);
  });

  it("patchAccount 只改 key 匹配的那一条，不动其它账号", async () => {
    mocks.listAccounts.mockResolvedValue([acc("a@x.com"), acc("b@x.com")]);
    await useEmailPanel.getState().reloadAccounts();

    const changed = { ...acc("b@x.com"), trusted_domains: ["x.com"] };
    useEmailPanel.getState().patchAccount(changed);

    const list = useEmailPanel.getState().accounts;
    expect(list).toHaveLength(2);
    expect(list[0].username).toBe("a@x.com");
    expect(list[0].trusted_domains).toEqual([]);
    expect(list[1].trusted_domains).toEqual(["x.com"]);
  });
});

describe("设置里的增删账号走 store 的动作（写后端 + 重读列表合在一起）", () => {
  it("saveAccount 保存后列表立刻含新账号", async () => {
    mocks.listAccounts.mockResolvedValue([acc("a@x.com")]);
    await useEmailPanel.getState().reloadAccounts();

    // 用户在设置里填了第二个账号并保存 → 后端此后返回两条
    mocks.listAccounts.mockResolvedValue([acc("a@x.com"), acc("b@x.com")]);
    await useEmailPanel.getState().saveAccount(acc("b@x.com"));

    expect(mocks.saveAccount).toHaveBeenCalledTimes(1);
    expect(useEmailPanel.getState().accounts.map((a) => a.username)).toEqual(["a@x.com", "b@x.com"]);
  });

  it("removeAccount 删除后列表立刻不含该账号", async () => {
    mocks.listAccounts.mockResolvedValue([acc("a@x.com"), acc("b@x.com")]);
    await useEmailPanel.getState().reloadAccounts();

    mocks.listAccounts.mockResolvedValue([acc("a@x.com")]);
    await useEmailPanel.getState().removeAccount(acc("b@x.com"));

    expect(mocks.removeAccount).toHaveBeenCalledTimes(1);
    expect(useEmailPanel.getState().accounts.map((a) => a.username)).toEqual(["a@x.com"]);
  });
});

describe("设置里加了账号，已挂载的邮箱面板要跟着变（2026-09-15 回归）", () => {
  it("面板挂载时没有账号 → 加完账号不用重挂载，空态就该消失", async () => {
    // ① 面板先挂起来，此时后端一个账号都没有
    mocks.listAccounts.mockResolvedValue([]);
    mount();
    await settle();
    expect(document.body.textContent).toContain("去配置邮箱账号");
    expect(document.querySelector(".email-split")).toBeNull();

    // ② 用户去设置里加了账号——修好的那一步就是设置会调用 store 的 reloadAccounts
    mocks.listAccounts.mockResolvedValue([acc("me@x.com")]);
    await useEmailPanel.getState().reloadAccounts();
    await settle();

    // ③ 关键：**全程没有重挂载面板**，界面必须已经更新
    expect(document.body.textContent).not.toContain("去配置邮箱账号");
    expect(document.querySelector(".email-split")).not.toBeNull();
  });

  it("已有 1 个账号时再加 1 个 → 多账号筛选器出现（说明面板拿到的是 2 个）", async () => {
    mocks.listAccounts.mockResolvedValue([acc("a@x.com")]);
    mount();
    await settle();
    // 单账号不显示账号筛选器（避免每行重复）
    expect(document.querySelector(".email-account-filter-btn")).toBeNull();

    mocks.listAccounts.mockResolvedValue([acc("a@x.com"), acc("b@x.com")]);
    await useEmailPanel.getState().reloadAccounts();
    await settle();

    expect(document.querySelector(".email-account-filter-btn")).not.toBeNull();
    expect(useEmailPanel.getState().accounts).toHaveLength(2);
  });
});

// **「批量删除以后，重新拉取后依然出现」——2026-09-20 用户报障的回归。**
//
// 事故：后端 `email_move_many_to_trash` 在阿里云企业邮上一个字节都没删掉（见 email.rs 里那段
// 注释），但命令"写进 socket 就算成功"，于是它返回 `Ok(0)`；界面**不看这个 0**，照样把选中的行
// 从列表里拿掉、还弹一句"已删除 N 封" —— 用户一刷新，邮件全回来了。
//
// 这条判据盯界面这一半：**后端说删了几封，界面就只能拿掉几行**；少一封就如实报错并重新拉取。
describe("批量删除：后端没删掉，界面不许说删掉了（2026-09-20 用户报障的回归）", () => {
  const me = acc("a@x.com");
  const meta = (uid: number, subject: string): EmailMeta => ({
    uid,
    subject,
    from: "someone@x.com",
    date: new Date().toUTCString(),
    snippet: "",
    seen: true,
    flagged: false,
    folder: "INBOX",
    account: accountKey(me),
  });

  /** 挂载面板，列表里放两封邮件，并把两封都勾上。 */
  const mountWithTwoChecked = async () => {
    useEmailPanel.setState({ open: true, unread: 0, accounts: [me], accountsLoaded: true });
    mocks.fetchAll.mockResolvedValue({
      emails: [meta(1, "第一封"), meta(2, "第二封")],
      unread: 0,
      accounts: [accountKey(me)],
    });
    vi.stubGlobal("confirm", () => true);
    mount();
    await settle();
    expect(document.querySelectorAll(".email-item")).toHaveLength(2);
    document.querySelectorAll<HTMLElement>(".email-check").forEach((el) => el.click());
    await settle();
  };

  it("后端一封都没删掉（moved=0）⇒ 两行都留着，并明说删失败", async () => {
    await mountWithTwoChecked();
    mocks.moveMany.mockResolvedValue(0);

    document.querySelector<HTMLElement>(".email-list-head-delete")!.click();
    await settle();

    expect(mocks.moveMany).toHaveBeenCalledTimes(1);
    // 关键：**没删掉就不能从列表里消失**（旧代码这里会变成 0 行）
    expect(document.querySelectorAll(".email-item")).toHaveLength(2);
    expect(document.body.textContent).toContain("只删除成功 0/2 封");
  });

  it("后端真删掉了两封（moved=2）⇒ 两行都拿掉", async () => {
    await mountWithTwoChecked();
    mocks.moveMany.mockResolvedValue(2);

    document.querySelector<HTMLElement>(".email-list-head-delete")!.click();
    await settle();

    expect(mocks.moveMany).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(".email-item")).toHaveLength(0);
  });
});
