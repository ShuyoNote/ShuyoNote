import { describe, expect, it } from "vitest";
import type { PluginIndexEntry, PluginIndexView } from "../types";
import {
  addedPermissions,
  compareVersions,
  entryAction,
  entryInstallable,
  entryMetaLine,
  entrySignatureNote,
  indexHost,
  indexSignatureLabel,
  indexSourceLabel,
  publisherKeyChanged,
  installConfirmMessage,
  loadIndexDraft,
  revocationNotice,
  revokedKeyNotice,
  revokedKeysSummary,
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
  publisherKeyFingerprint: "",
  blocked: "",
  ...over,
});

const view = (over: Partial<PluginIndexView> = {}): PluginIndexView => ({
  indexVersion: 1,
  owner: { id: "shuyo-community", name: "数友社区", url: "https://example.com" },
  generatedAt: "2026-09-10T12:00:00Z",
  signatureVerified: null,
  revokedKeys: [],
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

  it("没带发布者签名时，说清 sha256 能证明什么、不能证明什么", () => {
    const note = entrySignatureNote(entry());
    expect(note.level).toBe("none");
    expect(note.text).toContain("只有 sha256");
    expect(note.text).toContain("不能证明是谁发布的");
  });

  it("带了签名且与本地固定的一致 → 说「一致」并给出指纹", () => {
    const note = entrySignatureNote(
      entry({ publisherSigned: true }),
      { fingerprint: "abcd-ef01-2345-6789" },
      "abcd-ef01-2345-6789",
    );
    expect(note.level).toBe("ok");
    expect(note.text).toContain("与已固定的公钥一致");
    expect(note.text).toContain("abcd-ef01-2345-6789");
  });

  it("首次见到这把 key：说清「装上之后会固定它」", () => {
    const note = entrySignatureNote(entry({ publisherSigned: true }), null, "abcd-ef01-2345-6789");
    expect(note.text).toContain("首次安装会固定下来");
    expect(note.text).toContain("换 key 就拒绝安装");
  });

  it("**公钥变了**是最该被看见的一种：两个指纹都要摆出来", () => {
    const note = entrySignatureNote(
      entry({ publisherSigned: true }),
      { fingerprint: "aaaaaaaa-1111" },
      "bbbbbbbb-2222",
    );
    expect(note.level).toBe("warn");
    expect(note.text).toContain("发布者公钥变了");
    expect(note.text).toContain("aaaaaaaa-1111");
    expect(note.text).toContain("bbbbbbbb-2222");
    expect(publisherKeyChanged(entry({ publisherSigned: true }), { fingerprint: "a" }, "b")).toBe(true);
    // 没带签名 / 没有固定记录 / 指纹一致 → 都不算"变了"
    expect(publisherKeyChanged(entry(), { fingerprint: "a" }, "b")).toBe(false);
    expect(publisherKeyChanged(entry({ publisherSigned: true }), null, "b")).toBe(false);
    expect(publisherKeyChanged(entry({ publisherSigned: true }), { fingerprint: "a" }, "a")).toBe(false);
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

  it("升级时确认框说清「替换」与「新增了哪几项权限」", () => {
    const msg = installConfirmMessage(entry({ version: "2.0.0" }), "数友社区（example.com）", false, "1.0.0", [
      { id: "write:pages", reason: "写入周报页" },
    ]);
    expect(msg).toContain("「升级」");
    expect(msg).toContain("v1.0.0 会被替换成 v2.0.0");
    expect(msg).toContain("这次升级新增了 1 项权限");
    expect(msg).toContain("write:pages —— 写入周报页");
    expect(msg).toContain("确认之后才会恢复运行");
    // 同版本：说成重装，而不是升级
    const same = installConfirmMessage(entry(), "x", false, "1.2.0", []);
    expect(same).toContain("「重装」");
    expect(same).not.toContain("会被替换成 v");
    // 全新安装：不该出现任何"替换/新增"的字样
    const fresh = installConfirmMessage(entry(), "x", false, null, []);
    expect(fresh).not.toContain("「升级」");
    expect(fresh).not.toContain("新增");
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

describe("升级 / 重装 / 拒绝降级", () => {
  it("版本比较与后端同一口径（逐段比，比不出来返回 null）", () => {
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1-rc.1", "1.0.1")).toBe(0);
    expect(compareVersions("1.2", "1.3")).toBeNull();
    expect(compareVersions("v2", "1.0.0")).toBeNull();
  });

  it("没装过就是安装", () => {
    expect(entryAction(entry()).action).toBe("install");
    expect(entryAction(entry(), null).label).toBe("安装");
  });

  it("装过更旧的 → 升级，按钮上写清目标版本", () => {
    const act = entryAction(entry({ version: "1.3.0" }), "1.2.0");
    expect(act.action).toBe("upgrade");
    expect(act.label).toBe("升级到 v1.3.0");
  });

  it("同版本 → 重装（修好被改坏的目录），不假装是升级", () => {
    const act = entryAction(entry(), "1.2.0");
    expect(act.action).toBe("reinstall");
    expect(act.label).toContain("重装");
  });

  it("已装更新的版本 → 不让点，并说清怎么办", () => {
    const act = entryAction(entry({ version: "1.0.0" }), "1.2.0");
    expect(act.action).toBe("newer-installed");
    expect(act.reason).toContain("已装更新的版本 v1.2.0");
    expect(act.reason).toContain("先卸载");
  });

  it("已被索引撤回的条目：连升级都不给", () => {
    const act = entryAction(entry({ blocked: "已被索引撤回：有严重漏洞" }), "1.0.0");
    expect(act.action).toBe("blocked");
    expect(act.reason).toContain("撤回");
  });

  it("新增权限只算「这次多出来的」", () => {
    const two = entry({
      permissions: [
        { id: "read:pages", reason: "读标题" },
        { id: "write:pages", reason: "写入周报页" },
      ],
    });
    // 已装的那版只有 read:pages → 这次多出来的是 write:pages
    expect(addedPermissions(two, { permissions: [{ id: "read:pages" }] }).map((p) => p.id)).toEqual([
      "write:pages",
    ]);
    // 没装过就谈不上"新增"（那是全新安装，权限清单本来就全部要确认）
    expect(addedPermissions(two, null)).toEqual([]);
    expect(addedPermissions(two, { permissions: [] })).toHaveLength(2);
    // 已装的权限这版没有了（作者缩权）→ 不算"新增"
    expect(addedPermissions(entry(), { permissions: [{ id: "read:pages" }, { id: "write:pages" }] })).toEqual([]);
  });
});

describe("已装插件被撤回（离线记忆）", () => {
  it("没撤回就不显示任何东西", () => {
    expect(revocationNotice(null)).toEqual({ text: "", blocked: false });
    expect(revocationNotice(undefined).text).toBe("");
  });

  it("被撤回且用户没表态：界面必须说「运行已被拦下」，并给出两个出口", () => {
    const n = revocationNotice({ version: "1.0.0", reason: "有严重漏洞", ignored: false });
    expect(n.blocked).toBe(true);
    expect(n.text).toContain("运行已被拦下");
    expect(n.text).toContain("有严重漏洞");
    expect(n.text).toContain("v1.0.0");
  });

  it("原因缺失也要说得出话（不许留空，空着会像「没有原因所以不严重」）", () => {
    const n = revocationNotice({ version: "1.0.0", reason: "   ", ignored: false });
    expect(n.text).toContain("没有写原因");
  });

  it("用户表过态「仍然使用」：不再拦，但照旧如实写着（别装作没这回事）", () => {
    const n = revocationNotice({ version: "1.0.0", reason: "有严重漏洞", ignored: true });
    expect(n.blocked).toBe(false);
    expect(n.text).toContain("你选择继续使用");
    expect(n.text).toContain("有严重漏洞");
  });
});

describe("发布者密钥被撤回（比撤回版本更重）", () => {
  it("没撤回就不显示", () => {
    expect(revokedKeyNotice(null)).toEqual({ text: "", blocked: false });
  });

  it("被撤回且没表态：说清「签名它的密钥被撤回」「运行已被拦下」并给出指纹", () => {
    const n = revokedKeyNotice({ fingerprint: "aaaa-1111-2222-3333", reason: "这把 key 泄露了", ignored: false });
    expect(n.blocked).toBe(true);
    expect(n.text).toContain("签名它的发布者密钥已被索引撤回");
    expect(n.text).toContain("这把 key 泄露了");
    expect(n.text).toContain("aaaa-1111-2222-3333");
    // 用词要和"版本被撤回"分开——两件事的严重程度不一样，用户得一眼看出是哪种
    expect(n.text.startsWith("签名它的发布者密钥")).toBe(true);
    expect(revocationNotice({ version: "1.0.0", reason: "r", ignored: false }).text.startsWith("已被索引撤回")).toBe(true);
  });

  it("原因缺失也要说得出话", () => {
    expect(revokedKeyNotice({ fingerprint: "f", reason: "  ", ignored: false }).text).toContain(
      "没有写原因",
    );
  });

  it("用户表过态：不再拦，但照旧如实写着", () => {
    const n = revokedKeyNotice({ fingerprint: "f", reason: "泄露", ignored: true });
    expect(n.blocked).toBe(false);
    expect(n.text).toContain("你选择继续使用");
  });

  it("索引撤回了哪几把 key 要列出来（指纹 + 原因 + 时间）", () => {
    expect(revokedKeysSummary([])).toBe("");
    const summary = revokedKeysSummary([
      { fingerprint: "aaaa-1111", reason: "泄露", revokedAt: "2026-09-01" },
      { fingerprint: "bbbb-2222", reason: "" },
    ]);
    expect(summary).toContain("撤回了 2 把发布者密钥");
    expect(summary).toContain("aaaa-1111 —— 泄露（2026-09-01）");
    expect(summary).toContain("bbbb-2222 —— 没写原因");
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
