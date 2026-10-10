// **判据（task-19 ④）：自动备份那一格** —— ⚠️ 本文件**先写**（当时 `BackupSettingsPanel.tsx` 还不存在 ⇒
// 它**必红** ✓，红读数逐字见提交信息 ✓）。
//
// 四条（＋两条接线/漂移守卫）：
//   a) ⭐ 有后端读数 ⇒ **如实显示**（上次成功备份的时刻 ＋ 份数 ＋ 大小）✓
//   b) ⭐ **反向**：读数取不到 ⇒ ⭐ **如实说"读不到"** ✗（⛔ 不许显示 0 份／0 B ✗）
//   c) ⭐ **反向**：后端**没有**开关能力 ⇒ ⭐ 界面**不许出现开关** ✗（挡"画一个假的" ✓）
//   d) ⭐ **回归闸**：手动导出/导入那两条**仍然可用** ✓（⭐ `BackupButton.tsx` 一个字不改 ✓）
//   e) ⭐ **漂移守卫**：保留策略／间隔**照后端常量说**（⛔ 不许自己写一个数 ✗）—— 直接读 `.rs` 比对 ✓
//   f) ⭐ **接线收据**：面板挂在 `BackupButton` 的**有 `label` 那一支**（＝设置中心「数据」页 ✓），
//      ⛔ 无 `label`（侧栏那支）不许渲染它 ✓
//
// 一条命令：`npx vitest run src/components/BackupSettingsPanel.test.ts --reporter=verbose`

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BACKUP_RETENTION,
  backupFactsLines,
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
    // ⭐ 而新那一格必须**复用**这些既有实现，⛔ 不许写第二份备份逻辑 ✗
    const panel = read("src", "components", "BackupSettingsPanel.tsx");
    expect(panel, "面板应当复用 <BackupButton />（而不是自己再写一遍导出/导入）").toMatch(/<BackupButton\b/);
    expect(panel, "面板里不许自己调 export_backup/import_backup（那会变成第二份实现）").not.toMatch(
      /exportBackup\(|importBackup\(/,
    );
    // ⭐⭐ **嵌套守卫**：`BackupButton` 在有 `label` 时会挂本面板 ⇒ 面板里那个 `<BackupButton>` **不许带 label**
    //     （带了就是**无限自我嵌套** ✗ —— 这条判据是第一版实现当场会踩的坑 ✓）
    expect(panel, "面板里的 <BackupButton> 带了 label ⇒ 会无限自我嵌套 ✗").not.toMatch(
      /<BackupButton\s+label=/,
    );
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

  it("f) ⭐ 接线收据：面板只挂在 `label` 那一支（设置中心「数据」页 ✓），侧栏那支不挂", () => {
    const btn = read("src", "components", "BackupButton.tsx");
    expect(btn, "BackupButton 里没有 import BackupSettingsPanel").toMatch(
      /import\s*\{\s*BackupSettingsPanel\s*\}\s*from\s*"\.\/BackupSettingsPanel"/,
    );
    expect(btn, "没有把面板挂在 label 那一支上").toMatch(/\{\s*label\s*&&\s*<BackupSettingsPanel\b/);
  });
});
