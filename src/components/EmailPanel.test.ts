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
  /** 面板注册的事件处理器（currently 只有 `email-unread`）：测试里手动触发它。 */
  listeners: {} as Record<string, (e: { payload: unknown }) => void>,
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
    event: {
      // 记下处理器，好让判据能手动推一条 `email-unread` 事件（后端轮询推的就是它）。
      listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
        mocks.listeners[name] = cb;
        return () => {
          delete mocks.listeners[name];
        };
      },
    },
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

import { EmailPanel, countBlockedImages, sanitizeEmailHtml, stripRemoteCssUrls } from "./EmailPanel";
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

// **「聚合邮箱收不到某个账号今天的新邮件」——2026-09-20 用户报障的回归。**
//
// 事故两层，都在"界面不说实话"上：
//   ① 后端 `email_fetch_all` 把拉取失败的账号 `Err(_) => {}` **整个吞掉** ⇒ 它的邮件在列表里
//      整账号消失，界面既不报错也不提示，用户只看到"这封信没来"；
//   ② 后台轮询只推**未读数**（`email-unread`），**不会**把新信塞进列表 ⇒ 面板开着时列表是一张
//      快照，"角标涨了、列表里却没有那封信"。
// 下面两条各盯一半。
describe("聚合邮箱：账号拉不到要说清 ＋ 未读变多要自动重拉（2026-09-20 用户报障）", () => {
  const a = acc("a@x.com");
  const b = acc("b@x.com");
  const meta = (uid: number, subject: string, owner: EmailAccount): EmailMeta => ({
    uid,
    subject,
    from: "someone@x.com",
    date: new Date().toUTCString(),
    snippet: "",
    seen: true,
    flagged: false,
    folder: "INBOX",
    account: accountKey(owner),
  });

  it("★ 某个账号拉取失败 ⇒ 面板**点名说清**（账号 + 原因），且不许把它当成「没有新邮件」", async () => {
    useEmailPanel.setState({ open: true, unread: 0, accounts: [a, b], accountsLoaded: true });
    mocks.fetchAll.mockResolvedValue({
      emails: [meta(1, "来自 a 的信", a)],
      unread: 0,
      accounts: [accountKey(a), accountKey(b)],
      // 后端现在会把失败如实带回来（`EmailAccountError`）
      errors: [{ account: accountKey(b), message: "登录失败: 认证失败" }],
    });
    mount();
    await settle();

    // a 的信照常显示
    expect(document.querySelectorAll(".email-item")).toHaveLength(1);
    // ★ b 失败这件事必须出现在界面上：账号名 + 后端原文
    const text = document.body.textContent ?? "";
    expect(text).toContain("b@x.com 拉取失败：登录失败: 认证失败");
    expect(text).toContain("这一轮不在列表里");
  });

  it("★ 未读数**变多** ⇒ 自动重拉列表（角标涨了，列表里也得有那封信）", async () => {
    useEmailPanel.setState({ open: true, unread: 0, accounts: [a], accountsLoaded: true });
    mocks.fetchAll.mockResolvedValue({ emails: [meta(1, "第一封", a)], unread: 1, accounts: [accountKey(a)], errors: [] });
    mount();
    await settle();
    const afterMount = mocks.fetchAll.mock.calls.length;
    expect(afterMount).toBeGreaterThan(0);

    // 后台轮询第一次报未读 1：只是"当前值"，**不该**因此重拉（没有"变多"这个信号）
    mocks.listeners["email-unread"]?.({ payload: 1 });
    await settle();
    expect(mocks.fetchAll.mock.calls.length).toBe(afterMount);

    // 第二次报 3 ⇒ 变多了 ⇒ 必须重拉（这就是"新信到了列表却不更新"的修法）
    mocks.listeners["email-unread"]?.({ payload: 3 });
    await settle();
    expect(mocks.fetchAll.mock.calls.length).toBeGreaterThan(afterMount);
  });
});

