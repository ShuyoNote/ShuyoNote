import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { blake2b512 } from "./blake2b512.mjs";
import {
  coverageProblems,
  manifestPicks,
  parseMinisignPublicKey,
  parseMinisignSignature,
  platformKeyFor,
  selectArtifacts,
  verifyArtifactSignature,
  versionMatcher,
} from "./releaseArtifacts.mjs";

const entry = (dir, name, extra = {}) => ({
  dir,
  name,
  size: 1024,
  mtimeMs: Date.parse("2026-09-10T06:20:00Z"),
  sigPath: `/tmp/${name}.sig`,
  sigText: "sig",
  ...extra,
});

describe("versionMatcher（版本号必须整词匹配）", () => {
  const re = versionMatcher("1.84.6");

  it("认得正常产物名", () => {
    expect(re.test("ShuyoNote_1.84.6_x64-setup.exe")).toBe(true);
    expect(re.test("ShuyoNote_1.84.6_amd64.deb")).toBe(true);
    expect(re.test("ShuyoNote_1.84.6-beta_x64-setup.exe")).toBe(true);
  });

  it("不会被相邻数字骗到（旧实现的子串匹配会误纳）", () => {
    expect(re.test("ShuyoNote_1.84.60_x64-setup.exe")).toBe(false);
    expect(re.test("ShuyoNote_11.84.6_x64-setup.exe")).toBe(false);
    expect(re.test("ShuyoNote_1.84.61_amd64.deb")).toBe(false);
  });
});

describe("platformKeyFor", () => {
  it("映射到更新器清单的平台键", () => {
    expect(platformKeyFor("ShuyoNote_1.84.6_x64-setup.exe")).toBe("windows-x86_64");
    expect(platformKeyFor("ShuyoNote_1.84.6_amd64.deb")).toBe("linux-x86_64");
    expect(platformKeyFor("ShuyoNote_1.84.6_amd64.AppImage")).toBe("linux-x86_64");
    expect(platformKeyFor("ShuyoNote_1.84.6_aarch64.dmg")).toBe("darwin-aarch64");
    expect(platformKeyFor("readme.txt")).toBeNull();
  });
});

describe("selectArtifacts", () => {
  it("正常挑出本版本产物", () => {
    const { picked, problems } = selectArtifacts({
      version: "1.84.6",
      entries: [
        entry("nsis", "ShuyoNote_1.84.6_x64-setup.exe"),
        entry("deb", "ShuyoNote_1.84.6_amd64.deb"),
        entry("appimage", "ShuyoNote_1.84.6_amd64.AppImage"),
        entry("nsis", "ShuyoNote_1.84.5_x64-setup.exe"), // 旧版本，忽略
        entry("appimage", "ShuyoNote.AppDir"), // 中间产物，忽略
      ],
    });
    expect(problems).toEqual([]);
    expect(picked.map((e) => e.name).sort()).toEqual([
      "ShuyoNote_1.84.6_amd64.AppImage",
      "ShuyoNote_1.84.6_amd64.deb",
      "ShuyoNote_1.84.6_x64-setup.exe",
    ]);
  });

  it("同平台同扩展名的多个候选 → 报错而不是随便挑一个", () => {
    const { problems } = selectArtifacts({
      version: "1.84.6",
      entries: [
        entry("nsis", "ShuyoNote_1.84.6_x64-setup.exe", { size: 100 }),
        entry("nsis", "ShuyoNote_1.84.6_x64-setup (1).exe", { size: 200 }),
      ],
    });
    expect(problems.join()).toMatch(/有 2 个同类候选/);
  });

  it("同平台不同扩展名（deb + AppImage）不算歧义：两个都发", () => {
    const { picked, problems } = selectArtifacts({
      version: "1.84.6",
      entries: [entry("deb", "ShuyoNote_1.84.6_amd64.deb"), entry("appimage", "ShuyoNote_1.84.6_amd64.AppImage")],
    });
    expect(problems).toEqual([]);
    expect(picked).toHaveLength(2);
  });

  it("缺 .sig → 硬错误（旧实现只 warn 后静默丢弃），签名空 → 同样报错", () => {
    const noSig = selectArtifacts({
      version: "1.84.6",
      entries: [entry("nsis", "ShuyoNote_1.84.6_x64-setup.exe", { sigPath: null, sigText: null })],
    });
    expect(noSig.problems.join()).toMatch(/缺签名文件/);
    const emptySig = selectArtifacts({
      version: "1.84.6",
      entries: [entry("nsis", "ShuyoNote_1.84.6_x64-setup.exe", { sigText: "  " })],
    });
    expect(emptySig.problems.join()).toMatch(/签名文件为空/);
  });

  it("一个产物都没有 → 报错", () => {
    const { picked, problems } = selectArtifacts({ version: "1.84.6", entries: [] });
    expect(picked).toEqual([]);
    expect(problems.join()).toMatch(/未找到任何属于 v1\.84\.6/);
  });

  it("--artifacts 显式指定时不再依赖版本号启发式", () => {
    const entries = [entry("nsis", "ShuyoNote_1.84.6_x64-setup.exe"), entry("deb", "ShuyoNote_1.84.6_amd64.deb")];
    const { picked, problems, warnings } = selectArtifacts({
      version: "1.84.6",
      entries,
      explicit: ["ShuyoNote_1.84.6_x64-setup.exe"],
    });
    expect(problems).toEqual([]);
    expect(warnings).toEqual([]);
    expect(picked.map((e) => e.name)).toEqual(["ShuyoNote_1.84.6_x64-setup.exe"]);
  });

  it("--artifacts 指定了不存在的产物 → 报错（不静默少发）", () => {
    const { problems } = selectArtifacts({ version: "1.84.6", entries: [], explicit: ["ShuyoNote_1.84.6_x64-setup.exe"] });
    expect(problems.join()).toMatch(/显式指定的产物不存在/);
  });

  it("--artifacts 指定了文件名不含版本号的产物 → 警告（可能是跨版本误发）", () => {
    const { warnings } = selectArtifacts({
      version: "1.84.6",
      entries: [entry("nsis", "ShuyoNote_setup.exe")],
      explicit: ["ShuyoNote_setup.exe"],
    });
    expect(warnings.join()).toMatch(/不含版本号/);
  });
});

