// 判据：订阅面板的**措辞、产品边界、以及"合并中继许可证"这件事**。
//
// 2026-10-19 重做（owner：「中继和跨网订阅不是一回事？」→ 拍 A ＋「美化这个面板」）：
//   · 许可证/有效期**只许出现在订阅这一节**（中继那节只讲连接）；
//   · 没配发卡站时**整块只有一行**（旧版把同一句话说了两遍）；
//   · 要有**真的**粘贴框（旧版文案让人"粘贴"，界面上却没有输入框）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { pasteErrorText, stateDetail, stateLine } from "../../components/LicenseSection";

const SRC = readFileSync(resolve(__dirname, "../../components/LicenseSection.tsx"), "utf8");
const RELAY = readFileSync(resolve(__dirname, "../../components/RelayStatusSection.tsx"), "utf8");
/** 去掉注释再扫（注释里会讲"旧版把词写错了"这类历史，不算用户可见文案）。 */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("五态的界面文案", () => {
  it("① 停卡那一档：必须写「已停卡 · 只停了跨网」，⛔ 不许写「已过期」", () => {
    const line = stateLine("stopped", 0, 0);
    expect(line).toContain("已停卡");
    expect(line).toContain("只停了跨网");
    expect(line, "停卡 ≠ 过期").not.toContain("已过期");
  });

  it("② 其余四态各说各的（⛔ 别都写成一句「不可用」）", () => {
    expect(stateLine("active", 9, 0)).toBe("还剩 9 天");
    expect(stateLine("grace", 0, 3)).toBe("宽限期还剩 3 天");
    expect(stateLine("expired", 0, 0)).toBe("已过期");
    expect(stateLine("not-yet", 0, 0)).toBe("还没到生效时间");
  });

  it("③ 下面那行解释必须带信息：过期/停卡都要说清「本机不受影响」", () => {
    for (const s of ["expired", "stopped"] as const) {
      expect(stateDetail(s), `${s} 那一态要提到本机`).toMatch(/本机/);
    }
    expect(stateDetail("grace")).toContain("宽限一过就停跨网");
    // ⛔ 停卡那句不许劝人去续期（续期解决不了停卡）
    expect(stateDetail("stopped")).not.toContain("续期");
  });
});

describe("粘贴许可证（旧版是：文案让人粘贴、界面却没有输入框）", () => {
  it("① 真有 textarea ＋ 保存按钮 ＋ 先过解析", () => {
    expect(code(SRC)).toContain("<textarea");
    expect(code(SRC)).toContain('data-testid="license-paste-save"');
    expect(code(SRC), "粘贴前要先过解析").toContain("parseCard(");
  });

  it("② 坏卡说人话：版本不符 ≠ 读不出来", () => {
    expect(pasteErrorText("VERSION")).toContain("升级客户端");
    expect(pasteErrorText("MALFORMED")).toContain("复制完整");
    expect(pasteErrorText("VERSION")).not.toBe(pasteErrorText("MALFORMED"));
  });
});

describe("合并（owner 拍 A）：许可证/有效期只出现在订阅这一节", () => {
  it("① 中继那一节**不再**渲染「中继许可证」那一行", () => {
    expect(code(RELAY)).not.toContain("中继许可证");
    expect(code(RELAY), "中继那节只回答连上没有").toContain("relay-connection");
  });

  it("② 订阅这一节接管了「我能用多久」（并保留中继侧读数的消费）", () => {
    expect(code(SRC)).toContain("license-state");
    expect(code(SRC), "中继侧读数只在有新信息时才说").toContain("license-relay-read");
  });
});

describe("产品边界（源码扫描）", () => {
  it("① ⛔ 个人版界面不出现「组织」「团队」「席位」", () => {
    for (const word of ["组织", "团队", "席位"]) {
      expect(code(SRC).includes(word), `界面源码不该出现「${word}」`).toBe(false);
    }
  });

  it("② 没配发卡站时**整块只有一行**（旧版同一句话说两遍 · 2026-10-19 修）", () => {
    const c = code(SRC);
    // 早返回区间：从 `!issuer.ready` 到 `const tone =`（后者是主渲染开始处）——
    // ⚠️ 别拿 `license-state` 当右界：那个 testid 在**主渲染**里，会把主渲染的头一行也截进来（本轮踩过）。
    const early = c.slice(c.indexOf("!issuer.ready"), c.indexOf("const tone ="));
    expect(early, "要有早返回").toContain("return (");
    // 一行 ＝ 一个 label 格；旧版是「还没有卡…」＋「没配发卡站…（没配发卡站…）」两行
    expect((early.match(/sync-row-label/g) ?? []).length, "这一档只许一行").toBe(1);
    expect(early, "用后端那句 why（⛔ 不自己再拼前缀）").toContain("issuer.why");
    expect(early, "⛔ 不再自己写一句「这一块已关闭。」").not.toContain("这一块已关闭。");
  });

  it("③ 开通仍是「说明」不是假按钮（`sub` 在规格 §12 是待定项）", () => {
    // 说明那句在**源码**里（注释被 `code()` 剥掉了 ⇒ 用原文查）
    expect(SRC, "开通的说明里有「还没定」").toContain("还没定");
    expect(SRC).toContain("license-open-note");
    // 三颗按钮：续期（条件渲染）＋ 粘贴开关 ＋ 粘贴框里的「校验并保存」
    expect((code(SRC).match(/<button/g) ?? []).length).toBe(3);
  });
});
