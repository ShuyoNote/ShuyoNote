// scripts/check-macos-bundle.mjs 的单测。
//
// 这里最关键的一条是 `plistSchemes` 的**嵌套数组**用例：产物里的 plist 是
// `<key>CFBundleURLTypes</key><array><dict>…<key>CFBundleURLSchemes</key><array><string>shuyonote</string></array>…`
// ——外层数组里嵌着内层数组。用"先匹配外层 `<array>`、再找里面的 schemes"的写法会停在**内层**的
// `</array>`，解析出空列表，于是门禁把"注册好了"误报成"没注册"。这个 bug 真的发生过一次，
// 所以夹具用的是**真实产物的缩进（Tab）与嵌套形状**，而不是手写的简化版。

import { describe, expect, it } from "vitest";
import { checkBundle, plistSchemes, plistString } from "./check-macos-bundle.mjs";

/** 真实产物 Info.plist 的节选（Tab 缩进、数组嵌套、key 顺序都与 tauri 写出来的一致）。 */
const REAL_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleIdentifier</key>
\t<string>cn.shuyo.shuyonote</string>
\t<key>CFBundleShortVersionString</key>
\t<string>1.90.2</string>
\t<key>CFBundleVersion</key>
\t<string>1.90.2</string>
\t<key>CFBundleURLTypes</key>
\t<array>
\t\t<dict>
\t\t\t<key>CFBundleURLSchemes</key>
\t\t\t<array>
\t\t\t\t<string>shuyonote</string>
\t\t\t</array>
\t\t\t<key>CFBundleURLName</key>
\t\t\t<string>cn.shuyo.shuyonote shuyonote</string>
\t\t\t<key>CFBundleTypeRole</key>
\t\t\t<string>Editor</string>
\t\t</dict>
\t</array>
\t<key>LSRequiresCarbon</key>
\t<true/>
</dict>
</plist>
`;

const okArgs = (extra = {}) => ({
  appExists: true,
  isDirectory: true,
  plistXml: REAL_PLIST,
  expectedIdentifier: "cn.shuyo.shuyonote",
  expectedVersion: "1.90.2",
  dmgNames: ["ShuyoNote_1.90.2_aarch64.dmg"],
  // PDFium：默认给"两边都在且哈希一致"的健康形态（失败形态见下面三条用例）
  pdfiumBundleSha: "a".repeat(64),
  pdfiumVendorSha: "a".repeat(64),
  pdfiumVendorExists: true,
  ...extra,
});

describe("plistSchemes（嵌套数组是这里唯一的坑）", () => {
  it("真实产物形状（Tab 缩进 + 数组嵌套）能解析出 scheme", () => {
    expect(plistSchemes(REAL_PLIST)).toEqual(["shuyonote"]);
  });

  it("嵌套写法不会把内层 </array> 当成外层结束（回归：第一版就是这么误报的）", () => {
    const nested = `<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>shuyonote</string>
    </array>
    <key>CFBundleURLName</key>
    <string>x</string>
  </dict>
</array>`;
    expect(plistSchemes(nested)).toEqual(["shuyonote"]);
  });

  it("多个 scheme / 多个条目都能取到", () => {
    const multi = `<key>CFBundleURLSchemes</key>
