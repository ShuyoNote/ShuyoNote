// 判据：设置中心那颗「导出完整备份（全库）」**默认文件名**的口径。
//
// 来由（owner 2026-10-19 真机）：「全库备份的名称不对吧：`shuyonote-数友标尺-2026-10-19-02-50-26.zip`？
// （怎么带上了空间名称？）」——`export_backup` 导的是**整机全库**（`meta.db` ＋ **所有**空间库 ＋ 附件），
// 而旧实现拿**当前活动空间名**拼文件名 ⇒ 名字说"数友标尺"，内容却是全部 ⇒ 误导 ✓。
// 另附一条：旧实现的时间戳来自 `toISOString()`（**UTC**）⇒ 北京时间 10:50 会被写成 `02-50` ✗。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "BackupButton.tsx"), "utf8");
/** 去掉注释再扫（注释里会逐字引用旧名字，那不算用户可见文案）。 */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("全库备份的默认文件名", () => {
  it("① 不许带空间名（那是「只备份了一个空间」的误导）", () => {
    const c = code(SRC);
    expect(c, "文件名里不许有 <空间名> 那一格").not.toMatch(/shuyonote-\$\{[^}]*safe/);
    expect(c, "⛔ 别为了拼名字去读当前空间名").not.toContain("getWorkspaceName");
    expect(c, "名字必须是中性的 `shuyonote-backup-<时刻>.zip`").toContain("`shuyonote-backup-${stamp}.zip`");
  });

  it("② 时刻用**本地时间**（旧实现 `toISOString()` 是 UTC ⇒ 差 8 小时）", () => {
    const c = code(SRC);
    expect(c, "⛔ 不许再用 toISOString 拼文件名").not.toContain("toISOString");
    for (const f of ["getFullYear", "getMonth", "getDate", "getHours", "getMinutes", "getSeconds"]) {
      expect(c, `本地时刻要取 ${f}`).toContain(f);
    }
  });

  it("③ 备份内容仍是**全库**（这一条不许因为改名被顺手改掉）", () => {
    expect(code(SRC), "命令还是那条 `exportBackup`").toContain("api.exportBackup(path)");
    expect(code(SRC), "界面上仍写「全库」").toContain("导出完整备份（全库）");
  });
});
