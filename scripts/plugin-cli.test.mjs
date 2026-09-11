// 作者 CLI 的口径必须**与应用一致**——这里钉住最容易走偏的那一条。
//
// 背景：`manifest.permissions` 有三种写法，应用侧（Rust `resolve_permissions`）的语义是：
//   · **没写**这个字段 → 按 v1 基线授权（12 项权限，等于全给）——老插件的兼容路径；
//   · **空数组** `[]`     → 一项都不授予；
//   · 有内容            → 只授予列出的那些（未知 id 忽略并提醒）。
// 而 CLI 曾经只看"数组长度"，于是 `permissions: []` 会被打印成「未声明 → 基线全给」——
// 与应用的所作所为**正好相反**。作者据此以为自己的插件拿到了一堆权限（或者以为没拿到），
// 这种"两条路说两套话"正是仓库历史上吃过亏的地方（"CLI 说没问题、应用却拒载"）。
//
// 这条测试直接跑真 CLI（子进程），断言两种写法的输出不同且各自正确。
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makePlugin(dirName, manifest) {
  const dir = join(workdir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  writeFileSync(
    join(dir, "main.js"),
    'register({ id: "' + dirName + '.x", title: "x", run: function () { return "x"; } });\n',
    "utf8",
  );
  return dir;
}

function validate(dir) {
  try {
    return execFileSync("node", [join(root, "scripts", "plugin-cli.mjs"), "validate", dir], {
      encoding: "utf8",
    });
  } catch (e) {
    const err = e;
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
}

const workdir = mkdtempSync(join(tmpdir(), "plugin-cli-test-"));

describe("作者 CLI 与应用的权限语义一致", () => {
  it("permissions: [] 是「一项都不给」，不是「未声明 → 基线全给」", () => {
    const dir = makePlugin("empty-perms", {
      id: "empty-perms",
      name: "空权限",
      version: "1.0.0",
      apiVersion: "1.0.0",
      main: "main.js",
      permissions: [],
    });
    const out = validate(dir);
    expect(out).toContain("声明为空");
    expect(out).not.toContain("基线");
  });

  it("没写 permissions 才是「未声明 → 基线全给」，并且带提醒", () => {
    const dir = makePlugin("absent-perms", {
      id: "absent-perms",
      name: "未声明",
      version: "1.0.0",
      apiVersion: "1.0.0",
      main: "main.js",
    });
    const out = validate(dir);
    expect(out).toContain("未声明");
    expect(out).toContain("基线");
    expect(out).toContain("permissions_absent");
  });

  it("写了应用不读的字段会提醒，并针对 commands 说清正确做法", () => {
    const dir = makePlugin("unknown-field", {
      id: "unknown-field",
      name: "未知字段",
      version: "1.0.0",
      apiVersion: "1.0.0",
      main: "main.js",
      permissions: [],
      commands: [{ id: "unknown-field.x", title: "x" }],
    });
    const out = validate(dir);
    expect(out).toContain("manifest_unknown_field");
    expect(out).toContain("不会读");
    expect(out).toContain("register({...})");
  });

  it("解析了但不显示的字段也如实说（author）", () => {
    const dir = makePlugin("author-field", {
      id: "author-field",
      name: "作者字段",
      version: "1.0.0",
      apiVersion: "1.0.0",
      main: "main.js",
      permissions: [],
      author: "someone",
    });
    const out = validate(dir);
    expect(out).toContain("manifest_field_not_shown");
    expect(out).toContain("界面上不显示");
  });

  it("--json 里也带上「是否走了基线」，机器读的那份同样不能含糊", () => {
    const dir = makePlugin("json-perms", {
      id: "json-perms",
      name: "JSON",
      version: "1.0.0",
      apiVersion: "1.0.0",
      main: "main.js",
      permissions: [],
    });
    const out = validateJson(dir);
    expect(out.permissionsBaseline).toBe(false);
    expect(out.ok).toBe(true);
  });
});

function validateJson(dir) {
  const raw = execFileSync(
    "node",
    [join(root, "scripts", "plugin-cli.mjs"), "validate", dir, "--json"],
    { encoding: "utf8" },
  );
  return JSON.parse(raw);
}

// 清理：临时目录里的插件只活在这条测试里
process.on("exit", () => {
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响测试结论 */
  }
});