// **「信件拉取时间有点长，界面没反馈，体验不好」——2026-09-20 用户反馈的回归。**
//
// 事故：聚合是**串行**拉每个账号的每个文件夹（账号多/信多时十几秒很正常），而界面只有一个
// `busy` 布尔量 —— 用户面对的是一动不动的列表，分不清"在跑"还是"卡死了"。
// 修法两层：①后端逐账号推 `email-fetch-progress`，界面显示「正在拉取 3/5 · 账号」+ 进度条；
// ②前端每秒刷新「已 Ns」。另外「拉取」按钮不再顺手重扫月份（那会把一次拉取拖成两倍时长）。
describe("拉取要有反馈（2026-09-20 用户反馈「拉取时间有点长，界面没反馈」）", () => {
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

  it("★ 拉取中显示「正在拉取 N/M · 账号 · 已 Ns」+ 进度条；拉完自动消失", async () => {
    useEmailPanel.setState({ open: true, unread: 0, accounts: [me], accountsLoaded: true });
    let finish: ((v: unknown) => void) | null = null;
    mocks.fetchAll.mockImplementation(() => new Promise((res) => { finish = res; }));
    mount();
    await settle();

    // 还在拉（promise 没 settle）⇒ 状态条必须在
    expect(document.querySelector(".email-fetch-status")).not.toBeNull();
    // 后端推「第 2 个账号拉完，共 5 个」
    mocks.listeners["email-fetch-progress"]?.({ payload: { done: 2, total: 5, account: "imap.example.com|b@x.com" } });
    await settle();

    const bar = document.querySelector(".email-fetch-status");
    const text = bar?.textContent ?? "";
    expect(text).toContain("正在拉取 2/5");
    // 账号显示成用户名（不是 host|username 整串）
    expect(text).toContain("b@x.com");
    expect(text).not.toContain("imap.example.com|b@x.com");
    // 秒数由前端计（两次后端事件之间可能隔十几秒，光有进度还是像卡住）
    expect(text).toMatch(/已 \d+s/);
    expect(document.querySelector<HTMLElement>(".email-fetch-status .sync-progressbar-fill")?.style.width).toBe("40%");

    // 拉完 ⇒ 状态条收掉，不留一个永远转圈的"正在拉取"
    finish!({ emails: [meta(1, "信")], unread: 0, accounts: [accountKey(me)], errors: [] });
    await settle();
    expect(document.querySelector(".email-fetch-status")).toBeNull();
  });

  it("★ 点「拉取」不再顺手重扫月份（重扫所有账号所有文件夹＝拉取时长翻倍）", async () => {
    useEmailPanel.setState({ open: true, unread: 0, accounts: [me], accountsLoaded: true });
    mocks.fetchAll.mockResolvedValue({ emails: [meta(1, "信")], unread: 0, accounts: [accountKey(me)], errors: [] });
    mount();
    await settle();
    const monthsBefore = mocks.listMonths.mock.calls.length;
    const fetchBefore = mocks.fetchAll.mock.calls.length;

    // happy-dom 里量不到宽度 ⇒ 头部按钮会被收进「更多」下拉，先展开再找（真实窗口下它就在外面）。
    const byText = (needle: string) =>
      Array.from(document.querySelectorAll<HTMLElement>("button")).find((b) =>
        (b.textContent ?? "").includes(needle),
      );
    if (!byText("拉取")) {
      byText("更多")!.click();
      await settle();
    }
    const btn = byText("拉取");
    expect(btn, "找不到「拉取」按钮").toBeTruthy();
    btn!.click();
    await settle();

    expect(mocks.fetchAll.mock.calls.length).toBeGreaterThan(fetchBefore);
    expect(mocks.listMonths.mock.calls.length).toBe(monthsBefore);
  });
});

