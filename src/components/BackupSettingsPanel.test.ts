// **判据（task-19 ④）：自动备份那一格** —— ⚠️ 本文件**先写**（当时 `BackupSettingsPanel.tsx` 还不存在 ⇒
// 它**必红** ✓，红读数逐字见提交信息 ✓）。
//
// 四条（＋两条接线/漂移守卫）：
//   a) ⭐ 有后端读数 ⇒ **如实显示**（上次成功备份的时刻 ＋ 份数 ＋ 大小）✓
//   b) ⭐ **反向**：读数取不到 ⇒ ⭐ **如实说"读不到"** ✗（⛔ 不许显示 0 份／0 B ✗）
//   c) ⭐ **反向**：后端**没有**开关能力 ⇒ ⭐ 界面**不许出现开关** ✗（挡"画一个假的" ✓）
//   d) ⭐ **回归闸 ＋ 去重守卫**：手动导出/导入**仍然可用** ✓（`BackupButton.tsx` 一个字不改 ✓）；
//      ⭐ 且**唯一入口在页面上**（`SettingsDialog` 的 `<BackupButton label=… />` ✓）——
//      ⛔ 面板里**不许**再放第二个入口 ✗（2026-10-11 owner 截图问出来的重复 ✓）
//   e) ⭐ **漂移守卫**：保留策略／间隔**照后端常量说**（⛔ 不许自己写一个数 ✗）—— 直接读 `.rs` 比对 ✓
//   f) ⭐ **接线收据**：面板由**页面**挂、位置在**行外** ✓（⛔ 不许塞回 `BackupButton` 的 `.backup-menu` 里 ✗ ——
//      那个形状 2026-10-11 实测把同一行挤成「一个字一列」✗，见那条判据里的读数和来由 ✓）
//
// 一条命令：`npx vitest run src/components/BackupSettingsPanel.test.ts --reporter=verbose`

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AUTO_BACKUP_RUN_COMMAND,
  AUTO_BACKUP_STATUS_COMMAND,
  BACKUP_RETENTION,
  backupFactsLines,
  factsFromStatus,
  type BackupFacts,
} from "./BackupSettingsPanel";

const ROOT = process.cwd();
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf8");

/** 造一份"后端确实给了读数"的事实（⭐ 数字都是我编的**输入**，显示必須原样出现 ✓）。 */
const WITH_READINGS: BackupFacts = {
  lastSuccessUnix: 1_760_000_000, // 2025-10-09T08:53:20Z
  count: 3,
  bytes: 3 * 1024 * 1024,
  dir: "C:\\Users\\me\\AppData\\Roaming\\cn.shuyo.shuyonote\\backups",
  unreadableReason: null,
};

