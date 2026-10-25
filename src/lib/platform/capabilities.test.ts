// 平台能力判定的单测。
//
// 为什么值得单独测：判错的代价是"入口显示了、点下去必然失败"——
// 而移动端那条路**在开发机上根本走不到**（开发机是桌面），所以只能靠这里钉住。
import { describe, expect, it } from "vitest";
import { computeEmailSupported, isMacDesktopUserAgent, isMobileUserAgent } from "./capabilities";

describe("isMobileUserAgent", () => {
  it("认得 Android / iOS 的 UA", () => {
    expect(isMobileUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36")).toBe(true);
    expect(isMobileUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(true);
    expect(isMobileUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe(true);
  });

  it("桌面 UA 不算移动端", () => {
    expect(isMobileUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
    expect(isMobileUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(false);
    expect(isMobileUserAgent("Mozilla/5.0 (X11; Linux x86_64)")).toBe(false);
  });
});

describe("isMacDesktopUserAgent（原生透明标题栏只认 macOS 桌面）", () => {
  // 判错的代价：macOS 上漏判 ⇒ 内容被红绿灯压住；iPad 上误判 ⇒ 白让 28px 且没有红绿灯。
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

  it("认得 macOS 桌面（Chrome / WKWebView 两种写法）", () => {
    expect(isMacDesktopUserAgent(MAC)).toBe(true);
    expect(isMacDesktopUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36")).toBe(true);
  });

  it("Windows / Linux 不算 macOS", () => {
    expect(isMacDesktopUserAgent(WINDOWS)).toBe(false);
    expect(isMacDesktopUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")).toBe(false);
  });

  it("**iPadOS 的 Mac 伪装不算**（它的 UA 带 Macintosh + Mobile/）", () => {
    // 苹果从 iPadOS 13 起让 Safari 报桌面 UA —— 只按 "Macintosh" 判会误挂 macOS 的 CSS。
    expect(
      isMacDesktopUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(false);
    expect(isMacDesktopUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(false);
  });
});

describe("computeEmailSupported（聚合邮箱＝桌面专属）", () => {
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36";
  const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

  it("桌面 Tauri 壳：支持", () => {
    expect(computeEmailSupported(true, WINDOWS)).toBe(true);
  });

  it("**移动端 Tauri 壳：不支持** —— 这正是这次收窄的那条边界", () => {
    // 移动端同样是 Tauri（isDesktopPlatform() 也为真），所以这里**必须**按 OS 判，
    // 不能拿 isDesktopPlatform() 当近似：Rust 侧那 23 个邮箱命令在移动端带 #[cfg(desktop)]，
    // 压根不存在，调了只会拿到 "command not found"。
    expect(computeEmailSupported(true, ANDROID)).toBe(false);
    expect(computeEmailSupported(true, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(false);
  });

  it("Web 平台：不支持（命令是 stub，入口也不该显示）", () => {
    expect(computeEmailSupported(false, WINDOWS)).toBe(false);
    expect(computeEmailSupported(false, ANDROID)).toBe(false);
  });
});
