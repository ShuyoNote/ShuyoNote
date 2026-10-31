// `docPackWriter`（写侧 / 导出）的判据 —— 方案 `docs/plans/2026-10-29-shuyodoc-m1.md`。
//
// 任务要求的五类（①–⑤）＋ 写侧自己的三类（⑥–⑧）：
//   ① **往返**：写出的 zip 用本仓 `unzipDocument` + `openDocumentPackage` 读回，manifest / 正文 / 资产 sha 全等；
//   ② checksums 覆盖齐全、且**不登记自己**（企业版同口径）；
//   ③ 资产 sha 与内容不符 ⇒ 拒绝写（⛔ 不产出坏包）；
//   ④ 路径不安全（`../` / 绝对路径 / 盘符 / 反斜杠 / 子目录）⇒ 拒绝写；
//   ⑤ **跨版**：写出的包用 `node` **直接跑企业版 reader**
//      （`repos/shuyonote-enterprise-client/workbench/lib/package-format.mjs` 的 `readPackage`）
//      ⇒ `checksumsOk=true` / `errors=[]`。企业版仓不在本机时**显式跳过**（⛔ 跳过 ≠ 通过，读数进报告）。
//   ⑥ store 模式（企业版读端只支持 store）＋ 条目顺序固定 ＋ 同一输入逐字节相同；
//   ⑦ 无资产也能导；正文不合法 / 标题为空 ⇒ 拒绝写；
//   ⑧ manifest 只写企业版字段 ＋ v1.1 的 `features`（不写个人版扩展的 `assets` 字段）。
//   ⑨ features 只声明**真的用到的**扩展（attachments / db-namespace / checksums-self）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHECKSUMS_ALGORITHM,
  CHECKSUMS_FORMAT,
  CHECKSUMS_VERSION,
  CONTENT_PATH,
  DOC_FORMAT,
  DOC_FORMAT_VERSION,
  KNOWN_FEATURES,
  MANIFEST_PATH,
  buildManifest,
  sha256Hex,
} from "./docPackage";
import { openDocumentPackage, type ZipEntry } from "./docPackageOpen";
import { unzipDocument } from "./docZip";
import { buildDocumentPackage, type BuildDocumentPackageInput } from "./docPackWriter";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** 资产占位字节（内容寻址：路径里的 sha256 必须由它算出来）。 */
const ASSET_BYTES = enc("写侧判据资产：内容寻址占位字节（中文也要能过）");

/** 正文用一段**像真 Lexical 的**块 JSON（保留块 id 的前提：写侧不改写正文）。 */
const LEXICAL_CONTENT = {
  root: {
    type: "root",
    version: 1,
    direction: "ltr",
    format: "",
    indent: 0,
    children: [
      {
        type: "paragraph",
        version: 1,
        direction: "ltr",
        format: "",
        indent: 0,
        textFormat: 0,
        textStyle: "",
        children: [
          { type: "text", version: 1, text: "写侧判据：正文往返不丢块", format: 0, style: "", mode: "normal", detail: 0 },
        ],
      },
    ],
  },
};
const CONTENT_JSON = JSON.stringify(LEXICAL_CONTENT);

/** 企业版 manifest 10 个必填字段（顺序即企业版 `buildDocumentPackage` 的写出顺序）。 */
const ENTERPRISE_MANIFEST_KEYS = [
  "format",
  "format_version",
  "source",
  "source_app_version",
  "document_id",
  "title",
  "created_at",
  "updated_at",
  "content_type",
  "encrypted",
];

/**
 * 个人版写侧**实际写出**的 key 顺序（v1.1）：企业版 10 项 ＋ `features` ——
 * 规范 §1.2 把它放在 `format_version` 之后。企业版读端忽略未知字段 ⇒ 这个多出来的键
 * 不会让它拒包（⑤ 那条用真 reader 跑出来，读数进报告）。
 */
const WRITTEN_MANIFEST_KEYS = [
  "format",
  "format_version",
  "features",
  "source",
  "source_app_version",
  "document_id",
  "title",
  "created_at",
  "updated_at",
  "content_type",
  "encrypted",
];

/** 资产路径 = `assets/<bytes 的 sha256>.<ext>`（内容寻址）。 */
const assetPathFor = async (bytes: Uint8Array, ext = "png"): Promise<string> =>
  `assets/${await sha256Hex(bytes)}.${ext}`;