describe("自动备份那一格（task-19）", () => {
  it("a) ⭐ 有后端读数 ⇒ 如实显示上次成功备份时刻 ＋ 份数 ＋ 大小（旧行为下必红 ✓）", () => {
    const text = backupFactsLines(WITH_READINGS).join("\n");
    // 时刻必须**真的格式化出来**（不是占位符 ✓）—— 断言年月日与"3 份"在 ✓
    expect(text, "没有显示上次成功备份的时刻").toMatch(/2025-10-09/);
    expect(text, "没有显示份数").toMatch(/3\s*份/);
    expect(text, "没有显示总大小").toMatch(/3\.0\s*MB|3072\s*KB/i);
    expect(text, "有读数时不该出现「读不到」").not.toContain("读不到");
  });

  it("b) ⭐ 反向：读数取不到 ⇒ **如实说「读不到」**，⛔ 不许显示 0 份／0 B", () => {
    for (const facts of [null, { ...WITH_READINGS, lastSuccessUnix: null, count: null, bytes: null, unreadableReason: "后端还没有开放这条读数" } as BackupFacts]) {
      const text = backupFactsLines(facts).join("\n");
      expect(text, "读数取不到时必须如实说「读不到」").toContain("读不到");
      expect(text, "⛔ 不许把「取不到」显示成 0 份").not.toMatch(/0\s*份/);
      expect(text, "⛔ 不许把「取不到」显示成 0 B").not.toMatch(/0(\.0)?\s*(B|KB|MB)\b/);
    }
  });

  it("c) ⭐ 反向：后端**没有**开关能力 ⇒ 界面**不许出现开关**（⛔ 不画假的）", () => {
    // ① 渲染出来的文字里不许出现"可开关"的措辞
    const text = backupFactsLines(WITH_READINGS).join("\n");
    for (const word of ["启用", "关闭自动", "打开自动", "开关"]) {
      expect(text, `面板不该说「${word}」——后端没有这个能力`).not.toContain(word);
    }
    // ② 组件源码里不许有开关控件
    const panel = read("src", "components", "BackupSettingsPanel.tsx");
    expect(panel, "面板里出现了 checkbox/switch/toggle ⇒ 那只可能是假开关").not.toMatch(
      /type="checkbox"|role="switch"|<Switch|toggle/i,
    );
    // ③ ⭐ 方向说明：这条同时是**漂移守卫** —— 若后端将来真的加了开关，
    //    它会红（因为 Rust 侧出现了 enable/disable 符号）⇒ 提醒把界面补上 ✓（图上有/代码没有，两边都挡 ✓）
    const rust = read("src-tauri", "src", "auto_backup.rs") + read("src-tauri", "src", "lib.rs");
    expect(
      /set_auto_backup_enabled|auto_backup_enabled|set_enabled\(\s*\)/.test(rust),
      "后端**新增了**开关能力 ⇒ 该把界面上的开关补上（本判据故意红，别静默删它）",
    ).toBe(false);
  });

  it("d) ⭐ 回归闸：手动导出/导入**仍然可用**（`BackupButton.tsx` 的既有行为没被动过）", () => {
    const btn = read("src", "components", "BackupButton.tsx");
    expect(btn, "手动导出那条路被改掉了").toContain("api.exportBackup(");
    expect(btn, "手动导入那条路被改掉了").toContain("api.importBackup(");
    expect(btn, "导出菜单项没了").toContain("导出完整备份");
    expect(btn, "导入菜单项没了").toContain("导入备份");
    // ⭐⭐ **2026-10-11（owner 截图问「这两部分是不是重复了？」）**：⭐ **是重复的** ✗ ——
    //    面板里原来又渲染了一颗**光秃秃的** `<BackupButton />`（不带 label ✓）⇒ 它与 `SettingsDialog`
    //    那一行的「备份 / 恢复…」是**同一个组件、同一个动作** ✓ ⇒ 两处入口 ✗ ⇒ 已删那一处 ✓。
    //    ⇒ ⭐ 这条判据**反过来钉**（原版要求"面板里**要**有 `<BackupButton>`"✗ —— 那会把重复**当成规格** ✓）：
    const panel = read("src", "components", "BackupSettingsPanel.tsx");
    // ⚠️⚠️ **先剥注释** ✗ —— 面板的注释里**引了**那行 JSX 来讲来由 ✓ ⇒ 不剥的话判据会被**自己的解释文字**
    //    绊倒 ✗（⭐ 今天第三次同形：能力页 / BackupButton / 这里 ✓）。判据要钉的是**代码**，⛔ 不是注释 ✓。
    const panelCode = panel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(panelCode, "⭐ 面板里不许再放第二个导出/导入入口 —— 那正是 owner 问出来的重复 ✗").not.toMatch(
      /<BackupButton\b/,
    );
    expect(panelCode, "面板里不许自己调 exportBackup/importBackup（那会变成第二份实现 ✗）").not.toMatch(
      /exportBackup\(|importBackup\(/,
    );
    // ⭐ 而**唯一的**入口必须在页面上、且**带文字**（⭐ 带 label 才看得懂 ✓）
    const page = read("src", "components", "SettingsDialog.tsx");
    expect(page, "页面里那个手动入口不见了 ⇒ 手动备份就没路可走了 ✗").toMatch(/<BackupButton\s+label=/);
  });

  it("e) ⭐ 漂移守卫：保留策略／间隔**照后端常量说**（⛔ 不许自己写一个数）", () => {
    const rust = read("src-tauri", "src", "auto_backup.rs");
    const num = (name: string): number => {
      const m = new RegExp(`pub const ${name}: u64 = ([0-9_ *]+);`).exec(rust);
      expect(m, `Rust 侧找不到 ${name} 常量`).toBeTruthy();
      // 允许 `24 * 60 * 60` 这种写法 ⇒ 直接算式求值（只含数字、空格、下划线、星号 ✓）
      const expr = m![1].replace(/_/g, "");
      expect(/^[0-9 *]+$/.test(expr), `${name} 的写法超出判据能算的范围：${m![1]}`).toBe(true);
      return expr.split("*").reduce((acc, part) => acc * Number(part.trim()), 1);
    };
    expect(BACKUP_RETENTION.keepDays, "KEEP_DAYS 与后端不一致").toBe(num("KEEP_DAYS"));
    expect(BACKUP_RETENTION.keepWeeks, "KEEP_WEEKS 与后端不一致").toBe(num("KEEP_WEEKS"));
    expect(BACKUP_RETENTION.keepMonths, "KEEP_MONTHS 与后端不一致").toBe(num("KEEP_MONTHS"));
    expect(BACKUP_RETENTION.intervalSecs, "DEFAULT_INTERVAL_SECS 与后端不一致").toBe(
      num("DEFAULT_INTERVAL_SECS"),
    );
    // ⭐ 渲染出来的话必须**如实**：是"启动触发"（不是"可以开/关"✓），且 24 小时这个数来自后端常量 ✓
    const text = backupFactsLines(WITH_READINGS).join("\n");
    expect(text, "面板没写清它是「启动触发」这件事").toMatch(/随应用启动|启动.*先跑一轮/);
    expect(text, "面板没写清间隔（应当来自 DEFAULT_INTERVAL_SECS）").toMatch(/24\s*小时/);
  });

  it("f) ⭐ 接线收据：面板由**页面在行外**挂（⛔ 不许塞回 `.backup-menu` 里 ✗）", () => {
    const btn = read("src", "components", "BackupButton.tsx");
    // ⚠️⭐ **2026-10-11 改**：原断言是「面板挂在 `BackupButton` 的**有 `label` 那一支**」✗ ——
    //    那个形状**本身就是 bug** ✗：`.backup-menu` 是 `.set-row` 的 flex 子项 ⇒ 整块面板把
    //    wrapper 的 max-content 撑到 **590px** ⇒ 同一行的 `.set-row-text` 宽**恰好 0** ⇒
    //    「备份 / 恢复（全库）」与说明**一个字一列** ✗（CDP 实测：0 ⇒ 修后 **487.5** ✓）。
    //    ⇒ ⭐ 收据跟着**新接线**走：面板由页面挂、位置在**行外** ✓。
    // ⚠️ 只钉**接线**（import ＋ JSX 用法），⛔ 不用 `not.toContain("BackupSettingsPanel")` ✗ ——
    //    那个太粗：文件里的**注释**会讲这段来由、名字必然出现 ⇒ 判据会被自己的解释文字绊倒 ✓（实测踩过一次）。
    expect(btn, "`BackupButton` 又 import 了面板 ⇒ 它会被塞回 `.backup-menu`（那一行又会被挤成 0 ✗）").not.toMatch(
      /import\s*\{\s*BackupSettingsPanel\s*\}/,
    );
    expect(btn, "`BackupButton` 又把面板渲染进去了 ⇒ 同上 ✗").not.toMatch(/<BackupSettingsPanel\b/);
    const page = read("src", "components", "SettingsDialog.tsx");
    expect(page, "页面里没挂 BackupSettingsPanel ⇒ 面板没地方显示了").toMatch(/<BackupSettingsPanel\s*\/>/);
    // ⭐ 位置收据：它必须在那个带 label 的 `<BackupButton …>` **之后**，且两者之间已经闭合了 `.set-row`
    const at = page.indexOf("<BackupSettingsPanel />");
    const btnAt = page.indexOf("<BackupButton label=");
    expect(btnAt, "页面里找不到那个带 label 的 `<BackupButton>`").toBeGreaterThan(-1);
    expect(at, "面板必须在 `<BackupButton>` **之后**").toBeGreaterThan(btnAt);
    expect(
      page.slice(btnAt, at),
      "面板与 `<BackupButton>` 之间没有闭合 `.set-row` ⇒ 它又成了「那一行的右控件」（会重演那个 bug ✗）",
    ).toContain("</div>");
  });

  // ⭐⭐ 下面四条是 **task-20** 加的（补两条后端命令 ⇒ 那格从"读不到"变成**真读数** ✓）

  it("g) ⭐ **只读命令**三处同名 ＋ 面板真的去取（旧行为：面板写死 `null` ⇒ 只能显示「读不到」⇒ 必红 ✓）", () => {
    // ① Rust 侧真有这条命令
    const backupRs = read("src-tauri", "src", "backup.rs");
    expect(backupRs, `Rust 侧没有 pub fn ${AUTO_BACKUP_STATUS_COMMAND}`).toMatch(
      new RegExp(`pub (async )?fn ${AUTO_BACKUP_STATUS_COMMAND}\\s*\\(`),
    );
    // ② lib.rs 登记了
    const lib = read("src-tauri", "src", "lib.rs");
    expect(lib, `lib.rs 的 generate_handler! 没登记 ${AUTO_BACKUP_STATUS_COMMAND}`).toMatch(
      new RegExp(`backup::${AUTO_BACKUP_STATUS_COMMAND}\\s*,`),
    );
    // ③ 面板真的去取（⛔ 不许写死 null ✗）
    const panel = read("src", "components", "BackupSettingsPanel.tsx");
    expect(panel, "面板没有去取那条只读读数（还是写死的 null）").toContain(AUTO_BACKUP_STATUS_COMMAND);
    expect(panel, "面板不该再把 facts 写死成 null").not.toMatch(/const facts: BackupFacts \| null = null/);
  });

  it("h) ⭐ **反向**：读数取不到 ⇒ 映射成「读不到」⇒ ⛔ 不许显示 0 份", () => {
    // 命令抛错（目录不可读／平台不支持）⇒ 必须**如实**（⛔ 不是 0 份 ✗）
    for (const facts of [
      factsFromStatus(null, "读目录失败：Permission denied"),
      factsFromStatus(
        {
          dir: "",
          count: 0,
          bytes: 0,
          lastSuccessUnix: null,
          snapshots: [],
          keepDays: 7,
          keepWeeks: 4,
          keepMonths: 12,
          unreadable: "读目录失败：Permission denied",
        },
        null,
      ),
    ]) {
      expect(facts.unreadableReason, "取不到时必须给出一句人话的原因").toBeTruthy();
      const text = backupFactsLines(facts).join("\n");
      expect(text).toContain("读不到");
      expect(text, "⛔ 取不到却显示 0 份").not.toMatch(/0\s*份/);
    }
    // ⭐ 而**真的 0 份**（目录不存在／里面确实没有有效快照）⇒ 那是**真读数**，照实显示 ✓
    const real = factsFromStatus(
      {
        dir: "C:\\tmp\\backups",
        count: 0,
        bytes: 0,
        lastSuccessUnix: null,
        snapshots: [],
        keepDays: 7,
        keepWeeks: 4,
        keepMonths: 12,
        unreadable: null,
      },
      null,
    );
    expect(real.unreadableReason, "目录在、只是没有快照 ⇒ 不该说读不到").toBeNull();
    expect(backupFactsLines(real).join("\n")).toMatch(/0\s*份/);
  });

  it("i) ⭐ **反向**：保留策略窗口**不许在界面里写第二遍**（必须来自后端那处 `retention_keep`）", () => {
    // ① 后端给的窗口**优先**（面板照它说 ✓）
    const fromBackend = factsFromStatus(
      {
        dir: "C:\\tmp\\backups",
        count: 1,
        bytes: 1024,
        lastSuccessUnix: 1_760_000_000,
        snapshots: [],
        keepDays: 99,
        keepWeeks: 88,
        keepMonths: 77,
        unreadable: null,
      },
      null,
    );
    const text = backupFactsLines(fromBackend).join("\n");
    expect(text, "面板没用后端给的窗口（还在用自己那份常量）").toMatch(/99\s*天/);
    expect(text).toMatch(/88\s*周/);
    expect(text).toMatch(/77\s*个?月/);
    // ② ⭐ Rust 那条命令的窗口必须**取自常量**（⛔ 不许写死数字 ✗）
    const backupRs = read("src-tauri", "src", "backup.rs");
    expect(backupRs, "后端那条读数没引用 KEEP_DAYS（窗口写死了？）").toMatch(/KEEP_DAYS/);
    expect(backupRs, "后端那条读数没引用 KEEP_WEEKS").toMatch(/KEEP_WEEKS/);
    expect(backupRs, "后端那条读数没引用 KEEP_MONTHS").toMatch(/KEEP_MONTHS/);
  });

  it("j) ⭐ **写命令**三处同名 ＋ 面板那个按钮真的调它（⛔ 不许写第二份备份逻辑）", () => {
    const backupRs = read("src-tauri", "src", "backup.rs");
    expect(backupRs, `Rust 侧没有 pub fn ${AUTO_BACKUP_RUN_COMMAND}`).toMatch(
      new RegExp(`pub (async )?fn ${AUTO_BACKUP_RUN_COMMAND}\\s*\\(`),
    );
    // ⭐ **复用**既有实现（⛔ 不重写备份逻辑 ✗）
    expect(backupRs, "写命令没有走既有的 run_auto_backup_once（难道重写了一份？）").toMatch(
      /run_auto_backup_once\s*\(/,
    );
    const lib = read("src-tauri", "src", "lib.rs");
    expect(lib, `lib.rs 没登记 ${AUTO_BACKUP_RUN_COMMAND}`).toMatch(
      new RegExp(`backup::${AUTO_BACKUP_RUN_COMMAND}\\s*,`),
    );
    const panel = read("src", "components", "BackupSettingsPanel.tsx");
    expect(panel, "面板里没有调那条写命令的按钮").toContain(AUTO_BACKUP_RUN_COMMAND);
    expect(panel, "那个按钮必须只调命令（⛔ 不许在这里自己写备份逻辑）").not.toMatch(
      /exportBackup\(|importBackup\(/,
    );
  });

  it("k) ⭐ 那条**反直觉**读数：界面必须说清『同一天只留最新一份 ⇒ 份数可能不变』", () => {
    // ⚠️ 来由（2026-10-10 实测）：真跑一次「立刻备份」之后，**同一天**的旧那份会被换掉 ⇒
    //    ⛔ 拿「份数 +1」当判据会**假红**（也会**假绿** ✓）⇒ 界面要指明"看的是**时刻**" ✓
    const panel = read("src", "components", "BackupSettingsPanel.tsx");
    expect(panel, "面板没说清『份数可能不变』⇒ 用户会以为按钮没生效").toContain("份数可能不变");
    expect(panel, "面板没指向那个会动的读数（上次成功备份的时刻）").toMatch(
      /上次成功备份[\s\S]{0,40}时刻|时刻[\s\S]{0,40}上次成功备份/,
    );
    // Rust 侧同族用例（⭐ 复用 `retention_keep`，⛔ 不写第二份保留逻辑 ✗）
    const rust = read("src-tauri", "src", "auto_backup.rs");
    expect(rust, "Rust 侧没有『同一天第二份只留最新』的用例").toMatch(
      /same_day_second_backup_moves_last_success_while_retention_keeps_one_per_day/,
    );
  });
});
