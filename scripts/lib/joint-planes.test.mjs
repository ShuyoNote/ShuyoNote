// `scripts/lib/joint-planes.mjs`（三平面联合验收登记表）的判据。
//
// 为什么这份判据比一般的不变量测试重要：登记表是**计划本身**。它会腐烂的两种方式都很安静：
//   ① 探针指着一个**已经被改名/搬走**的文件 ⇒ 联合验收那天才发现"看就绪"全是假的；
//   ② `docs/JOINT-ACCEPTANCE.md` 里那张表与登记表**各说各话** ⇒ 读文档的人按旧计划准备。
// 所以这里除了纯函数，还钉两条**跨文件**的断言：探针目标必须真实存在；文档那一块必须逐字相等。
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PLANES,
  JOINT_CELLS,
  PROBE_KINDS,
  evaluateProbe,
  planeReadiness,
  renderDocFacts,
  renderJointText,
} from "./joint-planes.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const docPath = resolve(root, "docs/JOINT-ACCEPTANCE.md");

const allProbes = PLANES.flatMap((p) => p.probes.map((probe) => ({ plane: p.id, ...probe })));

describe("joint-planes：登记表自身的形状", () => {
  it("平面 id 唯一，且三平面都在（国密 / 覆盖 / CRDT）", () => {
    const ids = PLANES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(["coverage", "crdt", "sm"]);
  });

  it("探针 id 全局唯一（两处同名 ⇒ 报错时看不出是哪一处）", () => {
    const ids = allProbes.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每个探针的 kind 都在 PROBE_KINDS 里（加了新 kind 必须同时给 evaluateProbe 分支）", () => {
    for (const p of allProbes) expect(PROBE_KINDS, `${p.id}`).toContain(p.kind);
  });

  it("★ 探针指到的文件**真实存在**（改名/搬走 ⇒ 这一条当场红，而不是等联合验收那天）", () => {
    const missing = [];
    for (const p of allProbes) {
      const target = p.kind === "path" ? p.target : p.kind === "grep" ? p.file : null;
      if (target && !existsSync(resolve(root, target))) missing.push(`${p.id} → ${target}`);
    }
    expect(missing).toEqual([]);
  });

  it("每个平面都有 why（为什么它必须参与联合）＋ 至少一条单独读数", () => {
    for (const p of PLANES) {
      expect(p.why, `${p.id}.why`).toBeTruthy();
      expect(p.readings.length, `${p.id}.readings`).toBeGreaterThan(0);
      for (const r of p.readings) {
        expect(r.cmd, `${p.id} 读数命令`).toBeTruthy();
        expect(r.criterion, `${p.id} 读数判据`).toBeTruthy();
        expect(r.owners.length, `${p.id} 读数责任方`).toBeGreaterThan(0);
      }
    }
  });
});

describe("joint-planes：联合格子的契约", () => {
  it("★ 每格必须跨 ≥2 个平面 —— 否则它是某个平面的单独读数，不该混进联合矩阵", () => {
    for (const c of JOINT_CELLS) {
      expect(new Set(c.planes).size, `${c.id} 跨平面数`).toBeGreaterThanOrEqual(2);
      for (const p of c.planes) expect(PLANES.map((x) => x.id), `${c.id} 引用的平面`).toContain(p);
    }
  });

  it("每格都有 title / criterion / why / owner / state", () => {
    for (const c of JOINT_CELLS) {
      expect(c.title, `${c.id}.title`).toBeTruthy();
      expect(c.criterion, `${c.id}.criterion`).toBeTruthy();
      expect(c.why, `${c.id}.why`).toBeTruthy();
      expect(["macos", "windows", "amd", "ci", "owner"], `${c.id}.owner`).toContain(c.owner);
      expect(["landed", "todo", "manual"], `${c.id}.state`).toContain(c.state);
    }
  });

  it("landed ⇒ 有命令（否则它凭什么叫「今天就能跑」）", () => {
    for (const c of JOINT_CELLS.filter((x) => x.state === "landed")) expect(c.cmd, `${c.id}.cmd`).toBeTruthy();
  });

  it("todo / manual ⇒ 有 ref（施工单或谁去跑），不许只有一句愿望", () => {
    for (const c of JOINT_CELLS.filter((x) => x.state !== "landed")) expect(c.ref, `${c.id}.ref`).toBeTruthy();
  });

  it("★ cargo 格必须有 minPassed ≥ 1（空跑即红：判据被删掉时读数会掉到下限以下）", () => {
    for (const c of JOINT_CELLS.filter((x) => x.cmd && /cargo test/.test(x.cmd))) {
      expect(c.minPassed ?? 0, `${c.id}.minPassed`).toBeGreaterThanOrEqual(1);
    }
  });

  it("★ 会「自报跳过」的门禁必须标 forbidSkip（联合验收里跳过 ≠ 通过）", () => {
    const gmWired = JOINT_CELLS.find((c) => c.cmd && c.cmd.includes("check-gm-wired"));
    expect(gmWired?.forbidSkip, "check-gm-wired 那格").toBe(true);
  });
});

