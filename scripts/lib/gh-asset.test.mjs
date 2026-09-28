// `gh-asset.mjs` 的判据 —— 这一族的风险是**取错东西** 与 **泄凭据**，两件都不报错，所以逐条钉。

import { describe, expect, it } from "vitest";

import {
  assetApiUrl,
  classifyCurlExit,
  curlBinName,
  curlResolveArgs,
  describeHttpStatus,
  pickAsset,
  releaseApiUrl,
  shouldFallbackToCurl,
  verifySha,
} from "./gh-asset.mjs";

const A = [
  { id: 1, name: "pdfium-win-x64.tgz", size: 10 },
  { id: 2, name: "pdfium-linux-x64.tgz", size: 20 },
  { id: 3, name: "ShuyoNote_1.91.26_android-arm64-release.apk.sha256", size: 65 },
];

describe("Release 端点", () => {
  it("`latest` 与空都走 releases/latest；给了 tag 就走 releases/tags/<tag>", () => {
    expect(releaseApiUrl("a/b", "latest")).toBe("https://api.github.com/repos/a/b/releases/latest");
    expect(releaseApiUrl("a/b", "")).toBe("https://api.github.com/repos/a/b/releases/latest");
    expect(releaseApiUrl("a/b", "v1.2.3")).toBe("https://api.github.com/repos/a/b/releases/tags/v1.2.3");
  });

  it("资产下载端点用 id（配 octet-stream 会 302 到 objects.githubusercontent.com）", () => {
    expect(assetApiUrl("a/b", 42)).toBe("https://api.github.com/repos/a/b/releases/assets/42");
  });
});

describe("按名字挑资产", () => {
  it("唯一命中 ⇒ 给出那一个", () => {
    const r = pickAsset(A, "linux-x64");
    expect(r.ok).toBe(true);
    expect(r.asset.name).toBe("pdfium-linux-x64.tgz");
  });

  it("★ 多个命中 ⇒ **不猜**，把候选都列出来（「我以为是那份」是静默取错）", () => {
    const r = pickAsset(A, "pdfium");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("many");
    expect(r.hits).toHaveLength(2);
    expect(r.message).toContain("更精确");
  });

  it("一个都没命中 ⇒ 把现有资产名列出来（否则人不知道自己该写什么子串）", () => {
    const r = pickAsset(A, "nosuch");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("none");
    expect(r.message).toContain("pdfium-win-x64.tgz");
  });

  it("空/畸形输入不炸", () => {
    expect(pickAsset(undefined, "x").ok).toBe(false);
    expect(pickAsset([{ id: 1 }], "x").ok).toBe(false);
    expect(pickAsset(A, "").ok).toBe(false); // 空子串会命中全部 ⇒ 走 many
    expect(pickAsset(A, "").reason).toBe("many");
  });
});

describe("该不该退到 curl --resolve", () => {
  it("★ 只有**网络类**失败才退（与 gh-fetch 的约束②③同口径）", () => {
    expect(shouldFallbackToCurl({ ok: false, status: null, failure: { kind: "network", code: "ETIMEDOUT" } })).toBe(true);
    expect(shouldFallbackToCurl({ ok: false, status: null, failure: { kind: "network", code: "ENOTFOUND" } })).toBe(true);
  });

  it("★ 404 / 401 / 403 / 5xx / 已成功 ⇒ **都不退**（结果类不是网络类）", () => {
    for (const status of [404, 401, 403, 500, 503, 429, 200]) {
      expect(shouldFallbackToCurl({ ok: status === 200, status, failure: null }), `HTTP ${status}`).toBe(false);
    }
    expect(shouldFallbackToCurl(null)).toBe(false);
    expect(shouldFallbackToCurl({ ok: false, status: null, failure: { kind: "other", code: "x" } })).toBe(false);
  });
});