// **「数友社区的 logo 显示不出来」——2026-09-20 用户截图的回归（界面这一半）。**
//
// 截图里那行是「[碎图] 数友社区」：`<img>` 被我们默认拦下（src 挪进 data-src）后浏览器画碎图图标，
// 再拼上发件人写的 alt。判据盯三件事：
//   ① 拦下的图**不能**再让浏览器画碎图 —— 占位 src 必须是内联的透明图；
//   ② 用户得知道"有图没加载、原因是什么"，而不是以为发信人没发图；
//   ③ 点「显示图片」后原图地址要回来（追踪防护是可逆的）。
describe("邮件外部图片：占位不碎图 + 明说有几张没加载（2026-09-20 用户截图）", () => {
  const me = { ...acc("a@x.com"), auto_trust_senders: false };
  const meta: EmailMeta = {
    uid: 7,
    subject: "确认订阅",
    from: "数友社区 <community@shuyo.cn>",
    date: new Date().toUTCString(),
    snippet: "",
    seen: true,
    flagged: false,
    folder: "INBOX",
    account: accountKey(me),
  };
  const LOGO = "https://community.shuyo.cn/logo.png";
  const HTML = `<p>你好</p><img src="${LOGO}" width="120" height="40" alt="数友社区"><img src="cid:inline-logo" alt="内嵌">`;

  const mountWithMail = async () => {
    useEmailPanel.setState({ open: true, unread: 0, accounts: [me], accountsLoaded: true });
    mocks.fetchAll.mockResolvedValue({ emails: [meta], unread: 0, accounts: [accountKey(me)], errors: [] });
    mocks.getMessage.mockResolvedValue({ text: "你好", html: HTML });
    mount();
    await settle();
  };

  it("★ 拦下的远程图给透明占位（不画碎图）+ 横幅说「1 张外部图片未加载」；点显示图片后原址回来", async () => {
    await mountWithMail();

    const img = document.querySelector<HTMLImageElement>(".email-rich-body img");
    expect(img).not.toBeNull();
    // ① 不能是碎图：拦下时 src 必须是内联透明图，原址留在 data-src
    expect(img!.getAttribute("data-img-blocked")).toBe("1");
    expect(img!.getAttribute("data-src")).toBe(LOGO);
    expect(img!.getAttribute("src") ?? "").toMatch(/^data:image\/gif;base64,/);
    // 占位块沿用邮件里写的宽高，别让 120×40 的 logo 撑成方块
    expect(img!.getAttribute("style") ?? "").toContain("width:120px");
    expect(img!.getAttribute("style") ?? "").toContain("height:40px");

    // ② 横幅：说清有几张、为什么、并给一键放行
    const bar = document.querySelector(".email-img-blocked-bar");
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain("1 张外部图片未加载");
    expect(bar!.textContent).toContain("防跟踪");
    expect(bar!.textContent).toContain("显示图片");
    // `cid:` 内嵌图不算"外部图片"（它不联网），别把它数进去
    expect(countBlockedImages(document.querySelector(".email-rich-body")!.innerHTML)).toBe(1);

    // ③ 点「显示图片」⇒ 原址回来、横幅收掉
    Array.from(bar!.querySelectorAll<HTMLElement>("button"))
      .find((b) => (b.textContent ?? "").includes("显示图片"))!
      .click();
    await settle();
    expect(document.querySelector(".email-img-blocked-bar")).toBeNull();
    const after = document.querySelector<HTMLImageElement>(".email-rich-body img");
    expect(after!.getAttribute("src")).toBe(LOGO);
    expect(after!.getAttribute("data-img-blocked")).toBeNull();
  });

  it("内嵌图的 data: URI 原样留着，且不算「未加载的外部图片」（后端把 cid: 内联成 data:，靠这条显示 logo）", () => {
    const src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
    // 注意外面那层 <div>：happy-dom 里 DOMPurify **等于没做事**（2026-09-21 实测：默认配置下
    // `<script>` 都原样返回），只剩"最外层元素的标签被吃掉"这个怪相 —— `<p>x</p>` → `x`、
    // 单独一个 `<img>` → 空串。真浏览器没这个毛病（同日真 Chromium+真 DOMPurify 读数：
    // 消毒后 img 仍在、src 是 21746 字符的 data:image/png、`naturalWidth/Height = 308/60`）。
    // 所以本文件只钉"我们自己的后处理"，不钉"DOMPurify 清没清干净"（那样会是一条假判据，
    // 详见 `src/lib/mdPreviewHtml.test.ts` 顶部那段环境事实）。
    const clean = sanitizeEmailHtml(`<div><img src="${src}" alt="数友社区" width="154" height="30"></div>`, false);
    // DOMPurify 必须放行 img 的 data: URI（放行不了的话 logo 照样显示不出来）
    expect(clean).toContain(src);
    expect(clean).toContain('alt="数友社区"');
    // data: 不联网 ⇒ 不该被算成"未加载"，也不该被换成透明占位
    expect(countBlockedImages(clean)).toBe(0);
    expect(clean).not.toContain("data-img-blocked");
  });

  it("远程背景图被清掉，但相对路径的 url() 留着（剔掉只会让本来能显示的图变没）", () => {
    expect(stripRemoteCssUrls("background:url(https://track.example.com/b.gif)")).not.toContain("track.example.com");
    expect(stripRemoteCssUrls('background:url("//cdn.example.com/b.png")')).not.toContain("cdn.example.com");
    expect(stripRemoteCssUrls("background:url(/assets/logo.png)")).toContain("/assets/logo.png");
    // 清成 none 而不是空串：`background:;` 是无效声明，会连带把整条样式丢掉
    expect(stripRemoteCssUrls("background:url(https://t.example.com/b.gif)")).toContain("none");
  });
});
