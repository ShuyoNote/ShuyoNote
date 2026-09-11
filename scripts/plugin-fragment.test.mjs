// `scripts/plugin-fragment.mjs` 的 CLI 级测试：**流水线本身**坏没坏。
//
// 为什么用 CLI 级而不是单测内部函数：这个工具的产物是**要发出去的东西**
// （社区索引会长期引用里面的 url/size/sha256/签名）。所以测的就是"跑完这条命令之后，
// 磁盘上那些文件到底对不对"——内部函数拆得再漂亮，也不如"包能解、哈希对得上、签名非空"。
//
// 注意（踩过的坑）：这里必须写成 **vitest 套件**（`it`/`expect`），不能自己 `process.exit`——
// `vitest.config.ts` 把 `scripts/**/*.test.mjs` 收进了测试集，自跑式脚本在 vitest 里会报
// "process.exit unexpectedly called"。CI 就是这么红的（本地那次恰好没触发，所以更该记住）。
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 跑一次工具；返回退出码与输出（不抛异常，好让断言自己说清原因）。 */
function runFragment(args) {
  try {
    const out = execFileSync("node", [join(root, "scripts", "plugin-fragment.mjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const tempOut = () => mkdtempSync(join(tmpdir(), "frag-"));

describe("插件索引片段工具（打包 → 签名 → 片段）", () => {
  it("自检模式：产物在磁盘上对得上（size/sha256/签名/公钥）", () => {
    const out = tempOut();
    const r = runFragment([
      "--plugins",
      "examples/plugins/md-outline",
      "--out",
      out,
      "--ephemeral-key",
      "--version",
      "9.9.9",
      "--url-base",
      "https://example.com/dl",
    ]);
    expect(r.code, r.out).toBe(0);

    const zipPath = join(out, "md-outline-1.0.0.zip");
    const frag = JSON.parse(readFileSync(join(out, "plugin-index.fragment.json"), "utf8"));
    const preview = JSON.parse(readFileSync(join(out, "plugin-index.preview.json"), "utf8"));
    const entry = frag.plugins[0];

    expect(existsSync(zipPath)).toBe(true);
    expect(entry.id).toBe("md-outline");
    // 这两个数必须与磁盘上的字节一致：对不上应用会直接拒绝安装
    expect(entry.size).toBe(statSync(zipPath).size);
    expect(entry.sha256).toBe(createHash("sha256").update(readFileSync(zipPath)).digest("hex"));
    // downloadUrl 带版本号（资源不可覆盖重传）
    expect(entry.downloadUrl).toBe("https://example.com/dl/md-outline-1.0.0.zip");
    // minAppVersion 默认取当前应用版本：随 N 版发布的插件只保证 N+ 可用
    expect(frag.appVersion).toBe("9.9.9");
    expect(entry.minAppVersion).toBe("9.9.9");
    expect(entry.publisherKey).toContain("minisign public key");
    expect(entry.signature).toContain("trusted comment");
    // 权限从 manifest 镜像，且理由非空（空着会被读成"不要权限"）
    expect(entry.permissions.map((p) => p.id)).toEqual(["write:pages"]);
    expect(entry.permissions.every((p) => p.reason.length > 0)).toBe(true);
    expect(existsSync(join(out, "publisher.pub"))).toBe(true);
    expect(existsSync(join(out, "plugin-index.preview.json.minisig"))).toBe(true);
    // 预览索引是一份**完整**索引：能直接喂给应用真正的解析器
    expect(preview.plugins).toHaveLength(1);
  });

  it("dry-run：只打包算哈希，**不假装签过**", () => {
    const out = tempOut();
    const r = runFragment(["--plugins", "examples/plugins/md-outline", "--out", out, "--dry-run"]);
    expect(r.code, r.out).toBe(0);
    const frag = JSON.parse(readFileSync(join(out, "plugin-index.fragment.json"), "utf8"));
    expect(frag.plugins[0].signature).toBe("");
    expect(existsSync(join(out, "plugin-index.preview.json.minisig"))).toBe(false);
  });

  it("没给签名方式 → 直接失败（绝不产出一份没签名的片段发出去）", () => {
    const r = runFragment(["--plugins", "examples/plugins/md-outline", "--out", tempOut()]);
    expect(r.code).not.toBe(0);
    // 错误信息要说清三条出路，而不是只说"错了"
    expect(r.out).toMatch(/--minisign|--ephemeral-key|--dry-run/);
  });

  it("找不到插件目录 → 说清是「没找到插件目录」而不是别的失败", () => {
    // 用一个**空目录**当现场（不要用 /tmp：那里可能有别的插件目录，我第一次就选错了现场）
    const empty = mkdtempSync(join(tmpdir(), "frag-empty-"));
    const r = runFragment(["--plugins", empty, "--out", tempOut(), "--ephemeral-key"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("没有找到任何插件目录");
  });
});
