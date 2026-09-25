// 门禁清单自身的回归测试——"防火体系"里最容易被忽略的一环：
// **门禁清单也是一种代码**，它会被顺手删掉、改名、或写错命令，而那一刻没有任何东西变红。
//
// 这个文件把几类"静默退化"变成机器可查的不变量：
//   · id 重复 / 分组写错 ⇒ 汇总里两条门禁互相覆盖；
//   · 命令指向的脚本不存在 ⇒ 门禁永远红或永远不跑；
//   · 本地默认组里混进需要浏览器 / cargo 的门禁 ⇒ 新机器上"一键本地验收"直接红，很快就没人跑；
//   · 标了 baseline 却没有 counters ⇒ 基线永远读不到数，"只增不减"名存实亡；
//   · 注册表少了一条 CI 必需的门禁 ⇒ 覆盖悄悄缩水（配合 tests/baseline.json 的 gates 段）。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_GROUPS, DEFAULT_GROUP_FORBIDDEN, GATES, GROUP_ORDER } from "./lib/gates.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "tests", "baseline.json");

// CI 必须存在的门禁（少了任何一条都意味着覆盖缩水，而不是"精简"）。
// 这份清单故意写死：新增门禁请加进来，删除门禁请在这里留下理由。
const REQUIRED_GATE_IDS = [
  "check-versions",
  "check-changelog",
  "check-changelog-numbers",
  "check-web-commands",
  "check-capabilities",
  "check-doc-links",
  "check-doc-content-access",
  "check-workflow-yaml",
  "check-gitcode-workflow-rules",
  "check-overlay-registry",
  "check-hook-order",
  "check-ps1-ascii",
  "check-pdfjs-shim",
  "check-sys-deps",
  "check-sys-deps-linux",
  "check-ocr-assets",
  "check-deep-link",
  "check-derived-writers",
  "check-plugin-hosting",
  "check-store-subscriptions",
  "tsc",
  "vitest",
  "smoke-web",
  "two-device-sync",
  "plugin-cli-validate",
  "check-pdf-reload",
  "check-panel-layout",
  "check-web-build",
  "mobile-layout",
  "mobile-overlays",
  "rust-test",
  "rust-plugins-alone",
  "external-index",
  "external-package",
  "plugin-fragment-no-zip",
];

function commandsOf(gate) {
  if (gate.cmd) return Array.isArray(gate.cmd) ? gate.cmd : [gate.cmd];
  return [];
}