describe("manifestPicks（清单在同一平台键下只能留一个，取哪个必须可预期）", () => {
  it("linux 同时有 deb 与 AppImage → 清单指向 deb（沿用线上既有约定），并给出说明", () => {
    const { picks, notes } = manifestPicks([
      entry("appimage", "ShuyoNote_1.84.6_amd64.AppImage"),
      entry("deb", "ShuyoNote_1.84.6_amd64.deb"),
      entry("nsis", "ShuyoNote_1.84.6_x64-setup.exe"),
    ]);
    expect(picks.get("linux-x86_64").name).toBe("ShuyoNote_1.84.6_amd64.deb");
    expect(picks.get("windows-x86_64").name).toBe("ShuyoNote_1.84.6_x64-setup.exe");
    expect(notes.join()).toMatch(/清单指向 ShuyoNote_1\.84\.6_amd64\.deb/);
  });

  it("结果与遍历顺序无关", () => {
    const entries = [entry("deb", "ShuyoNote_1.84.6_amd64.deb"), entry("appimage", "ShuyoNote_1.84.6_amd64.AppImage")];
    const a = manifestPicks(entries).picks.get("linux-x86_64").name;
    const b = manifestPicks([...entries].reverse()).picks.get("linux-x86_64").name;
    expect(a).toBe(b);
  });
});

describe("coverageProblems（别把某个平台的更新通道砍掉）", () => {
  it("少了线上已有的平台 → 报错", () => {
    const p = coverageProblems({ previousKeys: ["windows-x86_64", "linux-x86_64"], nextKeys: ["linux-x86_64"] });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/windows-x86_64/);
  });

  it("平台变多或不变 → 没问题；首次发布（无历史）→ 没问题", () => {
    expect(coverageProblems({ previousKeys: ["linux-x86_64"], nextKeys: ["linux-x86_64", "windows-x86_64"] })).toEqual([]);
    expect(coverageProblems({ previousKeys: ["linux-x86_64"], nextKeys: ["linux-x86_64"] })).toEqual([]);
    expect(coverageProblems({ previousKeys: [], nextKeys: ["linux-x86_64"] })).toEqual([]);
    expect(coverageProblems({ previousKeys: undefined, nextKeys: ["linux-x86_64"] })).toEqual([]);
  });
});

describe("minisign 解析", () => {
  it("解析 tauri.conf.json 里的真实公钥", () => {
    const key = parseMinisignPublicKey(
      "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDIyQTk3Rjg1REVGOEQwMTMKUldRVDBQamVoWCtwSXJGS2UzbDU2akoyaTduQlJvZi9NT1cvb25mYzJaSHZieXZDQktCZDJGVS8K",
    );
    expect(key.alg).toBe("Ed");
    expect(key.keyId).toBe("13d0f8de857fa922");
    expect(key.raw).toHaveLength(32);
  });

  it("解析双层 base64 的 .sig，并读出被签文件名", () => {
    const blob = Buffer.concat([Buffer.from("ED"), Buffer.alloc(8, 1), Buffer.alloc(64, 2)]);
    const text = `untrusted comment: signature from tauri secret key\n${blob.toString("base64")}\ntrusted comment: timestamp:1\tfile:ShuyoNote_1.84.6_x64-setup.exe\nAAAA\n`;
    const parsed = parseMinisignSignature(Buffer.from(text).toString("base64"));
    expect(parsed.alg).toBe("ED");
    expect(parsed.signature).toHaveLength(64);
    expect(parsed.signedFileName).toBe("ShuyoNote_1.84.6_x64-setup.exe");
  });

  it("畸形签名抛错（由 verifyArtifactSignature 转成 unsupported）", () => {
    expect(() => parseMinisignSignature("not-base64-at-all")).toThrow();
  });
});

