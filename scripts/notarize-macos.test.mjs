// `scripts/notarize-macos.mjs` 的判据。
//
// 为什么值得单独判：公证链的失败形态几乎全是「看起来做了」——
//   · `notarytool submit` 说 Accepted，但**没 staple** ⇒ 离线机器仍被 Gatekeeper 拦，CI 全绿；
//   · 签名其实是 **ad-hoc** ⇒ `codesign --verify --deep --strict` 照样绿，只有 Apple 服务器会拒；
//   · 输出不是 JSON（notarytool 版本/输出变了）⇒ 若把「解析不了」当成通过，这一格就永久失守。
// 所以下面每一条都对着一个具体的「静默错」。

import { describe, expect, it } from "vitest";

import {
  ACCEPTED,
  codesignArgs,
  logArgs,
  parseNotaryLog,
  parseSubmit,
  signingAuthority,
  spctlArgs,
  stapleArgs,
  submitArgs,
  validateArgs,
  verdict,
} from "./notarize-macos.mjs";

const ENV_CREDS = { appleId: "dev@example.com", password: "abcd-efgh-ijkl-mnop", teamId: "ABCDE12345" };

describe("notarize-macos：notarytool 参数", () => {
  it("★ CI 形态：必须带 --wait 与 --output-format json（否则拿不到结构化状态）", () => {
    const args = submitArgs("ShuyoNote.zip", ENV_CREDS);
    expect(args).toContain("--wait");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--apple-id");
    expect(args).toContain("--team-id");
  });

  it("本机形态：只给 --keychain-profile，不许把密码塞进 argv", () => {
    const args = submitArgs("ShuyoNote.zip", { keychainProfile: "shuyonote-notary" });
    expect(args).toContain("--keychain-profile");
    expect(args).not.toContain("--password");
    expect(args).not.toContain("--apple-id");
  });

  it("取问题清单用的 log 命令与 submit 同凭据口径", () => {
    expect(logArgs("uuid-1", ENV_CREDS)).toContain("uuid-1");
    expect(logArgs("uuid-1", { keychainProfile: "p" })).not.toContain("--password");
  });

  it("staple 与 validate 是两条不同的命令（validate 才是判据）", () => {
    expect(stapleArgs("x.app")).toEqual(["stapler", "staple", "x.app"]);
    expect(validateArgs("x.app")).toEqual(["stapler", "validate", "x.app"]);
  });

  it("Gatekeeper 复核：.app 按 execute 评、.dmg 按主签名评", () => {
    expect(spctlArgs("app", "x.app")).toContain("execute");
    expect(spctlArgs("dmg", "x.dmg").join(" ")).toContain("primary-signature");
  });

  it("签名详情走 `codesign -d --verbose=4`", () => {
    expect(codesignArgs("x.app")).toEqual(["-d", "--verbose=4", "x.app"]);
  });
});

describe("notarize-macos：输出解析（解析不了 ≠ 通过）", () => {
  it("Accepted 的 JSON 解得出 id/status", () => {
    expect(parseSubmit('{"id":"11111111-2222","status":"Accepted","message":"ok"}')).toMatchObject({
      id: "11111111-2222",
      status: ACCEPTED,
    });
  });

  it("★ 非 JSON（notarytool 版本/输出变了）⇒ null，调用方必须判失败", () => {
    expect(parseSubmit("Current status: Accepted")).toBeNull();
    expect(parseSubmit("")).toBeNull();
  });

  it("缺 id 或 status 的 JSON 也不算成功（防「空对象读成绿」）", () => {
    expect(parseSubmit('{"status":"Accepted"}')).toBeNull();
    expect(parseSubmit('{"id":"x"}')).toBeNull();
  });

  it("log 里的 issues 逐条抽出来；形状不认识 ⇒ 空数组（不抛）", () => {
    const issues = parseNotaryLog({
      issues: [
        {
          severity: "error",
          path: "ShuyoNote.app/Contents/MacOS/shuyonote",
          message: "not signed with a valid Developer ID",
        },
        { severity: "warning", message: "irrelevant" },
      ],
    });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain("not signed with a valid Developer ID");
    expect(parseNotaryLog("not json")).toEqual([]);
  });
});

describe("notarize-macos：签名身份", () => {
  it("真实身份能取到 Authority 行", () => {
    const details = "Executable=x\nAuthority=Developer ID Application: Shuyo (ABCDE12345)\nTimestamp=...";
    expect(signingAuthority(details)).toBe("Developer ID Application: Shuyo (ABCDE12345)");
  });

  it("ad-hoc 详情里没有 Authority ⇒ null（这种包不可能过公证）", () => {
    expect(signingAuthority("Signature=adhoc\nIdentifier=cn.shuyo.shuyonote")).toBeNull();
    expect(signingAuthority("")).toBeNull();
  });
});

describe("notarize-macos：三件判据缺一不可", () => {
  const ok = {
    submit: { id: "u", status: ACCEPTED, message: "" },
    stapled: true,
    spctlOutput: "x.app: accepted\nsource=Notarized Developer ID",
    authority: "Developer ID Application: Shuyo (ABCDE12345)",
  };

  it("三条全过 ⇒ 没有 problem", () => {
    expect(verdict(ok, "app")).toEqual([]);
  });

  it("★ Accepted 但没装订 ⇒ 红（离线机器会被拦，CI 却全绿）", () => {
    expect(verdict({ ...ok, stapled: false }, "app").join()).toContain("stapler validate");
  });

  it("★ 状态不是 Accepted ⇒ 红", () => {
    expect(verdict({ ...ok, submit: { id: "u", status: "Invalid", message: "" } }, "app").join()).toContain(
      "Invalid",
    );
  });

  it("★ spctl 不是 accepted ⇒ 红", () => {
    expect(
      verdict({ ...ok, spctlOutput: "rejected, source=Unnotarized Developer ID" }, "app").join(),
    ).toContain("spctl");
  });

  it("★ ad-hoc 签名 ⇒ 红（报错会在 Apple 那侧，读起来像网络问题）", () => {
    expect(verdict({ ...ok, authority: null }, "app").join()).toContain("ad-hoc");
  });

  it("submit 输出解析不了 ⇒ 红，且理由写明", () => {
    expect(verdict({ ...ok, submit: null }, "app").join()).toContain("解析不了");
  });
});
