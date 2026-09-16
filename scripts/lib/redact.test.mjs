// `redactSecrets` 的判据：**真凭据必须被抹掉，而正常日志不许被抹花**。
// 样本来自 2026-09-16 发 1.91.3 时那次真实泄漏（curl 失败的 message 里带着
// `-H Authorization: Bearer ghp_…`）以及仓库里在用的各类口令参数名。
import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact.mjs";

describe("redactSecrets", () => {
  it("Authorization: Bearer <token> 里的 token 必须没了（那次真实泄漏的形态）", () => {
    const leaked =
      'Command failed: curl.exe -sS -L --max-time 30 -H Authorization: Bearer ghp_AbCdEf0123456789xyz -H Accept: application/vnd.github+json https://api.github.com/repos/x/y';
    const out = redactSecrets(leaked);
    expect(out).not.toContain("ghp_AbCdEf0123456789xyz");
    expect(out).toContain("Bearer ***");
    // 其余信息要留着，否则出错时看不出跑的是什么命令
    expect(out).toContain("api.github.com/repos/x/y");
    expect(out).toContain("Accept: application/vnd.github+json");
  });

  it("各种 GitHub token 形态都不留原文", () => {
    for (const t of ["ghp_1234567890abcdef", "gho_1234567890abcdef", "ghs_1234567890abcdef", "github_pat_11ABCDEFG0abcdefghij"]) {
      const out = redactSecrets(`token=${t} 用完了`);
      expect(out, t).not.toContain(t);
    }
  });

  it("查询串里的 token / access_token / private_token 都被抹掉", () => {
    const out = redactSecrets(
      "GET https://gitcode.com/api?private_token=abc123XYZ&page=2  以及 access_token=def456&x=1 和 token=zzz",
    );
    expect(out).not.toContain("abc123XYZ");
    expect(out).not.toContain("def456");
    expect(out).not.toContain("zzz");
    expect(out, "不相关的参数要留着").toContain("page=2");
    expect(out).toContain("x=1");
  });

  it("URL 里的 user:pass@host 只抹口令", () => {
    const out = redactSecrets("clone https://cnzen:sup3rs3cret@gitcode.com/x/y.git");
    expect(out).not.toContain("sup3rs3cret");
    expect(out).toContain("cnzen:***@gitcode.com");
  });

  it("正常日志原样保留（不许把普通文字抹花）", () => {
    const s = "✓ 通道版本 = 仓库版本（1.91.3）；✓ 产物 URL 可达（HTTP 206）";
    expect(redactSecrets(s)).toBe(s);
    expect(redactSecrets("")).toBe("");
    expect(redactSecrets(null)).toBe("");
  });

  it("同一段里多个凭据一次抹干净", () => {
    const out = redactSecrets("a ghp_aaaaaaaaaaaa b Bearer ghs_bbbbbbbbbbbb c token=ccc");
    expect(out).not.toMatch(/ghp_|ghs_|ccc/);
  });
});