function localPathsIn(cmdline) {
  // 只挑形如 scripts/xxx.mjs、examples/plugins、src-tauri/... 的仓内路径做存在性检查。
  return cmdline
    .split(/\s+/)
    .map((tok) => tok.replaceAll("{tmp}", ".test-report-tmp"))
    .filter((tok) => /^(scripts|examples|src-tauri|docs)\//.test(tok) && /\.[a-z]+$/i.test(tok));
}

describe("门禁注册表（scripts/lib/gates.mjs）", () => {
  it("id 不重复", () => {
    const ids = GATES.map((g) => g.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  it("每条门禁都有 id / 标签 / 合法分组", () => {
    for (const gate of GATES) {
      expect(gate.id, "缺少 id").toBeTruthy();
      expect(gate.label, `${gate.id} 缺少 label`).toBeTruthy();
      expect(GROUP_ORDER, `${gate.id} 的分组 ${gate.group} 不在 GROUP_ORDER 里`).toContain(gate.group);
      // 没有 cmd 的门禁必须自带 runner（如 plugin-cli 这种需要 JS 循环的）
      if (!gate.cmd) expect(gate.runner, `${gate.id} 既没有 cmd 也没有 runner`).toBeTruthy();
    }
  });

  it("命令里引用的仓内脚本真实存在", () => {
    const missing = [];
    for (const gate of GATES) {
      for (const cmdline of commandsOf(gate)) {
        for (const p of localPathsIn(cmdline)) {
          if (!existsSync(join(root, p))) missing.push(`${gate.id}: ${p}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("标了 baseline 的门禁必须有 counters（否则永远读不到读数）", () => {
    for (const gate of GATES.filter((g) => g.baseline)) {
      expect(gate.counters, `${gate.id} 标了 baseline 却没有 counters`).toBeTruthy();
    }
  });

  it("本地默认组不许依赖浏览器 / cargo / dev server", () => {
    const offenders = [];
    for (const gate of GATES.filter((g) => DEFAULT_GROUPS.includes(g.group))) {
      const text = [gate.id, ...commandsOf(gate)].join(" ");
      for (const bad of DEFAULT_GROUP_FORBIDDEN) {
        if (text.includes(bad)) offenders.push(`${gate.id} 命中 ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("CI 必需门禁一条都不缺", () => {
    const ids = GATES.map((g) => g.id);
    expect(REQUIRED_GATE_IDS.filter((id) => !ids.includes(id))).toEqual([]);
  });

  it("--list 端到端可用，且清单里的每条门禁都打印出来", () => {
    const r = spawnSync(process.execPath, ["scripts/test-report.mjs", "--list"], { cwd: root, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    for (const gate of GATES) expect(r.stdout, `--list 没打印 ${gate.id}`).toContain(gate.id);
  });
});

// 外部套件登记表：它是"覆盖边界公开可见"的唯一载体，字段缺了就等于边界又糊了。
describe("外部套件登记（tests/external-suites.json）", () => {
  const p = join(root, "tests", "external-suites.json");
  it("每个套件都有稳定 id / 名称 / 跑在哪 / 现状，且 id 不重复", () => {
    const j = JSON.parse(readFileSync(p, "utf8"));
    expect(Array.isArray(j.suites)).toBe(true);
    expect(j.suites.length).toBeGreaterThan(0);
    for (const s of j.suites) {
      expect(s.id, `${s.name} 缺少稳定 id`).toBeTruthy();
      expect(s.name, `${s.id} 缺少名称`).toBeTruthy();
      expect(s.where, `${s.id} 没写"跑在哪"`).toBeTruthy();
      expect(s.status, `${s.id} 没写现状`).toBeTruthy();
    }
    const ids = j.suites.map((s) => s.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i), "套件 id 重复").toEqual([]);
  });

  it("howToUpdate 指向回写脚本（别手写 status——一定会腐烂）", () => {
    const j = JSON.parse(readFileSync(p, "utf8"));
    expect(String(j.howToUpdate || "")).toContain("external-suite-status.mjs");
  });
});

describe("基线文件（tests/baseline.json）", () => {  const exists = existsSync(baselinePath);
  it.runIf(exists)("解析得动，且只引用注册表里真实存在的门禁", () => {
    const j = JSON.parse(readFileSync(baselinePath, "utf8"));
    const ids = GATES.map((g) => g.id);
    for (const key of Object.keys(j.counts || {})) expect(ids, `基线里的 ${key} 不在注册表`).toContain(key);
    for (const [group, list] of Object.entries(j.gates || {})) {
      expect(GROUP_ORDER, `基线里的分组 ${group} 非法`).toContain(group);
      for (const id of list) expect(ids, `基线 gates.${group} 里的 ${id} 不在注册表`).toContain(id);
    }
  });

  it.runIf(exists)("注册表里的每条门禁都登记在基线里（新增门禁必须跑 --update-baseline）", () => {
    const j = JSON.parse(readFileSync(baselinePath, "utf8"));
    const recorded = new Set(Object.values(j.gates || {}).flat());
    const missing = GATES.map((g) => g.id).filter((id) => !recorded.has(id));
    expect(missing, "新增了门禁却没更新 tests/baseline.json（跑 node scripts/test-report.mjs --update-baseline）").toEqual([]);
  });
});
