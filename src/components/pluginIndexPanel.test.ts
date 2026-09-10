// **「从索引安装」面板：它给用户看的是不是实话？** —— 挂起来点一遍。
//
// 为什么必须是渲染级测试：这一屏的全部价值在于"如实交代"——来源是谁、签名验没验、
// 权限要什么、哪条不能装。文案层已经被 pluginIndex.test.ts 逐句断言过，但**接线**
// （面板把 url/pubkey/id 传对了吗？被撤回的条目按钮真的点不动吗？确认框真的挡在前面吗？）
// 只有真的挂起来、点一下才知道；接错了不会报错，只会静默地装错东西。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../i18n";

const fetchPluginIndex = vi.fn();
const installPluginFromIndex = vi.fn(async () => ({ name: "周报生成" }));
vi.mock("../lib/api", () => ({
  api: {
    fetchPluginIndex: (...a: unknown[]) => fetchPluginIndex(...a),
    installPluginFromIndex: (...a: unknown[]) => installPluginFromIndex(...a),
    listPlugins: async () => [],
  },
}));
// 确认框一律点"确定"——本测试要验的是"确定之后拿什么去安装"。
const confirmDialog = vi.fn(async () => true);
vi.mock("../store/confirm", () => ({ confirmDialog: (...a: unknown[]) => confirmDialog(...a) }));

import { PluginIndexPanel } from "./PluginIndexPanel";
import { usePlugins } from "../store/plugins";
import type { PluginIndexEntry, PluginIndexView } from "../types";

const entry = (over: Partial<PluginIndexEntry> = {}): PluginIndexEntry => ({
  id: "weekly-report",
  name: "周报生成",
  version: "1.2.0",
  apiVersion: "1.0.0",
  runtime: "logic",
  description: "汇总本周改动",
  publisher: "alice",
  license: "MIT",
  homepage: "",
  discussionUrl: "",
  permissions: [
    { id: "read:pages", reason: "读本周有改动的页面标题" },
    { id: "write:pages", reason: "写入周报页（先给草稿）" },
  ],
  size: 2048,
  revoked: false,
  publisherSigned: false,
  blocked: "",
  ...over,
});

const view = (plugins: PluginIndexEntry[], signatureVerified: boolean | null = null): PluginIndexView => ({
  indexVersion: 1,
  owner: { id: "self", name: "我自己的索引", url: "https://example.com" },
  generatedAt: "2026-09-10T12:00:00Z",
  signatureVerified,
  plugins,
});

function mount(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(node));
  return root;
}

const text = () => document.body.textContent ?? "";
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".pm-index-item > button"));

/** 输入框受控：直接派发 input 事件才能让 React 收到新值。 */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function pull(url: string, pubkey = "") {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(".pm-index-form input"));
  flushSync(() => {
    type(inputs[0], url);
    if (pubkey) type(inputs[1], pubkey);
  });
  const btn = document.querySelector<HTMLButtonElement>(".pm-index-form button")!;
  flushSync(() => btn.click());
  // 拉取是异步的：让它跑完再断言
  await vi.waitFor(() => expect(document.querySelector(".pm-index-source")).toBeTruthy());
}

