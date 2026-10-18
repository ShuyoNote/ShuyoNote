// 判据：订阅面板的**措辞与产品边界**（任务书 §0 ②、§1 C 的停卡文案）。
//
// 为什么用"纯函数 + 源码扫描"两层（与 `syncTag.test.ts` 同一手法）：
// 真渲染要浏览器组；而这两件事（文案口径 / 不出现企业版词）在源码层就能钉死。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { stateLine } from "../../components/LicenseSection";

const SRC = readFileSync(resolve(__dirname, "../../components/LicenseSection.tsx"), "utf8");

describe("五态的界面文案", () => {
  it("① 停卡那一档：必须写「已停卡 · 只停了跨网」，⛔ 不许写「已过期」", () => {
    const line = stateLine("stopped", 0);
    expect(line).toContain("已停卡");
    expect(line).toContain("只停了跨网");
    expect(line, "停卡 ≠ 过期，⛔ 不许写已过期").not.toContain("已过期");
  });

  it("② 其余四态各说各的状态（别都写成一句「不可用」）", () => {
    expect(stateLine("active", 9)).toContain("还剩 9 天");
    expect(stateLine("grace", 3)).toContain("宽限");
    expect(stateLine("expired", 0)).toContain("已过期");
    expect(stateLine("not-yet", 0)).toContain("还没到生效时间");
  });

  it("③ 任何一态都要说清「本机不受影响」（产品铁律：只停跨网）", () => {
    for (const s of ["expired", "stopped"] as const) {
      expect(stateLine(s, 0), `${s} 那一态要提到本机`).toMatch(/本机/);
    }
  });
});

describe("产品边界（源码扫描）", () => {
  it("① ⛔ 个人版界面不出现「组织」「团队」「席位」（那是企业版的词）", () => {
    // ⚠️ 扫描前**先剥注释**：本文件的说明里就会写"那是企业版的词（组织统一采购）"，
    //    不剥会把"说明"当成"违规"（今天已经踩过一次同形的假红：`check-im-boundary`）。
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    for (const word of ["组织", "团队", "席位"]) {
      expect(code.includes(word), `界面源码不该出现「${word}」`).toBe(false);
    }
  });

  it("② 没配发卡站时**只说话不给按钮**：那一档不出现可点的开通/续期", () => {
    // 口径：`issuer.ready` 为假时渲染的只有一句说明；按钮都在 `issuer?.ready` 分支里。
    const readyIdx = SRC.indexOf("issuer?.ready ?");
    expect(readyIdx, "动作区必须在 `issuer?.ready` 分支里").toBeGreaterThan(-1);
    const renewIdx = SRC.indexOf('data-testid="license-renew"');
    const noIssuerIdx = SRC.indexOf('data-testid="license-no-issuer"');
    expect(noIssuerIdx, "要有「没配发卡站」那句").toBeGreaterThan(-1);
    expect(noIssuerIdx, "那句要在按钮之前").toBeLessThan(renewIdx);
  });

  it("③ 开通给的是**说明**不是假按钮（`sub` 在规格 §12 是待定项）", () => {
    expect(SRC).toContain("待定项");
    // 全文件只许有一个 `<button`（续期那颗）
    expect((SRC.match(/<button/g) ?? []).length).toBe(1);
  });
});
