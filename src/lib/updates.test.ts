// 更新清单读取（`fetchUpdateManifest`）的**行为契约**测试。
//
// 为什么值得钉：清单里新增了 `platforms["android-aarch64"]`（APK 地址 + `sha256:<hex>` 指纹），
// 而读它的代码与**桌面更新读的是同一份 latest.json、同一个函数**。源码注释写着
// 「清单里没有这个平台键时是 null —— 老清单照常可读，桌面更新不受影响」，这句话此前**没有任何
// 测试钉着**。而它一旦不成立，坏的不是 Android 一个入口：桌面那三个字段一起解析不出来，
// 症状只是"点检查更新什么都不发生"（没有报错）——正是这个通道最容易悄悄回归的地方。
// 所以这里逐条钉：有新键怎么读、缺新键怎么退化、畸形输入不抛、以及**当前实现没做哪些校验**。
//
// 形状取自真实产物：`release/v1.84.0/latest.json`（老清单，只有 windows/linux 两个平台键）
// 与 `scripts/release.mjs` 现在写出的清单（多一个 android-aarch64，signature 是 `sha256:<64hex>`）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUpdateManifest, LATEST_MANIFEST_URL } from "./updates";

/** 真实的 apk 字节指纹形状：`sha256:` + 64 位小写 hex（此处是 8 组 8 字符，凑满 64）。 */
const APK_SHA256 = "42457c12deadbeef00112233445566778899aabbccddeeff0011223344556677";

const APK_URL =
  "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/v1.91.0/ShuyoNote_1.91.0_android-arm64-release.apk";
const WIN_URL =
  "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/v1.91.0/ShuyoNote_1.91.0_x64-setup.exe";
const LINUX_URL =
  "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/v1.91.0/ShuyoNote_1.91.0_amd64.AppImage";

/** 桌面平台条的 signature 是 minisign 的 base64 大块（这里只留开头，形状对即可）。 */
const MINISIGN_SIG = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkK";

const NOTES = "块操作体系重构 + 文字选中优先（安装后可在应用内「检查更新」升级）";
const PUB_DATE = "2026-09-14T00:00:00Z";

interface Manifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

/** **老清单**：只有桌面两个平台键，没有 android-aarch64。 */
function oldManifest(): Manifest {
  return {
    version: "1.91.0",
    notes: NOTES,
    pub_date: PUB_DATE,
    platforms: {
      "windows-x86_64": { signature: MINISIGN_SIG, url: WIN_URL },
      "linux-x86_64": { signature: MINISIGN_SIG, url: LINUX_URL },
    },
  };
}

/** 新清单：老清单 + `platforms["android-aarch64"]`（apk 免 `.sig`，指纹写在 signature 里）。 */
function manifestWithAndroid(entry: Record<string, unknown> = { url: APK_URL, signature: `sha256:${APK_SHA256}` }): Manifest {
  const m = oldManifest();
  m.platforms["android-aarch64"] = entry as { signature: string; url: string };
  return m;
}