describe("verifyArtifactSignature（用合成密钥对端到端覆盖校验路径）", () => {
  const dir = mkdtempSync(join(tmpdir(), "shuyo-release-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(12); // SPKI 头 12 字节
  const keyId = Buffer.from("1122334455667788", "hex");
  const pubkeyB64 = Buffer.from(
    `untrusted comment: minisign public key: 8877665544332211\n${Buffer.concat([Buffer.from("Ed"), keyId, rawPub]).toString("base64")}\n`,
  ).toString("base64");

  const makeSig = (name, data, { alg = "ED", breakBits = 0, signedName = name } = {}) => {
    const digest = alg === "ED" ? blake2b512(data) : data;
    const sig = cryptoSign(null, digest, privateKey);
    if (breakBits) sig[0] ^= 0xff; // 故意破坏签名，模拟「配对错了」
    const blob = Buffer.concat([Buffer.from(alg), keyId, sig]);
    const text = `untrusted comment: signature from tauri secret key\n${blob.toString("base64")}\ntrusted comment: timestamp:1\tfile:${signedName}\n${Buffer.alloc(64).toString("base64")}\n`;
    return Buffer.from(text).toString("base64");
  };

  const write = (name, data) => {
    const p = join(dir, name);
    writeFileSync(p, data);
    return p;
  };

  it("配对正确 → ok", async () => {
    const data = Buffer.from("installer bytes 安装包字节");
    const p = write("ShuyoNote_1.84.6_x64-setup.exe", data);
    const r = await verifyArtifactSignature({ filePath: p, sigText: makeSig("ShuyoNote_1.84.6_x64-setup.exe", data), publicKey: pubkeyB64 });
    expect(r.status, r.detail).toBe("ok");
  });

  it("文件被改过一个字节 → mismatch（这是发布前必须拦住的那类事故）", async () => {
    const data = Buffer.from("installer bytes");
    const sig = makeSig("ShuyoNote_1.84.6_x64-setup.exe", data);
    const p = write("ShuyoNote_1.84.6_x64-setup.exe", Buffer.concat([data, Buffer.from("!")]));
    const r = await verifyArtifactSignature({ filePath: p, sigText: sig, publicKey: pubkeyB64 });
    expect(r.status).toBe("mismatch");
    expect(r.detail).toMatch(/很可能不是同一次构建/);
  });

  it("签名本身损坏 → mismatch", async () => {
    const data = Buffer.from("installer bytes");
    const p = write("ShuyoNote_1.84.6_x64-setup.exe", data);
    const r = await verifyArtifactSignature({
      filePath: p,
      sigText: makeSig("ShuyoNote_1.84.6_x64-setup.exe", data, { breakBits: 1 }),
      publicKey: pubkeyB64,
    });
    expect(r.status).toBe("mismatch");
  });

  it("签名是给别的文件做的 → mismatch（同名同版本残留的典型形态）", async () => {
    const data = Buffer.from("installer bytes");
    const p = write("ShuyoNote_1.84.6_x64-setup.exe", data);
    const r = await verifyArtifactSignature({
      filePath: p,
      sigText: makeSig("ShuyoNote_1.84.6_x64-setup.exe", data, { signedName: "ShuyoNote_1.84.5_x64-setup.exe" }),
      publicKey: pubkeyB64,
    });
    expect(r.status).toBe("mismatch");
    expect(r.detail).toMatch(/签名是为 .* 做的/);
  });

  it("keyId 不匹配 → mismatch（不是这把密钥签的）", async () => {
    const data = Buffer.from("installer bytes");
    const p = write("ShuyoNote_1.84.6_x64-setup.exe", data);
    const blob = Buffer.concat([Buffer.from("ED"), Buffer.alloc(8, 9), cryptoSign(null, blake2b512(data), privateKey)]);
    const text = `untrusted comment: x\n${blob.toString("base64")}\ntrusted comment: timestamp:1\tfile:ShuyoNote_1.84.6_x64-setup.exe\nAAAA\n`;
    const r = await verifyArtifactSignature({ filePath: p, sigText: Buffer.from(text).toString("base64"), publicKey: pubkeyB64 });
    expect(r.status).toBe("mismatch");
    expect(r.detail).toMatch(/keyId/);
  });

  it("未知算法标识 → unsupported（只警告，不阻断发布）", async () => {
    const data = Buffer.from("installer bytes");
    const p = write("ShuyoNote_1.84.6_x64-setup.exe", data);
    const r = await verifyArtifactSignature({
      filePath: p,
      sigText: makeSig("ShuyoNote_1.84.6_x64-setup.exe", data, { alg: "XX" }),
      publicKey: pubkeyB64,
    });
    expect(r.status).toBe("unsupported");
  });

  it("非预哈希（Ed）模式也能校验", async () => {
    const data = Buffer.from("legacy raw-signed bytes");
    const p = write("ShuyoNote_1.84.6_x64-setup.exe", data);
    const r = await verifyArtifactSignature({
      filePath: p,
      sigText: makeSig("ShuyoNote_1.84.6_x64-setup.exe", data, { alg: "Ed" }),
      publicKey: pubkeyB64,
    });
    expect(r.status, r.detail).toBe("ok");
  });
});