describe("curl argv", () => {
  it("★ 按名字找 `curl`（不写死 curl.exe）+ `--resolve host:443:ip`", () => {
    expect(curlBinName()).toBe("curl");
    const args = curlResolveArgs("https://api.github.com/repos/a/b/releases/assets/42", "140.82.112.6", { out: "C:\\tmp\\x.tgz" });
    expect(args).toContain("--resolve");
    expect(args).toContain("api.github.com:443:140.82.112.6");
    expect(args).toContain("-o");
    expect(args).toContain("C:\\tmp\\x.tgz");
    expect(args.at(-1)).toBe("https://api.github.com/repos/a/b/releases/assets/42");
    expect(args.join(" ")).not.toMatch(/curl\.exe/);
  });

  it("★ **凭据绝不进 argv**：要带凭据只能走 `--config <文件>`（argv 会被 ps/错误信息捞到）", () => {
    const args = curlResolveArgs("https://api.github.com/x", "1.2.3.4", { configPath: "C:\\tmp\\curl.cfg" });
    expect(args).toContain("--config");
    expect(args.join(" ")).not.toMatch(/Authorization|Authorization:|Bearer|ghp_/);
  });

  it("端口缺省按 443 拼 `--resolve`；显式端口原样用", () => {
    expect(curlResolveArgs("https://api.github.com/x", "1.2.3.4")).toContain("api.github.com:443:1.2.3.4");
    expect(curlResolveArgs("https://api.github.com:8443/x", "1.2.3.4")).toContain("api.github.com:8443:1.2.3.4");
  });

  it("★ 可以要 `-w` 把状态码带回 stdout（`curl -s` 不看状态码 ⇒ 404 会被当成功体）", () => {
    const without = curlResolveArgs("https://api.github.com/x", "1.2.3.4");
    expect(without).not.toContain("-w"); // 不传就不带，别偷偷改行为
    const withW = curlResolveArgs("https://api.github.com/x", "1.2.3.4", { writeOut: "__S__%{http_code}" });
    expect(withW).toContain("-w");
    expect(withW).toContain("__S__%{http_code}");
    expect(withW.at(-1)).toBe("https://api.github.com/x"); // `-w` 的值在 URL 之前，URL 仍在最后
  });
});

describe("HTTP 状态码翻人话", () => {
  it("★ 404/401/403/5xx/429 都是「结果类」⇒ **不换路**，且措辞点明「不是网络故障」", () => {
    for (const s of [404, 401, 403, 500, 503, 429]) {
      const r = describeHttpStatus(s);
      expect(r.ok, `HTTP ${s}`).toBe(false);
      expect(r.fallback, `HTTP ${s}`).toBe(false);
    }
    expect(describeHttpStatus(404).reason).toBe("notfound");
    expect(describeHttpStatus(404).message).toContain("不是网络故障");
    expect(describeHttpStatus(403).message).toContain("权限");
  });

  it("2xx/3xx 与「没拿到状态码」分开判（200 才是 ok；缺码不算 ok）", () => {
    expect(describeHttpStatus(200).ok).toBe(true);
    expect(describeHttpStatus(302).ok).toBe(false);
    expect(describeHttpStatus(302).reason).toBe("redirect");
    expect(describeHttpStatus(null).ok).toBe(false);
    expect(describeHttpStatus(undefined).reason).toBe("unknown");
  });
});

describe("curl 退出码分类（给「第一条路是 curl」的调用方）", () => {
  it("★ 只有网络类退出码才准换路：6/7/18/28/35/52/55/56", () => {
    for (const c of [6, 7, 18, 28, 35, 52, 55, 56]) {
      expect(classifyCurlExit(c).kind, `exit ${c}`).toBe("network");
      expect(classifyCurlExit(c).fallback, `exit ${c}`).toBe(true);
    }
  });

  it("★ 22（`--fail` 的 HTTP ≥400）是结果类；60/47/未知码也不换路", () => {
    expect(classifyCurlExit(22).kind).toBe("http");
    expect(classifyCurlExit(22).fallback).toBe(false);
    expect(classifyCurlExit(22).message).toContain("不换路");
    expect(classifyCurlExit(60).fallback).toBe(false);
    expect(classifyCurlExit(47).fallback).toBe(false);
    expect(classifyCurlExit(1).kind).toBe("other");
    expect(classifyCurlExit(undefined).fallback).toBe(false);
  });
});

describe("期望哈希", () => {
  it("没给期望值 ⇒ **skipped**（别假装通过）", () => {
    const r = verifySha("a".repeat(64), "");
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("skipped");
    expect(r.message).toContain("未校验");
  });

  it("一致（大小写不敏感）／不一致（两边都打前 12 位）", () => {
    const sha = "0123456789abcdef".repeat(4);
    expect(verifySha(sha, sha.toUpperCase()).kind).toBe("match");
    const bad = verifySha(sha, "f".repeat(64));
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("0123456789ab");
    expect(bad.message).toContain("ffffffffffff");
  });

  it("期望值形状不对 ⇒ 单独一类（不是「不一致」）", () => {
    const r = verifySha("a".repeat(64), "not-a-hash");
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("bad-expectation");
  });
});