/** 最小假响应：被测代码只碰 `ok` 与 `json()`（形状同 ocr.test.ts 的桩）。 */
function respond(payload: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 404, json: async () => payload });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchUpdateManifest —— 清单里的 Android 发版件", () => {
  it("有 android-aarch64 且 signature 是 sha256:<64hex> → 地址原样取出，指纹是**剥掉前缀**的 hex", async () => {
    expect(APK_SHA256).toHaveLength(64); // 夹具本身先自证形状，免得后面对着一个假 hex 断言
    fetchMock.mockImplementation(() => respond(manifestWithAndroid()));

    const m = (await fetchUpdateManifest())!;
    expect(m).not.toBeNull();
    expect(m.android_url).toBe(APK_URL);
    expect(m.android_sha256).toBe(APK_SHA256);
    expect(m.android_sha256).not.toContain("sha256:");
    // 桌面要的三个字段一个不少（同一份清单、同一个返回对象）
    expect(m.version).toBe("1.91.0");
    expect(m.notes).toBe(NOTES);
    expect(m.pub_date).toBe(PUB_DATE);
    // 默认读的是稳定发布渠道——android 条目就活在这份清单里，换 URL 就等于 Android 收不到更新
    expect(fetchMock).toHaveBeenCalledWith(LATEST_MANIFEST_URL, { method: "GET" });
  });

  it("**老清单（没有 android-aarch64）→ 两个 Android 字段都是 null，而桌面字段照常解析**", async () => {
    // 先确认夹具真的"老"：这个键在 platforms 里确实不存在（而不是值为 null）
    expect(Object.keys(oldManifest().platforms)).not.toContain("android-aarch64");
    fetchMock.mockImplementation(() => respond(oldManifest()));

    const m = await fetchUpdateManifest();
    // 整对象逐字段比：既钉"Android 两个 null"，也钉"桌面三个字段一个没变"
    expect(m).toEqual({
      version: "1.91.0",
      notes: NOTES,
      pub_date: PUB_DATE,
      android_url: null,
      android_sha256: null,
    });
  });

  it("platforms 整个缺失 → 不抛；三个桌面字段照常，Android 两个是 null", async () => {
    fetchMock.mockImplementation(() => respond({ version: "1.91.0", notes: NOTES, pub_date: PUB_DATE }));

    await expect(fetchUpdateManifest()).resolves.toEqual({
      version: "1.91.0",
      notes: NOTES,
      pub_date: PUB_DATE,
      android_url: null,
      android_sha256: null,
    });
  });

  it("清单本身是 null / 数组 / 标量 → 不抛；返回**全 null 的对象**（不是 null）", async () => {
    // 钉的是现实现：`j?.platforms?...` 对任何非对象 JSON 都退化成 undefined，
    // 而函数体始终返回一个对象——所以调用方拿到的永远不是 null（都靠 `?.` 与逐字段判空）。
    for (const payload of [null, 42, "x", [], true]) {
      fetchMock.mockImplementation(() => respond(payload));
      const m = await fetchUpdateManifest();
      expect(m, `payload=${JSON.stringify(payload)} 不该返回 null`).not.toBeNull();
      expect(m).toEqual({ version: null, notes: null, pub_date: null, android_url: null, android_sha256: null });
    }
  });

  it("android 条的 signature 是桌面那种 minisign base64（没有 sha256: 前缀）→ 地址照给，指纹为 null", async () => {
    fetchMock.mockImplementation(() => respond(manifestWithAndroid({ url: APK_URL, signature: MINISIGN_SIG })));

    const m = (await fetchUpdateManifest())!;
    expect(m.android_url).toBe(APK_URL);
    expect(m.android_sha256).toBeNull();
  });

  it("signature 缺字段 / 是空串 / 不是字符串 → 指纹 null，地址照给（不抛）", async () => {
    for (const entry of [
      { url: APK_URL },
      { url: APK_URL, signature: "" },
      { url: APK_URL, signature: 42 },
      { url: APK_URL, signature: null },
    ]) {
      fetchMock.mockImplementation(() => respond(manifestWithAndroid(entry)));
      const m = (await fetchUpdateManifest())!;
      expect(m.android_url, JSON.stringify(entry)).toBe(APK_URL);
      expect(m.android_sha256, JSON.stringify(entry)).toBeNull();
    }
  });

  it("signature 形如 sha256: 但内容不合规 → **当前实现不做任何校验**，原样返回剩余部分（钉现状）", async () => {
    // 这条**不是**在认可这个行为，而是把它钉成显式现状：Rust 侧（src-tauri/src/updates.rs 的
    // android_entry）要求"剥掉前缀后恰好 64 位 hex，否则 None"，TS 侧没有这一步。
    // 于是同一份清单、同一个键，两个平台读出来的 android_sha256 可以不一样（Rust: None / TS: 那个字符串）。
    // 真要统一口径是**行为变更**，得单独决定；这里只保证它不会在无人察觉时漂移。
    for (const [signature, expected] of [
      ["sha256:zz", "zz"], // 不是 hex
      ["sha256:", ""], // 空 ⇒ 空串（注意不是 null）
      [`sha256:${"a".repeat(63)}`, "a".repeat(63)], // 短一位
      [`sha256:${"a".repeat(65)}`, "a".repeat(65)], // 长一位
    ] as const) {
      fetchMock.mockImplementation(() => respond(manifestWithAndroid({ url: APK_URL, signature })));
      const m = (await fetchUpdateManifest())!;
      expect(m.android_sha256, signature).toBe(expected);
    }
  });

  it("android 条的 url 非 https / 不是字符串 → 当前实现**不过滤 https**（Rust 侧会过滤）", async () => {
    // 口径差的另一半：Rust 只收 `https://` 开头，TS 侧只要 `typeof === "string"` 就带出。
    // 弹窗拿到后还会过 `sanitizeExternalUrl`，而它只允许 `http(s)://` ⇒ 明文 http 地址**能**被打开。
    // 同上：认下现状、指向缺口，不在这里改行为。
    fetchMock.mockImplementation(() =>
      respond(manifestWithAndroid({ url: "http://gitcode.com/shuyo-cn/ShuyoNote/releases/download/v1/x.apk", signature: `sha256:${APK_SHA256}` })),
    );
    const passthrough = (await fetchUpdateManifest())!;
    expect(passthrough.android_url).toBe("http://gitcode.com/shuyo-cn/ShuyoNote/releases/download/v1/x.apk");

    for (const url of [42, null, undefined, { href: APK_URL }]) {
      fetchMock.mockImplementation(() => respond(manifestWithAndroid({ url, signature: `sha256:${APK_SHA256}` })));
      const m = (await fetchUpdateManifest())!;
      expect(m.android_url, JSON.stringify(url)).toBeNull();
      expect(m.android_sha256, JSON.stringify(url)).toBe(APK_SHA256); // 地址丢了不影响指纹
    }
  });

  it("取不到清单（HTTP 不 ok / 网络抛错 / 响应不是 JSON）→ 一律 null，不抛", async () => {
    fetchMock.mockImplementation(() => respond({}, false));
    await expect(fetchUpdateManifest()).resolves.toBeNull();

    fetchMock.mockImplementation(() => Promise.reject(new Error("offline")));
    await expect(fetchUpdateManifest()).resolves.toBeNull();

    fetchMock.mockImplementation(() => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError("not json"); } }));
    await expect(fetchUpdateManifest()).resolves.toBeNull();
  });
});
