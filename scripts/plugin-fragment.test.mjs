// `scripts/plugin-fragment.mjs` 的 CLI 级测试：**流水线本身**坏没坏。
//
// 为什么用 CLI 级而不是单测内部函数：这个工具的产物是**要发出去的东西**
// （社区索引会长期引用里面的 url/size/sha256/签名）。所以测的就是"跑完这条命令之后，
// 磁盘上那些文件到底对不对"——内部函数拆得再漂亮，也不如"包能解、哈希对得上、签名非空"。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
};

const run = (args, { expectFail = false } = {}) => {
  try {
    const out = execFileSync("node", [join(root, "scripts", "plugin-fragment.mjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (expectFail) return { code: 0, out };
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

console.log("插件索引片段工具（打包 → 签名 → 片段）");

// 1) 自检模式：一次性密钥签一个真插件，产出可验证的片段与预览索引
const out1 = mkdtempSync(join(tmpdir(), "frag-"));
const r1 = run([
  "--plugins",
  "examples/plugins/md-outline",
  "--out",
  out1,
  "--ephemeral-key",
  "--version",
  "9.9.9",
  "--url-base",
  "https://example.com/dl",
]);
ok(r1.code === 0, `自检模式跑通（exit ${r1.code}）`);

const zipPath = join(out1, "md-outline-1.0.0.zip");
const fragPath = join(out1, "plugin-index.fragment.json");
const previewPath = join(out1, "plugin-index.preview.json");
ok(existsSync(zipPath), "插件包已产出");
ok(existsSync(fragPath) && existsSync(previewPath), "片段与预览索引都已产出");

const zipBytes = readFileSync(zipPath);
const frag = JSON.parse(readFileSync(fragPath, "utf8"));
const entry = frag.plugins[0];
ok(entry.id === "md-outline", `条目 id 正确（${entry.id}）`);
ok(entry.size === statSync(zipPath).size, `size 与磁盘一致（${entry.size}）`);
ok(
  entry.sha256 === createHash("sha256").update(zipBytes).digest("hex"),
  "sha256 与磁盘一致（对不上会被应用拒绝安装）",
);
ok(entry.downloadUrl === "https://example.com/dl/md-outline-1.0.0.zip", `downloadUrl 带版本号：${entry.downloadUrl}`);
ok(frag.appVersion === "9.9.9", "--version 生效（片段记录发布版本）");
ok(entry.minAppVersion === "9.9.9", "minAppVersion 默认取当前应用版本（硬闸门，宁可显式）");
ok(typeof entry.publisherKey === "string" && entry.publisherKey.includes("minisign public key"), "带发布者公钥全文");
ok(typeof entry.signature === "string" && entry.signature.includes("trusted comment"), "带发布者签名全文");
ok(entry.permissions.length === 1 && entry.permissions[0].id === "write:pages", "权限从 manifest 镜像过来");
ok(
  entry.permissions.every((p) => p.reason && p.reason.length > 0),
  "权限理由非空（空着会被读成「不要权限」）",
);
ok(existsSync(join(out1, "publisher.pub")), "自检模式落下了公钥（供本机验证署名者）");
ok(existsSync(join(previewPath, "..", "plugin-index.preview.json.minisig")), "预览索引也被签了（本机验签用）");
ok(
  JSON.parse(readFileSync(previewPath, "utf8")).plugins.length === 1,
  "预览索引是一份**完整**索引（能直接喂给应用的真解析器）",
);

// 2) dry-run：只打包算哈希，**不签名**（也正因如此不允许出现在正式发布里）
const out2 = mkdtempSync(join(tmpdir(), "frag-"));
const r2 = run(["--plugins", "examples/plugins/md-outline", "--out", out2, "--dry-run"]);
ok(r2.code === 0, `dry-run 跑通（exit ${r2.code}）`);
const frag2 = JSON.parse(readFileSync(join(out2, "plugin-index.fragment.json"), "utf8"));
ok(frag2.plugins[0].signature === "", "dry-run 不产出签名（不会假装签过）");
ok(!existsSync(join(out2, "plugin-index.preview.json.minisig")), "dry-run 不产出索引签名");

// 3) 没给签名方式 → **直接失败**，而不是悄悄产出一份没签名的片段发出去
const out3 = mkdtempSync(join(tmpdir(), "frag-"));
const r3 = run(["--plugins", "examples/plugins/md-outline", "--out", out3]);
ok(r3.code !== 0, `缺签名方式时报错退出（exit ${r3.code}）`);
ok(/--minisign|--ephemeral-key|--dry-run/.test(r3.out), "错误信息里说清三种出路");

// 4) 校验不过的插件不打包（发出去的包不能是"装了但什么也没有"）
const out4 = mkdtempSync(join(tmpdir(), "frag-"));
// 用一个**空目录**当"没有任何插件"的现场（不要用 /tmp：那里可能有别人留下的插件目录，
// 我第一次就踩了这个——工具找对了，是测试的现场挑错了）
const emptyDir = mkdtempSync(join(tmpdir(), "frag-empty-"));
const r4 = run(["--plugins", emptyDir, "--out", out4, "--ephemeral-key"]);
ok(r4.code !== 0, `找不到插件时报错退出（exit ${r4.code}）`);
ok(/没有找到任何插件目录/.test(r4.out), "说清是「没找到插件目录」而不是别的失败");

console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
