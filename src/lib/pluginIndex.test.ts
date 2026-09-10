import { describe, expect, it } from "vitest";
import type { PluginIndexEntry, PluginIndexView } from "../types";
import {
  entryInstallable,
  entryMetaLine,
  entrySignatureNote,
  indexHost,
  indexSignatureLabel,
  indexSourceLabel,
  installConfirmMessage,
  loadIndexDraft,
  saveIndexDraft,
  INDEX_PUBKEY_KEY,
  INDEX_URL_KEY,
} from "./pluginIndex";

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
  permissions: [{ id: "read:pages", reason: "读本周有改动的页面标题" }],
  size: 2048,
  revoked: false,
  publisherSigned: false,
  blocked: "",
  ...over,
});

const view = (over: Partial<PluginIndexView> = {}): PluginIndexView => ({
  indexVersion: 1,
  owner: { id: "shuyo-community", name: "数友社区", url: "https://example.com" },
  generatedAt: "2026-09-10T12:00:00Z",
  signatureVerified: null,
  plugins: [entry()],
  ...over,
});

describe("索引来源", () => {
  it("显示拥有者名字 + 域名，而不是含糊的「某索引」", () => {
    expect(indexSourceLabel(view(), "https://example.com/p/index.json")).toBe(
      "数友社区（example.com）",
    );
    // 没有 owner 名字时退回域名；两者都没有才说"未知来源"
    expect(indexSourceLabel(view({ owner: null }), "https://a.test/x.json")).toBe("a.test");
    expect(indexSourceLabel(view({ owner: null }), "")).toBe("未知来源");
  });

  it("从 URL 取域名（含端口与查询串）", () => {
    expect(indexHost("https://example.com:8443/p/index.json?x=1")).toBe("example.com:8443");
    expect(indexHost("http://127.0.0.1:8099/index.json")).toBe("127.0.0.1:8099");
  });
});

describe("签名状态必须一眼能分辨", () => {
  it("没验过就明说没验过，并且是 warn", () => {
    const { text, level } = indexSignatureLabel(view());
    expect(level).toBe("warn");
    expect(text).toContain("没有校验");
    expect(text).toContain("sha256");
  });

  it("验过才说验过", () => {
    const { text, level } = indexSignatureLabel(view({ signatureVerified: true }));
    expect(level).toBe("ok");
    expect(text).toContain("校验通过");
  });

  it("发布者签名阶段 1 一律标注「不校验」，不许写成「已签名」就完事", () => {
    const note = entrySignatureNote(entry({ publisherSigned: true }));
    expect(note).toContain("不校验");
    expect(note).toContain("阶段 2");
    expect(entrySignatureNote(entry())).toBe("无发布者签名");
  });
});

describe("条目与安装确认", () => {
  it("副标题把发布者、版本、体积、许可、运行时都说清楚", () => {
    const line = entryMetaLine(entry());
    expect(line).toContain("发布者 alice");
    expect(line).toContain("v1.2.0");
    expect(line).toContain("2 KiB");
    expect(line).toContain("MIT");
    expect(line).toContain("运行时 logic");
  });

  it("被撤回/需要更新版本时不可安装，并原样给出理由", () => {
    expect(entryInstallable(entry()).ok).toBe(true);
    const bad = entryInstallable(entry({ blocked: "已被索引撤回：有严重漏洞" }));
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain("撤回");
  });

  it("确认框摊开权限理由，并明确说「没有人工审查」", () => {
    const msg = installConfirmMessage(entry(), "数友社区（example.com）", false);
    expect(msg).toContain("read:pages —— 读本周有改动的页面标题");
    expect(msg).toContain("没有人工审查");
    expect(msg).toContain("没有校验签名");
    // 填了公钥时说法要跟着变，不能永远说"没验"
    expect(installConfirmMessage(entry(), "x", true)).toContain("已用你填的公钥校验通过");
    // 权限理由缺失时不许留空——空着会让人以为是"不要权限"
    const naked = entry({ permissions: [{ id: "read:pages", reason: "" }] });
    expect(installConfirmMessage(naked, "x", true)).toContain("作者没写理由");
    expect(installConfirmMessage(entry({ permissions: [] }), "x", true)).toContain(
      "不申请任何数据权限",
    );
  });
});

describe("地址草稿", () => {
  it("记得上次填的地址与公钥", () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    saveIndexDraft(storage, "https://example.com/i.json", "RWQf6LRC");
    expect(storage.getItem(INDEX_URL_KEY)).toBe("https://example.com/i.json");
    expect(storage.getItem(INDEX_PUBKEY_KEY)).toBe("RWQf6LRC");
    expect(loadIndexDraft(storage)).toEqual({
      url: "https://example.com/i.json",
      pubkey: "RWQf6LRC",
    });
  });

  it("localStorage 抛异常时不影响界面打开", () => {
    const boom = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
    };
    expect(loadIndexDraft(boom)).toEqual({ url: "", pubkey: "" });
    expect(() => saveIndexDraft(boom, "a", "b")).not.toThrow();
  });
});