/** 基准入参（每个用例只改自己关心的字段）。 */
async function baseInput(overrides: Partial<BuildDocumentPackageInput> = {}): Promise<BuildDocumentPackageInput> {
  return {
    documentId: "doc-writer-fixture-1",
    title: "写侧判据：导出的一篇",
    createdAt: "2026-10-29T04:00:00.000Z",
    updatedAt: "2026-10-29T05:00:00.000Z",
    docJson: CONTENT_JSON,
    sourceAppVersion: "2.0.0-writer",
    assets: [{ path: await assetPathFor(ASSET_BYTES), bytes: ASSET_BYTES }],
    ...overrides,
  };
}

const byPath = (entries: ZipEntry[]): Map<string, Uint8Array> => new Map(entries.map((e) => [e.path, e.bytes]));

/**
 * 从 zip 的中央目录里读「条目名 + 压缩方式」。
 * 判 store 用：企业版读端 method !== 0 直接报错，所以这一条不能只靠"跨版用例在就能过"。
 */
function zipCentralDirectory(bytes: Uint8Array): { name: string; method: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("判据夹具读不到 EOCD（不是合法 zip）");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out: { name: string; method: number }[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    out.push({ name: dec(bytes.subarray(p + 46, p + 46 + nameLen)), method: view.getUint16(p + 10, true) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ⑤ 跨版：用 node 直接跑企业版 reader（只读它仓；临时文件写到 _tmp/scratch/）
// ---------------------------------------------------------------------------

/** 企业版仓位置：默认同工作区兄弟目录，可用 `SHUYONOTE_ENTERPRISE_CLIENT` 覆盖。 */
const ENTERPRISE_READER = process.env.SHUYONOTE_ENTERPRISE_CLIENT
  ? resolve(process.env.SHUYONOTE_ENTERPRISE_CLIENT, "workbench", "lib", "package-format.mjs")
  : resolve(process.cwd(), "..", "shuyonote-enterprise-client", "workbench", "lib", "package-format.mjs");
const HAS_ENTERPRISE_READER = existsSync(ENTERPRISE_READER);

/** 在临时目录里用 `node` 真跑企业版 `readPackage`，把读数原样 JSON 打出来。 */
const ENTERPRISE_CHECK_SCRIPT = `
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [readerPath, zipPath] = process.argv.slice(2);
const mod = await import(pathToFileURL(readerPath).href);
const bytes = new Uint8Array(readFileSync(zipPath));
try {
  const pkg = mod.readPackage(bytes);
  process.stdout.write(JSON.stringify({
    ok: true,
    kind: pkg.kind,
    checksumsOk: pkg.checksumsOk,
    errors: pkg.errors,
    entries: [...pkg.entries.keys()].sort(),
    manifestKeys: Object.keys(pkg.manifest),
    manifest: pkg.manifest,
    content: pkg.content,
    checksums: JSON.parse(new TextDecoder().decode(pkg.entries.get('checksums.json'))),
  }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
}
`;

interface EnterpriseReading {
  ok: boolean;
  error?: string;
  kind?: string;
  checksumsOk?: boolean;
  errors?: string[];
  entries?: string[];
  manifestKeys?: string[];
  manifest?: Record<string, unknown>;
  content?: string;
  checksums?: { files: Record<string, string> };
}

/** 临时目录：优先工作区 `_tmp/scratch/`（本机约定），没有 `_tmp/` 的机器退回系统临时目录。 */
function makeScratchDir(): string {
  const workspaceRoot = resolve(process.cwd(), "..", "..");
  const tmpRoot = resolve(workspaceRoot, "_tmp");
  if (existsSync(tmpRoot)) {
    const scratch = resolve(tmpRoot, "scratch");
    mkdirSync(scratch, { recursive: true });
    return mkdtempSync(join(scratch, "docpkg-writer-"));
  }
  return mkdtempSync(join(tmpdir(), "docpkg-writer-"));
}

describe("① 往返：写出的包必须能被本仓读回（manifest / 正文 / 资产 sha 全等）", () => {
  it("㉚ 写出 → unzipDocument → openDocumentPackage：字段、正文、资产字节与 sha 全部一致", async () => {
    const input = await baseInput();
    const zip = await buildDocumentPackage(input);
    const entries = await unzipDocument(zip);
    const assetPath = input.assets![0].path;
    expect(entries.map((e) => e.path).sort()).toEqual(
      [MANIFEST_PATH, CONTENT_PATH, "checksums.json", assetPath].sort(),
    );

    const r = await openDocumentPackage(entries);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const { manifest, docJson, assets, notices } = r.pkg;
    // manifest：企业版 10 字段全在，且 source 是我们自己
    expect(manifest.format).toBe(DOC_FORMAT);
    expect(manifest.format_version).toBe(DOC_FORMAT_VERSION);
    expect(manifest.source).toBe("personal");
    expect(manifest.source_app_version).toBe("2.0.0-writer");
    expect(manifest.document_id).toBe("doc-writer-fixture-1");
    expect(manifest.title).toBe("写侧判据：导出的一篇");
    expect(manifest.created_at).toBe("2026-10-29T04:00:00.000Z");
    expect(manifest.updated_at).toBe("2026-10-29T05:00:00.000Z");
    expect(manifest.content_type).toBe("lexical-json");
    expect(manifest.encrypted).toBe(false);
    // manifest 没写 assets 扩展字段 ⇒ 资产按内容寻址发现（与读企业版包同一条路）
    expect(manifest.assets).toEqual([]);

    // 正文原样（不解析、不改写、不重排）
    expect(docJson).toBe(CONTENT_JSON);
    expect(JSON.parse(docJson)).toEqual(LEXICAL_CONTENT);

    // 资产：路径 / 字节 / sha 自证
    expect(assets).toHaveLength(1);
    expect(assets[0].path).toBe(assetPath);
    expect([...assets[0].bytes]).toEqual([...ASSET_BYTES]);
    await expect(sha256Hex(assets[0].bytes)).resolves.toBe(assetPath.slice("assets/".length, -".png".length));

    // 带 checksums ⇒ 没有降级提示（缺 checksums / 未验签 / 评论未导入 都不该出现）
    expect(notices).toEqual([]);
  });
});

describe("② checksums：覆盖齐全且不登记自己", () => {
  it("㉛ 除 checksums.json 外每个条目都登记，值 = 字节 sha256 小写 64 位；自己与签名不在登记里", async () => {
    const input = await baseInput({
      assets: [
        { path: await assetPathFor(ASSET_BYTES, "png"), bytes: ASSET_BYTES },
        { path: await assetPathFor(enc("第二个资产"), "bin"), bytes: enc("第二个资产") },
      ],
    });
    const entries = await unzipDocument(await buildDocumentPackage(input));
    const files = byPath(entries);
    const sums = JSON.parse(dec(files.get("checksums.json")!)) as {
      format: string;
      version: number;
      algorithm: string;
      files: Record<string, string>;
    };

    expect(sums.format).toBe(CHECKSUMS_FORMAT);
    expect(sums.version).toBe(CHECKSUMS_VERSION);
    expect(sums.algorithm).toBe(CHECKSUMS_ALGORITHM);

    // 覆盖 = 包里除 checksums.json 外的**每个**条目（一个都不许漏）
    const covered = entries
      .map((e) => e.path)
      .filter((p) => p !== "checksums.json")
      .sort();
    expect(Object.keys(sums.files).sort()).toEqual(covered);

    // 不登记自己；v1 不写签名 ⇒ 也不该出现 signature.json
    expect(sums.files["checksums.json"]).toBeUndefined();
    expect(sums.files["signature.json"]).toBeUndefined();

    // 值逐条等于该条目字节的 sha256（小写 64 位 hex）
    for (const e of entries) {
      if (e.path === "checksums.json") continue;
      await expect(sha256Hex(e.bytes)).resolves.toBe(sums.files[e.path]);
    }
    for (const v of Object.values(sums.files)) expect(v).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("③ 资产自证不过 ⇒ 拒绝写（⛔ 不产出坏包）", () => {
  it("㉜ 路径里的 sha256 与字节实际 sha256 不符 / 文件名不是 sha256 ⇒ 抛错", async () => {
    // (a) 路径写的是 A 的 sha，字节却是 B ⇒ 拒绝
    const pathA = await assetPathFor(enc("A"));
    await expect(
      buildDocumentPackage(await baseInput({ assets: [{ path: pathA, bytes: enc("B") }] })),
    ).rejects.toThrow(/sha256 与内容不符/);

    // (b) 文件名根本不含 sha256（不是内容寻址）⇒ 拒绝
    await expect(
      buildDocumentPackage(await baseInput({ assets: [{ path: "assets/logo.png", bytes: ASSET_BYTES }] })),
    ).rejects.toThrow(/不是 sha256/);

    // (c) bytes 不是 Uint8Array ⇒ 拒绝
    await expect(
      buildDocumentPackage(
        await baseInput({ assets: [{ path: await assetPathFor(ASSET_BYTES), bytes: "字符串" as unknown as Uint8Array }] }),
      ),
    ).rejects.toThrow(/Uint8Array/);

    // (d) 同一个资产写两次（同名条目会被 zip 静默覆盖）⇒ 拒绝
    const dup = await assetPathFor(ASSET_BYTES);
    await expect(
      buildDocumentPackage(
        await baseInput({
          assets: [
            { path: dup, bytes: ASSET_BYTES },
            { path: dup, bytes: ASSET_BYTES },
          ],
        }),
      ),
    ).rejects.toThrow(/路径重复/);
  });
});

describe("④ 路径不安全 ⇒ 拒绝写", () => {
  const ZERO_SHA = "a".repeat(64);
  const UNSAFE: [string, RegExp][] = [
    ["../evil.bin", /zip-slip/],
    ["/etc/passwd", /绝对路径/],
    ["C:/Windows/system32/x.bin", /盘符/],
    ["assets\\evil.bin", /反斜杠/],
    [`assets/sub/${ZERO_SHA}.bin`, /子目录/],
    ["evil.bin", /必须以 assets\//],
    ["assets/", /以 \/ 结尾/],
  ];

  it("㉝ `../` / 绝对路径 / 盘符 / 反斜杠 / 子目录 / 不在 assets/ 下 ⇒ 逐条点名拒绝", async () => {
    for (const [path, reason] of UNSAFE) {
      await expect(
        buildDocumentPackage(await baseInput({ assets: [{ path, bytes: ASSET_BYTES }] })),
        `路径 ${path} 应当被拒绝`,
      ).rejects.toThrow(reason);
    }
  });
});

describe.skipIf(!HAS_ENTERPRISE_READER)("⑤ 跨版：企业版 readPackage 直接读我们写出的包", () => {
  it("㉞ 企业版 reader 读数：checksumsOk=true / errors=[] / manifest 被接受", async () => {
    const input = await baseInput();
    const zip = await buildDocumentPackage(input);
    const dir = makeScratchDir();
    try {
      const zipPath = join(dir, "personal-writer.shuyodoc");
      const scriptPath = join(dir, "check-enterprise.mjs");
      writeFileSync(zipPath, zip);
      writeFileSync(scriptPath, ENTERPRISE_CHECK_SCRIPT, "utf8");

      const run = spawnSync(process.execPath, [scriptPath, ENTERPRISE_READER, zipPath], {
        encoding: "utf8",
        cwd: dir,
      });
      expect(run.error).toBeUndefined();
      expect(run.status, `企业版 reader 退出码非 0：${run.stderr}`).toBe(0);
      const reading = JSON.parse(run.stdout) as EnterpriseReading;
      expect(reading.ok, `企业版 reader 抛错：${reading.error}`).toBe(true);
      // 关键读数（原文进报告）：checksumsOk / errors
      console.log(
        `[docPackWriter 跨版读数] ${JSON.stringify({
          checksumsOk: reading.checksumsOk,
          errors: reading.errors,
          kind: reading.kind,
          entries: reading.entries,
          manifestKeys: reading.manifestKeys,
          features: reading.manifest?.features,
        })}`,
      );

      // ★ 互通的关键证据：企业版整包校验通过、零错误
      expect(reading.checksumsOk).toBe(true);
      expect(reading.errors).toEqual([]);
      expect(reading.kind).toBe("document");
      expect(reading.entries).toEqual(
        [MANIFEST_PATH, CONTENT_PATH, "checksums.json", input.assets![0].path].sort(),
      );
      // manifest 被接受：企业版认出的字段与我们写的一致。★ 我们现在**写**了 v1.1 的
      // `features`（企业版 manifest 结构体没有它）—— 它照常读出来、不拒包，这正是
      // 「企业版读端容忍新字段」的实测读数（不是推论）。
      expect(reading.manifestKeys).toEqual(WRITTEN_MANIFEST_KEYS);
      expect(reading.manifest?.features).toEqual(["attachments", "checksums-self"]);
      expect(reading.manifest?.format).toBe(DOC_FORMAT);
      expect(reading.manifest?.format_version).toBe(DOC_FORMAT_VERSION);
      expect(reading.manifest?.source).toBe("personal");
      expect(reading.manifest?.source_app_version).toBe("2.0.0-writer");
      expect(reading.manifest?.document_id).toBe("doc-writer-fixture-1");
      expect(reading.manifest?.title).toBe("写侧判据：导出的一篇");
      expect(reading.manifest?.created_at).toBe("2026-10-29T04:00:00.000Z");
      expect(reading.manifest?.updated_at).toBe("2026-10-29T05:00:00.000Z");
      expect(reading.manifest?.content_type).toBe("lexical-json");
      expect(reading.manifest?.encrypted).toBe(false);
      // 正文与 checksums 也逐字一致（企业版解出来的就是我们写进去的）
      expect(reading.content).toBe(CONTENT_JSON);
      const ours = JSON.parse(dec(byPath(await unzipDocument(zip)).get("checksums.json")!)) as {
        files: Record<string, string>;
      };
      expect(reading.checksums?.files).toEqual(ours.files);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("⑥ 容器：store 模式（不压缩）＋ 顺序固定 ＋ 同输入同字节", () => {
  it("㉟ 所有条目 method=0（store）；顺序 = 清单/正文/资产/校验和；同一输入逐字节相同", async () => {
    const input = await baseInput();
    const zip = await buildDocumentPackage(input);
    const dir = zipCentralDirectory(zip);
    expect(dir.map((e) => e.method)).toEqual([0, 0, 0, 0]);
    expect(dir.map((e) => e.name)).toEqual([
      MANIFEST_PATH,
      CONTENT_PATH,
      input.assets![0].path,
      "checksums.json",
    ]);

    // 同一份输入再写一次 ⇒ 逐字节相同（时间戳固定；checksums 可复现）
    const again = await buildDocumentPackage({ ...input, assets: [{ path: input.assets![0].path, bytes: new Uint8Array(ASSET_BYTES) }] });
    expect(Buffer.from(again).equals(Buffer.from(zip))).toBe(true);
  });
});

describe("⑦ 无资产也能导；正文/标题不合法 ⇒ 拒绝写", () => {
  it("㊱ assets 省略 ⇒ 3 条目、往返可读；正文不是 JSON 对象 / 标题为空 ⇒ 抛错", async () => {
    const noAssets = await baseInput({ assets: [] });
    const zip = await buildDocumentPackage(noAssets);
    const entries = await unzipDocument(zip);
    expect(entries.map((e) => e.path).sort()).toEqual([MANIFEST_PATH, CONTENT_PATH, "checksums.json"].sort());
    const r = await openDocumentPackage(entries);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pkg.manifest.assets).toEqual([]);
      expect(r.pkg.assets).toEqual([]);
      expect(r.pkg.docJson).toBe(CONTENT_JSON);
      expect(r.pkg.notices).toEqual([]);
    }
    // assets 字段省略（undefined）与空数组等价
    const omitted = await baseInput();
    delete (omitted as { assets?: unknown }).assets;
    await expect(buildDocumentPackage(omitted)).resolves.toBeInstanceOf(Uint8Array);

    // 正文：空 / 坏 JSON / 非对象 ⇒ 拒绝写
    await expect(buildDocumentPackage(await baseInput({ docJson: "" }))).rejects.toThrow(/不能为空/);
    await expect(buildDocumentPackage(await baseInput({ docJson: "{不是 JSON" }))).rejects.toThrow(/不合法/);
    await expect(buildDocumentPackage(await baseInput({ docJson: "[]" }))).rejects.toThrow(/必须是对象/);
    await expect(
      buildDocumentPackage(await baseInput({ docJson: [] as unknown as Record<string, unknown> })),
    ).rejects.toThrow(/必须是对象/);

    // 正文给对象 ⇒ 写侧序列化，读回同一份结构
    const asObject = await buildDocumentPackage(await baseInput({ docJson: LEXICAL_CONTENT }));
    const roundTrip = await openDocumentPackage(await unzipDocument(asObject));
    expect(roundTrip.ok).toBe(true);
    if (roundTrip.ok) expect(JSON.parse(roundTrip.pkg.docJson)).toEqual(LEXICAL_CONTENT);

    // 标题为空 ⇒ 复用格式层校验（⛔ 不写读端会拒的包）
    await expect(buildDocumentPackage(await baseInput({ title: "" }))).rejects.toThrow(/title/);
  });
});

describe("⑧ manifest 只写企业版字段 ＋ v1.1 的 features", () => {
  it("㊲ 字段集合与顺序 = 企业版必填 10 项 ＋ features（紧跟 format_version）；没有个人版扩展的 assets 字段与旧 created/updated", async () => {
    // 10 项企业版必填字段的名字与顺序一个字没动（features 只是插在 format_version 之后的新键）
    expect(WRITTEN_MANIFEST_KEYS.filter((k) => k !== "features")).toEqual(ENTERPRISE_MANIFEST_KEYS);
    const entries = await unzipDocument(await buildDocumentPackage(await baseInput()));
    const manifest = JSON.parse(dec(byPath(entries).get(MANIFEST_PATH)!)) as Record<string, unknown>;
    expect(Object.keys(manifest)).toEqual(WRITTEN_MANIFEST_KEYS);
    // baseInput 带一个资产、正文无 db ⇒ 声明 attachments ＋ checksums-self
    expect(manifest.features).toEqual(["attachments", "checksums-self"]);
    // 与格式层 buildManifest 的字段逐字一致（features 用同一份才可比），只少了扩展的 assets
    const fromFormatLayer = Object.keys(
      buildManifest({
        documentId: "doc-writer-fixture-1",
        title: "写侧判据：导出的一篇",
        createdAt: "2026-10-29T04:00:00.000Z",
        updatedAt: "2026-10-29T05:00:00.000Z",
        sourceAppVersion: "2.0.0-writer",
        features: ["attachments", "checksums-self"],
      }),
    );
    expect(fromFormatLayer.filter((k) => k !== "assets")).toEqual(Object.keys(manifest));
    // 不写扩展 / 旧字段（写了只会让读端多一条"清单外条目"的判据面）
    expect(manifest.assets).toBeUndefined();
    expect(manifest.created).toBeUndefined();
    expect(manifest.updated).toBeUndefined();
  });
});

describe("⑨ v1.1 features：写侧只声明真的用到的扩展（§1.2）", () => {
  const featuresOf = async (input: BuildDocumentPackageInput): Promise<unknown> => {
    const entries = await unzipDocument(await buildDocumentPackage(input));
    return (JSON.parse(dec(byPath(entries).get(MANIFEST_PATH)!)) as { features?: unknown }).features;
  };

  it("㊳ 无资产、无 db ⇒ 只声明 checksums-self（不是「什么都不声明」：checksums.json 是必带条目）", async () => {
    expect(await featuresOf(await baseInput({ assets: [] }))).toEqual(["checksums-self"]);
  });

  it("㊴ 带资产 ⇒ ＋attachments；正文根带 db ⇒ ＋db-namespace；三者齐时按规范顺序", async () => {
    expect(await featuresOf(await baseInput())).toEqual(["attachments", "checksums-self"]);
    const dbDoc = { root: { type: "root", children: [] }, db: { columns: [], views: [], rows: [] } };
    expect(await featuresOf(await baseInput({ assets: [], docJson: dbDoc }))).toEqual([
      "db-namespace",
      "checksums-self",
    ]);
    // 规范顺序（= `KNOWN_FEATURES` 的顺序），fixture 逐字节可复现靠它
    expect(await featuresOf(await baseInput({ docJson: dbDoc }))).toEqual([...KNOWN_FEATURES]);
  });

  it("㊵ 写出的包一定读得回来：manifest.features 全在白名单内（不认识的值写侧就拒了）", async () => {
    const opened = await openDocumentPackage(await unzipDocument(await buildDocumentPackage(await baseInput())));
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      for (const f of opened.pkg.manifest.features ?? []) expect(KNOWN_FEATURES).toContain(f);
    }
  });
});
