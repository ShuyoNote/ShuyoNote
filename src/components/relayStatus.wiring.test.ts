// 中继那一格（图⑤／图⑧）· **面板接线**的判据。
//
// 为什么用文本级判据（与 `syncPanelMesh.wiring.test.ts` 同一手法）：这一片的价值全在
// "**用户看得到、且那两句话真的来自后端**"上，而"看得到"在 Node 里跑不出来（要真 Chromium ＋
// 真 Rust 内核）。所以这里钉**结构**：面板挂载、两格读数的来源、契约/Web/api 三处齐全、
// 用户面零输入、以及"到期只收回跨网"这条口径在模块层面的形状。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("中继那一格 · 面板接线", () => {
  const panel = read("src/components/SyncPanel.tsx");
  const section = read("src/components/RelayStatusSection.tsx");
  const commandsTs = read("src/lib/platform/commands.ts");
  const webTs = read("src/lib/platform/web.ts");
  const apiTs = read("src/lib/api.ts");
  const rust = read("src-tauri/src/relay_client.rs");

  it("① 面板真的挂上了中继那一格（旧行为：面板里一个字都没有 ⇒ 这条必红）", () => {
    expect(panel, "面板没挂中继那一格 ⇒ 用户在哪儿都看不到「中继 ／ 剩余 N 天」").toContain(
      "<RelayStatusSection",
    );
    expect(panel, "没把它 import 进来").toMatch(/from "\.\/RelayStatusSection"/);
  });

  it("② 两格读数都来自后端（界面不自己算天数、不自己拼句子）", () => {
    expect(section, "没读后端那份读数").toContain("api.relayStatus(");
    expect(section, "没有「重新检查」那条路 ⇒ 连没连上没法刷新").toContain("api.relayProbe(");
    expect(section, "没经那一处映射（会有人顺手在这里自己拼句子）").toContain("relayStatusView(");
    expect(section, "界面自己算天数了（86400 这类算术不该出现在这一层）").not.toMatch(/86400|86_400|Math\.floor/);
    // 后端**真的**出了那句人话（两格各一句）—— 界面只是摆上去。
    expect(rust, "后端没出「已连上中继」").toContain("已连上中继");
    expect(rust, "后端没出「未连上中继」").toContain("未连上中继");
    expect(rust, "后端没出「剩余 N 天」那句").toMatch(/剩余 \{[^}]*\} 天/);
    expect(rust, "后端没出「读不到有效期」那句").toContain("读不到有效期");
  });

  it("③ 契约 ／ api ／ Web 三处都带这两条命令（少一处 ⇒ 运行时 command not found 或 undefined）", () => {
    expect(commandsTs, "契约层缺 relay_status").toContain("relay_status:");
    expect(commandsTs, "契约层缺 relay_probe").toContain("relay_probe:");
    expect(apiTs, "api 层没包 relay_status").toContain('invoke("relay_status")');
    expect(apiTs, "api 层没包 relay_probe").toContain('invoke("relay_probe")');
    expect(webTs, "Web 执行器缺 relay_status").toContain('if (cmd === "relay_status")');
    expect(webTs, "Web 执行器缺 relay_probe").toContain('if (cmd === "relay_probe")');
    // Web 侧必须**如实说不可用**（⛔ 不许假装连上了 ✗）；形状与 Rust 侧逐字段相同。
    expect(webTs, "Web 侧没如实说这一档不可用").toMatch(/中继[^\n]{0,60}不可用/);
    expect(webTs, "Web 侧没走 available:false 那条路").toContain("available: false");
  });

  it("④ 用户面零输入、零「码」：中继这一格不许出现码 ／ 暗号 ／ 口令 ／ 密码", () => {
    // 去掉行注释：注释里讲"以前有过暗号"的历史**不算**用户可见文案。
    const copy = section.replace(/\/\/[^\n]*/g, "");
    for (const bad of ["比对码", "配对暗号", "投放码", "口令", "密码", "邀请"]) {
      expect(copy, `中继这一格不该出现「${bad}」（去码化 ＋ 零输入口径）`).not.toContain(bad);
    }
    expect(copy, "中继这一格不该要用户输入任何东西").not.toContain("<input");
  });

  it("⑤ 到期只收回跨网：中继模块只读配置，⛔ 不碰库 ／ 正文 ／ 加密", () => {
    // 唯一允许碰的仓内设施是"拿 app data 目录"那个只读路径助手 —— 别的一律不许出现。
    const refs = [...rust.matchAll(/crate::[A-Za-z_:]+/g)].map((m) => m[0]);
    expect(
      [...new Set(refs)],
      "中继模块碰了不该碰的仓内设施（到期只收回跨网 ⇒ 本地数据/功能一个字节都不许动）",
    ).toEqual(["crate::db::app_data_dir_ref"]);
    // 而且它**只读**：没有写库/落盘/加解密那一类动词。
    expect(rust, "中继模块出现了写库/删除的动作").not.toMatch(/Connection::open|\.execute\(|INSERT INTO|DELETE FROM/);
  });
});