describe("从索引安装面板", () => {
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    fetchPluginIndex.mockReset();
    installPluginFromIndex.mockClear();
    confirmDialog.mockClear();
    window.localStorage.clear();
    usePlugins.setState({ plugins: [], managerOpen: true });
  });

  afterEach(() => {
    if (root) flushSync(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    window.localStorage.clear();
  });

  it("拉到索引后：来源、签名状态、权限与理由都摊在界面上", async () => {
    fetchPluginIndex.mockResolvedValue(view([entry()]));
    root = mount(React.createElement(PluginIndexPanel));
    await pull("https://example.com/plugin-index.json");

    expect(fetchPluginIndex).toHaveBeenCalledWith("https://example.com/plugin-index.json", null);
    expect(text()).toContain("我自己的索引（example.com）");
    // 没填公钥 → 必须明说"没有校验"
    expect(text()).toContain("没有校验");
    expect(text()).toContain("read:pages —— 读本周有改动的页面标题");
    expect(text()).toContain("write:pages —— 写入周报页（先给草稿）");
    expect(text()).toContain("无发布者签名");
    expect(buttons()[0].disabled).toBe(false);
  });

  it("填了公钥就带过去；发布者签名只显示「带了、未校验」", async () => {
    fetchPluginIndex.mockResolvedValue(view([entry({ publisherSigned: true })], true));
    root = mount(React.createElement(PluginIndexPanel));
    await pull("https://example.com/plugin-index.json", "RWQf6LRC");

    expect(fetchPluginIndex).toHaveBeenCalledWith("https://example.com/plugin-index.json", "RWQf6LRC");
    expect(text()).toContain("校验通过");
    expect(text()).toContain("带发布者签名（本版本不校验");
    // 拉成功过才记住地址（打错了不该被记住）
    expect(window.localStorage.getItem("shuyonote.pluginIndexUrl")).toBe(
      "https://example.com/plugin-index.json",
    );
    expect(window.localStorage.getItem("shuyonote.pluginIndexPubkey")).toBe("RWQf6LRC");
  });

  it("被撤回 / 需要更新版本的条目：按钮点不动，理由写在旁边", async () => {
    fetchPluginIndex.mockResolvedValue(
      view([
        entry({ id: "revoked-one", name: "旧东西", revoked: true, blocked: "已被索引撤回：有严重漏洞" }),
        entry({ id: "too-new", name: "未来的东西", blocked: "需要应用 2.0.0+（当前 1.87.0）" }),
      ]),
    );
    root = mount(React.createElement(PluginIndexPanel));
    await pull("https://example.com/i.json");

    expect(text()).toContain("已被索引撤回：有严重漏洞");
    expect(text()).toContain("需要应用 2.0.0+（当前 1.87.0）");
    for (const b of buttons()) {
      expect(b.disabled).toBe(true);
      expect(b.getAttribute("title")).toBeTruthy(); // 点不动也要说清为什么
    }
    // 点不动就是点不动：不该发出任何安装请求
    flushSync(() => buttons()[0].click());
    expect(installPluginFromIndex).not.toHaveBeenCalled();
  });

  it("点安装：确认框在前，确认后按 地址+id+公钥 发起安装", async () => {
    fetchPluginIndex.mockResolvedValue(view([entry()]));
    root = mount(React.createElement(PluginIndexPanel));
    await pull("https://example.com/plugin-index.json", "RWQf6LRC");

    flushSync(() => buttons()[0].click());
    await vi.waitFor(() => expect(installPluginFromIndex).toHaveBeenCalled());
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    const confirmArgs = confirmDialog.mock.calls[0][0] as unknown as { message: string };
    expect(confirmArgs.message).toContain("read:pages —— 读本周有改动的页面标题");
    expect(confirmArgs.message).toContain("没有人工审查");
    expect(installPluginFromIndex).toHaveBeenCalledWith(
      "https://example.com/plugin-index.json",
      "weekly-report",
      "RWQf6LRC",
    );
  });

  it("用户在确认框里取消 → 一个字节都不下载", async () => {
    confirmDialog.mockResolvedValueOnce(false);
    fetchPluginIndex.mockResolvedValue(view([entry()]));
    root = mount(React.createElement(PluginIndexPanel));
    await pull("https://example.com/plugin-index.json");

    flushSync(() => buttons()[0].click());
    await Promise.resolve();
    expect(installPluginFromIndex).not.toHaveBeenCalled();
  });

  it("拉取失败：把后端原话显示出来，而不是留个空列表", async () => {
    fetchPluginIndex.mockRejectedValue(new Error("地址必须是 https"));
    root = mount(React.createElement(PluginIndexPanel));
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(".pm-index-form input"));
    flushSync(() => type(inputs[0], "http://example.com/i.json"));
    flushSync(() => document.querySelector<HTMLButtonElement>(".pm-index-form button")!.click());
    await vi.waitFor(() => expect(document.querySelector(".pm-index-error")).toBeTruthy());
    expect(text()).toContain("地址必须是 https");
    expect(document.querySelector(".pm-index-source")).toBeNull();
    // 失败时不该记住这个地址
    expect(window.localStorage.getItem("shuyonote.pluginIndexUrl")).toBeNull();
  });
});