describe("joint-planes：三态判定（未实查 ≠ 红）", () => {
  const base = { id: "x", kind: "path", target: "a" };

  it("path：在 ⇒ ok true；不在 ⇒ ok false", () => {
    expect(evaluateProbe(base, { exists: () => true }).ok).toBe(true);
    expect(evaluateProbe(base, { exists: () => false }).ok).toBe(false);
  });

  it("grep：文件缺 ⇒ false（不是抛），命中 ⇒ true", () => {
    expect(evaluateProbe({ id: "g", kind: "grep", file: "f", pattern: "p" }, { exists: () => false }).ok).toBe(false);
    expect(
      evaluateProbe({ id: "g", kind: "grep", file: "f", pattern: "p" }, { exists: () => true, readFile: () => "xpx" }).ok,
    ).toBe(true);
  });

  it("★ manual ⇒ **永远是未实查**（ok === null），本机查不出别人那台机器上跑没跑过", () => {
    const r = evaluateProbe({ id: "m", kind: "manual", external: true, how: "某台机器" }, { exists: () => true });
    expect(r.ok).toBeNull();
    expect(r.external).toBe(true);
    expect(r.detail).toContain("未实查");
  });

  it("未知 kind ⇒ 抛（不许静默当成「通过」）", () => {
    expect(() => evaluateProbe({ id: "z", kind: "wishful" }, {})).toThrow(/未知的探针/);
  });

  it("★ external 探针不参与本机就绪；本机探针缺一条 ⇒ not-ready 并点名", () => {
    const plane = { id: "p" };
    const ready = planeReadiness(plane, [
      { id: "a", external: false, ok: true, detail: "" },
      { id: "b", external: true, ok: null, detail: "" },
    ]);
    expect(ready.state).toBe("ready");
    expect(ready.pending).toHaveLength(1);

    const notReady = planeReadiness(plane, [
      { id: "a", external: false, ok: false, detail: "缺 a" },
      { id: "b", external: true, ok: null, detail: "" },
    ]);
    expect(notReady.state).toBe("not-ready");
    expect(notReady.missing.map((m) => m.id)).toEqual(["a"]);
  });

  it("renderJointText 里每个格子都出现（就绪面板与矩阵共用同一份渲染）", () => {
    const text = renderJointText({ readiness: [] });
    for (const c of JOINT_CELLS) expect(text).toContain(c.id);
  });
});

describe("joint-planes：文档那一块必须与登记表逐字一致（反腐烂）", () => {
  it("docs/JOINT-ACCEPTANCE.md 有机器事实块，且内容 === renderDocFacts()", () => {
    expect(existsSync(docPath), "缺 docs/JOINT-ACCEPTANCE.md").toBe(true);
    const text = readFileSync(docPath, "utf8");
    const m = text.match(/<!-- joint:begin -->\n([\s\S]*?)\n<!-- joint:end -->/);
    expect(m, "找不到 <!-- joint:begin -->…<!-- joint:end --> 块").toBeTruthy();
    expect(m[1].trimEnd()).toBe(renderDocFacts());
  });

  it("文档里点名了每个联合格子（表格与矩阵不许各说各话）", () => {
    const text = readFileSync(docPath, "utf8");
    for (const c of JOINT_CELLS) expect(text, `文档缺 ${c.id}`).toContain(c.id);
  });
});
