// 更新清单读取（`fetchUpdateManifest`）的**行为契约**测试。
//
// 为什么值得钉：清单里新增了 `platforms["android-aarch64"]`（APK 地址 + `sha256:<hex>` 指纹），
// 而读它的代码与**桌面更新读的是同一份 latest.json、同一个函数**。源码注释写着
// 「清单里没有这个平台键时是 null —— 老清单照常可读，桌面更新不受影响」，这句话此前**没有任何
// 测试钉着**。而它一旦不成立，坏的不是 Android 一个入口：桌面那三个字段一起解析不出来，
// 症状只是"点检查更新什么都不发生"（没有报错）——正是这个通道最容易悄悄回归的地方。
// 所以这里逐条钉：有新键怎么读、缺新键怎么退化、畸形输入不抛、以及**与 Rust 侧逐条同判的
// 校验规则**（`platforms["android-aarch64"]` 的 url 必须 https、signature 必须是
// `sha256:` + 恰好 64 位 hex —— 两边不一致会让同一份清单读出两个结果，且症状是静默的）。
//
// 形状取自真实产物：`release/v1.84.0/latest.json`（老清单，只有 windows/linux 两个平台键）
// 与 `scripts/release.mjs` 现在写出的清单（多一个 android-aarch64，signature 是 `sha256:<64hex>`）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUpdateManifest, ANDROID_PLATFORM_KEY, LATEST_MANIFEST_URL } from "./updates";

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

  it("signature 形如 sha256: 但内容不合规 → 指纹 null（**已与 Rust 对齐**：剥前缀后必须恰好 64 位 hex）", async () => {
    // 这条以前钉的是"当前实现不做任何校验"（原样返回剩余部分）——**现在钉新口径**：
    // Rust 的 android_entry() 要求"剥掉前缀后恰好 64 位 ASCII hex，否则 None"，TS 侧照抄。
    // 旧口径下 `sha256:`（空的）给的是**空串**而不是 null，是最容易漏的一格。
    for (const [signature, why] of [
      ["sha256:zz", "不是 hex"],
      ["sha256:", "前缀之后为空 ⇒ null（旧口径给空串）"],
      [`sha256:${"a".repeat(63)}`, "短一位"],
      [`sha256:${"a".repeat(65)}`, "长一位"],
      [`sha256:${"a".repeat(63)}é`, "字符数 64 但含非 ASCII（Rust 按字节算 len ⇒ 65，同样拒）"],
      [`sha256:${"a".repeat(32)} ${"a".repeat(31)}`, "内部混进一个空格（总长 64 但不是 hex）"],
    ] as const) {
      fetchMock.mockImplementation(() => respond(manifestWithAndroid({ url: APK_URL, signature })));
      const m = (await fetchUpdateManifest())!;
      expect(m.android_sha256, `${signature}（${why}）`).toBeNull();
      // 指纹不合规**不该连地址一起丢掉**（与 Rust 一致：只剩地址时按钮照旧能开）
      expect(m.android_url, `${signature}：指纹坏了不影响地址`).toBe(APK_URL);
    }
  });

  it("指纹边角：signature 整体会 trim、前缀小写敏感、hex 大小写都收（逐条同 Rust）", async () => {
    // Rust: `.and_then(|s| s.trim().strip_prefix("sha256:"))` + `is_ascii_hexdigit`
    // ⇒ ① 前后空白被吃掉；② `SHA256:` 这种大写前缀不认；③ hex 位大小写都算合法。
    const cases: Array<[string, string | null]> = [
      [`  sha256:${APK_SHA256}\n`, APK_SHA256], // trim 后合规
      [`SHA256:${APK_SHA256}`, null], // 前缀小写敏感
      [`sha256:${APK_SHA256.toUpperCase()}`, APK_SHA256.toUpperCase()], // hex 大小写不敏感
      [`sha256: ${APK_SHA256}`, null], // 前缀后有空格 ⇒ 64 位里混进空格
    ];
    for (const [signature, expected] of cases) {
      fetchMock.mockImplementation(() => respond(manifestWithAndroid({ url: APK_URL, signature })));
      const m = (await fetchUpdateManifest())!;
      expect(m.android_sha256, JSON.stringify(signature)).toBe(expected);
    }
  });

  it("android 条的 url 非 https / 不是字符串 → **已与 Rust 对齐**：明文 http 一律丢成 null", async () => {
    // 口径差的另一半，本轮补齐。Rust 只收小写 `https://` 开头；TS 侧以前只要
    // `typeof === "string"` 就带出。**这条是真风险不只是不一致**：弹窗拿到后还会过
    // `sanitizeExternalUrl`，而它只允许 `http(s)://` ⇒ 清单里的明文 http 地址**能**被打开。
    // 现在 `android_url` 为 null ⇒ 弹窗退回「前往发布页」（aboutDialog.test.ts 钉了那一层）。
    const insecure = [
      "http://gitcode.com/shuyo-cn/ShuyoNote/releases/download/v1/x.apk",
      "HTTP://gitcode.com/x.apk", // scheme 大小写混淆：Rust 的 starts_with 是大小写敏感的
      "Https://gitcode.com/x.apk",
      "  https://gitcode.com/x.apk", // Rust 对 url **不 trim**（与 signature 不同，别顺手加）
      "https:/gitcode.com/x.apk", // 少一个斜杠
      "ftp://gitcode.com/x.apk",
      "javascript:alert(1)",
      "file:///C:/x.apk",
      "", // 空串不是 https 前缀
    ];
    for (const url of insecure) {
      fetchMock.mockImplementation(() => respond(manifestWithAndroid({ url, signature: `sha256:${APK_SHA256}` })));
      const m = (await fetchUpdateManifest())!;
      expect(m.android_url, `${JSON.stringify(url)} 不该被交给打开动作`).toBeNull();
      expect(m.android_sha256, `${JSON.stringify(url)}：地址丢了不影响指纹`).toBe(APK_SHA256);
    }

    for (const url of [42, null, undefined, { href: APK_URL }, ["https://e/x.apk"]]) {
      fetchMock.mockImplementation(() => respond(manifestWithAndroid({ url, signature: `sha256:${APK_SHA256}` })));
      const m = (await fetchUpdateManifest())!;
      expect(m.android_url, JSON.stringify(url)).toBeNull();
      expect(m.android_sha256, JSON.stringify(url)).toBe(APK_SHA256); // 地址丢了不影响指纹
    }

    // 正例不能一起误伤：合法 https 照旧原样带出（含 `https://` 之后就没了这种边界，
    // 与 Rust 相同——Rust 只判前缀，不看 host）
    fetchMock.mockImplementation(() => respond(manifestWithAndroid()));
    expect((await fetchUpdateManifest())!.android_url).toBe(APK_URL);
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

// ── 防分叉：`platforms["android-aarch64"]` 的校验规则**两侧必须一致** ───────────────────
//
// 教训：一处知识多处表述必然对不上。同一个键被读两遍——`src/lib/updates.ts`（浏览器路径）
// 与 `src-tauri/src/updates.rs` 的 `android_entry()`（native 路径，Android/桌面弹窗实际走这条）。
// 两边口径一旦不同，同一份 latest.json 会读出两个结果，而症状**完全静默**：一边过滤掉、一边照给。
// 所以规则只允许有一份表述，另一侧照抄，并在这里用两道判据焊住：
//   ① 把 Rust 的规则以可读形式写在下面（附 `文件:行`），逐输入对照 TS 的产出；
//   ② 直接读 `src-tauri/src/updates.rs` 源码，确认那几条规则**还长这样** —— 谁动了 Rust 侧，
//      这里会红，逼他回来同步 TS 侧与这张对照表（读源码做双向对齐的做法同
//      `shortcutCoverage.test.ts`「文档与实现双向对齐」、`sidebarVisibility.test.ts` 读 App.css）。
//
// Rust `android_entry()` 的实际规则（`src-tauri/src/updates.rs:55-69`，逐句抄）：
//
//   entry = j["platforms"]["android-aarch64"]        // 逐级 `get`：缺哪层就是 None，不报错
//
//   url     = entry["url"]      // 必须 JSON string
//             .filter(|u| u.starts_with("https://"))
//     ① **不 trim**（`" https://…"` 被拒）；② 前缀**大小写敏感**（`HTTPS://` 被拒）；
//     ③ 只判前缀，不看 host（`"https://"` 本身就过）；
//     ④ 不合规 ⇒ None，且**不影响** sha256 那一侧。
//
//   sha256  = entry["signature"] // 必须 JSON string
//             .trim()            // ① **整体先 trim**（与 url 不同！
//             .strip_prefix("sha256:")   // ② 前缀大小写敏感，`SHA256:` 不认
//             .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
//     ⇒ ③ 剥掉前缀后**恰好 64 位 ASCII hex**；④ hex 位**大小写都收**（a-f/A-F），
//       发布脚本产小写、大写只作兼容；⑤ `"sha256:"`（空的）⇒ None，**不是空串**；
//       ⑥ `len()` 是**字节数**，含非 ASCII 时必然 ≠ 64 ⇒ None；
//       ⑦ 不合规 ⇒ None，且**不影响** url 那一侧（地址照旧可用）。
const RUST_UPDATES_RS = readFileSync(resolve(process.cwd(), "src-tauri/src/updates.rs"), "utf8");

/** **删掉全部空白**再找规则片段：rustfmt 换行/缩进变了不该让判据误报。 */
const rustRules = RUST_UPDATES_RS.replace(/\s+/g, "");

describe("android 校验规则的跨语言对照（TS 与 Rust 必须同判）", () => {
  it("Rust 侧的规则片段还在（谁改了它，谁就得回来同步 TS 与上面的对照表）", () => {
    for (const [pattern, what] of [
      [/entry\.and_then\(\|e\|e\.get\("url"\)\)/, "取 entry.url"],
      [/\.filter\(\|u\|u\.starts_with\("https:\/\/"\)\)/, "url 只收小写 https:// 前缀"],
      [/\.and_then\(\|s\|s\.trim\(\)\.strip_prefix\("sha256:"\)\)/, "signature 先 trim 再剥 sha256: 前缀"],
      [/\.filter\(\|s\|s\.len\(\)==64&&s\.chars\(\)\.all\(\|c\|c\.is_ascii_hexdigit\(\)\)\)/, "剥前缀后恰好 64 位 ASCII hex"],
    ] as const) {
      expect(rustRules, `Rust 侧规则变了：${what}（src-tauri/src/updates.rs 的 android_entry）`).toMatch(pattern);
    }
  });

  it("两侧读的是同一个平台键（键名也在一处表述：Rust 的 ANDROID_PLATFORM_KEY）", () => {
    const rustKey = RUST_UPDATES_RS.match(/const ANDROID_PLATFORM_KEY: &str = "([^"]+)"/)?.[1];
    expect(rustKey, "Rust 侧应当有 ANDROID_PLATFORM_KEY 常量").toBeDefined();
    expect(ANDROID_PLATFORM_KEY).toBe(rustKey);
    expect(ANDROID_PLATFORM_KEY).toBe("android-aarch64");
  });

  it("逐输入对照 Rust 规则表：url / sha256 两侧同判（含不合规一律 null，且互不牵连）", async () => {
    // 期望值**照上面那张 Rust 规则表手写**，不是从实现反推——实现改了这里就该红。
    const H = "ab".repeat(32); // 64 位小写 hex
    const cases: Array<{
      entry: Record<string, unknown>;
      url: string | null;
      sha: string | null;
      why: string;
    }> = [
      { entry: { url: "https://e/x.apk", signature: `sha256:${H}` }, url: "https://e/x.apk", sha: H, why: "完全合规" },
      { entry: { url: `https://e/x.apk`, signature: `sha256:${H.toUpperCase()}` }, url: "https://e/x.apk", sha: H.toUpperCase(), why: "hex 大写兼容" },
      { entry: { url: "https://e/x.apk", signature: `  sha256:${H}  ` }, url: "https://e/x.apk", sha: H, why: "signature 会 trim" },
      { entry: { url: "  https://e/x.apk", signature: `sha256:${H}` }, url: null, sha: H, why: "url 不 trim ⇒ 丢地址，指纹仍在" },
      { entry: { url: "https://", signature: `sha256:${H}` }, url: "https://", sha: H, why: "只判前缀、不看 host（Rust 如此）" },
      { entry: { url: "http://e/x.apk", signature: `sha256:${H}` }, url: null, sha: H, why: "明文 http 丢地址（本轮的动因）" },
      { entry: { url: "HTTPS://e/x.apk", signature: `sha256:${H}` }, url: null, sha: H, why: "scheme 大小写混淆丢地址" },
      { entry: { url: "ftp://e/x.apk", signature: `sha256:${H}` }, url: null, sha: H, why: "非 http(s) scheme 丢地址" },
      { entry: { url: "https://e/x.apk", signature: "sha256:" }, url: "https://e/x.apk", sha: null, why: "空 hex ⇒ 丢指纹，地址仍在" },
      { entry: { url: "https://e/x.apk", signature: `SHA256:${H}` }, url: "https://e/x.apk", sha: null, why: "前缀大小写敏感" },
      { entry: { url: "https://e/x.apk", signature: `sha256:${H.slice(0, 63)}` }, url: "https://e/x.apk", sha: null, why: "短一位" },
      { entry: { url: "https://e/x.apk", signature: `sha256:${H}a` }, url: "https://e/x.apk", sha: null, why: "长一位" },
      { entry: { url: "https://e/x.apk", signature: "dW50cnVzdGVkIGNvbW1lbnQ6..." }, url: "https://e/x.apk", sha: null, why: "桌面那种 minisign base64" },
      { entry: { url: 42, signature: `sha256:${H}` }, url: null, sha: H, why: "url 不是字符串" },
      { entry: {}, url: null, sha: null, why: "字段全缺" },
      { entry: { url: "https://e/x.apk" }, url: "https://e/x.apk", sha: null, why: "只有 url" },
    ];

    for (const c of cases) {
      fetchMock.mockImplementation(() => respond(manifestWithAndroid(c.entry)));
      const m = (await fetchUpdateManifest())!;
      expect({ url: m.android_url, sha: m.android_sha256 }, `${c.why}：${JSON.stringify(c.entry)}`).toEqual({ url: c.url, sha: c.sha });
      // 对照表里每一格桌面三字段都不受牵连（同一份清单同一个返回对象）
      expect(m.version).toBe("1.91.0");
    }

    // `platforms` / android 条目本身不是对象：Rust 那边 `Value::get` 也是 None
    // （它自己的单测里就有 `"platforms": "not-an-object"` 这一格），TS 侧同样两个 null 且不抛。
    for (const platforms of ["not-an-object", 42, null, [], { "android-aarch64": "not-an-object" }, { "android-aarch64": null }]) {
      fetchMock.mockImplementation(() => respond({ version: "1.91.0", notes: NOTES, pub_date: PUB_DATE, platforms }));
      const m = (await fetchUpdateManifest())!;
      expect(m, JSON.stringify(platforms)).toEqual({
        version: "1.91.0",
        notes: NOTES,
        pub_date: PUB_DATE,
        android_url: null,
        android_sha256: null,
      });
    }
  });
});
