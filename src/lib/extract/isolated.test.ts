// 抽取层的**隔离断言**（源码级）—— 契约 §15.3 / `types.ts` 里 `ExtractDeps` 的注释。
//
// 为什么这条要写成测试而不是只写注释：
// 今天驳回 AMD 那条"由 `pipeline.ts` 注入平台能力"的建议，理由就是
// **那会把平台依赖引进抽取层**（Tauri IPC / web 驱动 / 原生缓存），
// 而抽取层至今能在 vitest / Node / Headless 上跑纯函数单测，**全靠它不依赖平台**。
// 这个理由只有变成可执行的断言才守得住 —— 否则下一个人"顺手 import 一下"就悄悄破了。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { fakeRasterize, fakeVision, depsOf } from "./testing/fakeDeps";
import { isPng } from "../pngEncode";

const EXTRACT_DIR = join(process.cwd(), "src/lib/extract");

/** 抽取层里**禁止**出现的依赖。
 *
 * ⚠️ **`pdfjs-dist` 刻意不在清单里**：我第一版把它列进来了，跑起来才发现那是**我判错了** ——
 * 它能在 Node 里跑，而 Mac 侧的 `pdf.text@1` 正用它做**文本**抽取（不是渲染）。
 * 我真正要禁的是"**渲染**"，而渲染已经由 `deps.rasterize` 在契约层收口。
 * 把可移植的库当成平台依赖禁掉，只会逼出一条绕路。
 */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  // 注意 `(\/|$)`：平台层的**门面**是 `"../platform"`（不带斜杠），只写 `platform/` 会漏掉它
  { pattern: /(^|\/)platform(\/|$)/, why: "平台驱动（Tauri IPC / Web 驱动）会把抽取层拖出 CI/Node" },
  { pattern: /^@tauri-apps\//, why: "同上：Tauri API 只在桌面运行时存在" },
  { pattern: /^tesseract\.js$/, why: "OCR 由平台层注入（deps.vision）；tesseract 要 worker/blob，Node 下跑不了" },
  { pattern: /^(canvas|node-canvas|@napi-rs\/canvas)$/, why: "光栅化必须走 deps.rasterize 注入，抽取层不许自带渲染器" },
];

/** 扫一段源码里的 import 说明符（导出成函数，便于用合成代码验证这个扫描器本身有效）。 */
export function findForbiddenImports(src: string): { spec: string; why: string }[] {
  const out: { spec: string; why: string }[] = [];
  for (const m of src.matchAll(/^\s*import[\s\S]*?from\s+["']([^"']+)["']/gm)) {
    const spec = m[1];
    const hit = FORBIDDEN.find((f) => f.pattern.test(spec));
    if (hit) out.push({ spec, why: hit.why });
  }
  return out;
}


/** `ai/` 目录里**能出网**的模块 —— **自动算，不手抄**。
 *
 * 起因（2026-09-17）：用户定了红线「**抽取不得用远程 provider**」，而隔离断言当时只禁了
 * platform / tauri / tesseract / canvas —— **`ai/**` 不在其中**，也就是说
 * `pdf.ocr` 完全可以 `import { ocrWithVision } from "../ai/ocrVision"` 而**没有任何判据会红**
 * （`image.ts` 的注释里写着"契约禁止抽取层自建网络栈"，但那只是一句话）。
 *
 * 为什么不手抄一份清单：清单会腐烂（新增一个网络模块 → 清单不更新 → 判据恒真）。
 * 这里改成**从源码算**：
 *   ① 含 `fetch(` / `coreFetch` / `coreHttp` 的模块 = 直接能出网；
 *   ② **import 了①的模块**（在 `ai/` 内闭环）= 间接能出网；
 * 判据再去禁"抽取层 import 这个闭包里的任何模块" ⇒ **新增网络模块会自动被覆盖**（判据当场红，
 * 提醒把它加进抽取层的禁区），而不是悄悄漏过去。
 */
export function networkModulesInAi(dir: string): string[] {
  const files = readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"));
  const src = new Map<string, string>();
  for (const n of files) src.set(n, readFileSync(join(dir, n), "utf8"));

  const flagged = new Set<string>();
  for (const [n, code] of src) {
    if (/\bfetch\s*\(|\bcoreFetch\b|\bcoreHttp\b/.test(code)) flagged.add(n);
  }
  // 闭包：只要 import 了已标记的模块（同目录下的相对 import），它也能出网
  for (let changed = true; changed; ) {
    changed = false;
    for (const [n, code] of src) {
      if (flagged.has(n)) continue;
      for (const m of code.matchAll(/from\s+["']\.\/([A-Za-z0-9_-]+)["']/g)) {
        if (flagged.has(`${m[1]}.ts`)) {
          flagged.add(n);
          changed = true;
          break;
        }
      }
    }
  }
  return [...flagged].sort();
}

/** 递归列出生产代码（排除测试文件与 `testing/` 夹具目录）。 */
function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "testing") continue;
      out.push(...productionFiles(p));
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    if (name.endsWith(".test.ts")) continue;
    out.push(p);
  }
  return out;
}