<array><string>a</string><string>b</string></array>
<key>CFBundleURLSchemes</key>
<array><string>c</string></array>`;
    expect(plistSchemes(multi)).toEqual(["a", "b", "c"]);
  });

  it("没有 URL 注册时返回空数组", () => {
    expect(plistSchemes("<key>CFBundleIdentifier</key>\n<string>x</string>")).toEqual([]);
  });
});

describe("plistString", () => {
  it("取字符串与整数", () => {
    expect(plistString(REAL_PLIST, "CFBundleIdentifier")).toBe("cn.shuyo.shuyonote");
    expect(plistString("<key>CFBundleVersion</key>\n<integer>1090002</integer>", "CFBundleVersion")).toBe("1090002");
    expect(plistString(REAL_PLIST, "不存在的键")).toBeNull();
  });
});

describe("checkBundle", () => {
  it("全部正确 → 没有问题", () => {
    expect(checkBundle(okArgs())).toEqual([]);
  });

  it("identifier 不一致 → 报错（打包不会报，但用户端身份全变）", () => {
    const problems = checkBundle(okArgs({ plistXml: REAL_PLIST.replace("cn.shuyo.shuyonote", "com.example.x") }));
    expect(problems.join()).toMatch(/CFBundleIdentifier=com\.example\.x/);
  });

  it("版本号不一致 → 报错（更新通道会做错误比较）", () => {
    const problems = checkBundle(okArgs({ expectedVersion: "1.90.3" }));
    expect(problems.join()).toMatch(/CFBundleShortVersionString=1\.90\.2.*1\.90\.3/);
  });

  it("没注册 shuyonote 深链 → 报错（macOS 上点链接不会路由到应用）", () => {
    const noUrl = REAL_PLIST.replace(/<key>CFBundleURLTypes<\/key>[\s\S]*?<\/array>\n/, "");
    const problems = checkBundle(okArgs({ plistXml: noUrl }));
    expect(problems.join()).toMatch(/没有注册 shuyonote 深链协议/);
  });

  it("没有 .app / .app 不是目录 / 读不到 plist → 各自报错且不抛异常", () => {
    expect(checkBundle(okArgs({ appExists: false })).join()).toMatch(/没有找到 ShuyoNote\.app/);
    expect(checkBundle(okArgs({ isDirectory: false })).join()).toMatch(/不是目录/);
    expect(checkBundle(okArgs({ plistXml: null })).join()).toMatch(/读不到 .*Info\.plist/);
  });

  it("dmg 缺失或版本不对 → 报错", () => {
    expect(checkBundle(okArgs({ dmgNames: [] })).join()).toMatch(/没有 dmg/);
    expect(checkBundle(okArgs({ dmgNames: ["ShuyoNote_1.90.1_aarch64.dmg"] })).join()).toMatch(/没有版本号 1\.90\.2/);
  });

  // ★ PDFium（2026-09-19 加，macOS 侧）：它是运行时 dlopen 的，库不在包里时**装完不报错**，
  // 要到用户端 `SHUYONOTE_PDF_ENGINE=pdfium` 才变成「找不到 PDFium 动态库」——正是"失败得很晚"那一类。
  it("包里没有 libpdfium.dylib → 报错（说清映射位置与取库命令）", () => {
    const problems = checkBundle(okArgs({ pdfiumBundleSha: null })).join();
    expect(problems).toMatch(/Contents\/Frameworks\/libpdfium\.dylib 不在包里/);
    expect(problems).toMatch(/tauri\.macos\.conf\.json/);
    expect(problems).toMatch(/fetch-pdfium/);
  });

  it("包里的库与 vendor 源文件哈希不一致 → 报错（拷错了或是上次的产物）", () => {
    const problems = checkBundle(okArgs({ pdfiumBundleSha: "b".repeat(64) })).join();
    expect(problems).toMatch(/与 vendor 源文件 sha256 不一致/);
    expect(problems).toMatch(/aaaaaaaaaaaa… vs bbbbbbbbbbbb…|bbbbbbbbbbbb… vs aaaaaaaaaaaa…/);
  });

  // ★ 2026-09-22（P4 签名那一格）：签名**会改字节**，所以"包内 == vendor"只对未签名产物成立。
  //   判据必须把"签名后的正常"与"拷错了"分开说 —— 否则签名一落地，这条门禁就永久红。
  it("★ 哈希不同但**签名有效**（lib 严格校验 ＋ .app --deep --strict）⇒ 接受（签名后哈希一定会变）", () => {
    const problems = checkBundle(
      okArgs({ pdfiumBundleSha: "b".repeat(64), pdfiumLibSigned: true, appDeepStrictPassed: true }),
    );
    expect(problems).toEqual([]);
  });

  it("★ 哈希不同且**签名不完整** ⇒ 仍报错，并指向 sign-macos-app.mjs（不许把「签了一半」当通过）", () => {
    for (const partial of [
      { pdfiumLibSigned: true, appDeepStrictPassed: false },
      { pdfiumLibSigned: false, appDeepStrictPassed: true },
      { pdfiumLibSigned: false, appDeepStrictPassed: false },
    ]) {
      const problems = checkBundle(okArgs({ pdfiumBundleSha: "b".repeat(64), ...partial })).join();
      expect(problems).toMatch(/与 vendor 源文件 sha256 不一致/);
      expect(problems).toMatch(/不是一份签名有效的包/);
      expect(problems).toMatch(/sign-macos-app/);
    }
  });

  it("vendor 里没有库 → 报**前置缺失**（别把它说成产物问题）", () => {
    const problems = checkBundle(okArgs({ pdfiumBundleSha: null, pdfiumVendorExists: false })).join();
    expect(problems).toMatch(/vendor 里没有 mac-univ 的 PDFium/);
    expect(problems).toMatch(/前置缺失/);
    expect(problems).not.toMatch(/不在包里/);
  });
});