describe("抽取层隔离（源码级）", () => {
  it("**扫描器本身有效的自证**（用合成代码验证，避免「断言恒真」）", () => {
    const bad = `import { platform } from "../platform";\nimport { invoke } from "@tauri-apps/api/core";`;
    const hits = findForbiddenImports(bad);
    expect(hits.map((h) => h.spec).sort()).toEqual([
      "../platform",
      "@tauri-apps/api/core",
    ]);
    // 反例一：合法依赖不该被误报
    expect(findForbiddenImports(`import { unzipSync } from "fflate";`)).toEqual([]);
    // 反例二（**特意钉住一个决定**）：`pdfjs-dist` **允许**在抽取层用 ——
    // 它能在 Node 跑，Mac 侧 `pdf.text@1` 正用它做文本抽取；被禁的是**渲染**（走 deps.rasterize）。
    // 后人若想把它加回禁止清单，这条会红，提醒先读上面 FORBIDDEN 的注释。
    expect(findForbiddenImports(`import * as pdfjs from "pdfjs-dist";`)).toEqual([]);
  });

  it("**红线**：抽取层不得 import 任何「能出网」的 ai 模块（用户 2026-09-17 定的：抽取不出网）", () => {
    const nets = networkModulesInAi(join(process.cwd(), "src/lib/ai"));
    // 自证：算不出来（比如目录写错、marker 改了）就红 —— 否则这条判据会**恒真**
    expect(nets.length, `没算到任何网络模块，扫描器可能坏了`).toBeGreaterThan(0);
    expect(nets).toContain("ocrVision.ts");

    const offenders: string[] = [];
    for (const f of productionFiles(EXTRACT_DIR)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/from\s+["']([^"']*\/ai\/[A-Za-z0-9_-]+)["']/g)) {
        const base = m[1].split("/").pop()!;
        if (nets.includes(`${base}.ts`)) {
          offenders.push(`${relative(EXTRACT_DIR, f)} → ${m[1]}（红线：抽取不得出网；该模块能发网络请求，必须走 deps 注入）`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("这条红线的判据**自己也会咬人**（用合成 import 验证，别让它恒真）", () => {
    const synth = `import { ocrWithVision } from "../ai/ocrVision";`;
    const nets = networkModulesInAi(join(process.cwd(), "src/lib/ai"));
    const hit = [...synth.matchAll(/from\s+["']([^"']*\/ai\/[A-Za-z0-9_-]+)["']/g)]
      .map((m) => m[1].split("/").pop()!)
      .filter((b) => nets.includes(`${b}.ts`));
    expect(hit).toEqual(["ocrVision"]);
  });

  it("生产代码里不得出现平台 / 渲染 / OCR 依赖", () => {
    const offenders: string[] = [];
    const files = productionFiles(EXTRACT_DIR);
    for (const f of files) {
      for (const hit of findForbiddenImports(readFileSync(f, "utf8"))) {
        offenders.push(`${relative(EXTRACT_DIR, f)} → ${hit.spec}（${hit.why}）`);
      }
    }
    expect(offenders).toEqual([]);
    // 自证扫到了东西（否则"目录写错"也会绿）
    expect(files.length).toBeGreaterThanOrEqual(8);
  });
});

describe("共享假 deps（三轴共用一套口径）", () => {
  it("fakeVision 记录调用并返回固定文字", async () => {
    const v = fakeVision("发票号码 001");
    await v.fn("prompt", new Uint8Array([1, 2, 3]), "image/png");
    await v.fn("prompt2", new Uint8Array([4]), "image/jpeg");
    expect(v.calls).toHaveLength(2);
    expect(v.calls[0]).toMatchObject({ prompt: "prompt", byteLength: 3, mime: "image/png" });
  });

  it("fakeRasterize 产出**合法 PNG**且确定性（与生产共用同一份编码器）", async () => {
    const r = fakeRasterize({ pages: 3, width: 2, height: 2 });
    const p1 = await r.fn(new Uint8Array(0), 1, 2);
    expect([p1.width, p1.height, p1.mime]).toEqual([2, 2, "image/png"]);
    expect(isPng(p1.bytes)).toBe(true); // 契约要求编码图（vision 只接受编码图）
    const again = await r.fn(new Uint8Array(0), 1, 2);
    expect(again.bytes).toEqual(p1.bytes); // 确定性
    expect(r.calls).toHaveLength(2);
  });

  it("fakeRasterize 对越界页与 rejectOn 页 reject（用来测 provider_error 传播）", async () => {
    const r = fakeRasterize({ pages: 2, rejectOn: [0] });
    await expect(r.fn(new Uint8Array(0), 0, 1)).rejects.toThrow();
    await expect(r.fn(new Uint8Array(0), 5, 1)).rejects.toThrow();
    await expect(r.fn(new Uint8Array(0), 1, 1)).resolves.toBeDefined();
  });

  it("depsOf **不传未注入的项**（保持「未注入 ⇒ provider_error」的语义）", () => {
    expect(depsOf({})).toEqual({});
    expect(Object.keys(depsOf({ vision: fakeVision("x") }))).toEqual(["vision"]);
    expect(Object.keys(depsOf({ rasterize: fakeRasterize() }))).toEqual(["rasterize"]);
  });
});
