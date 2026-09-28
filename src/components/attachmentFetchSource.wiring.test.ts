// ★ 丙-④（2026-09-26）：附件"**跟谁要哪份**"由 Rust 报，界面不许自己写死。
//
// 为什么用文本级判据：这条路的产物是"用户看到的那句话"，而它跨了两层
// （Rust 决定从服务器取还是从对端取 ⇒ 拼好 `note` ⇒ 界面原样显示）。这里钉住**接线**：
//   · 两个调用点都用 `res.note`（写死"已从服务器取回"就是**说假话**：网格那一档正是为
//     "不连服务器"准备的，而对端取回时那句话会明明白白地错）；
//   · 契约里那条命令回的是**读数**（`size` / `source` / `peer` / `note`），不是一个数字 ——
//     Web 侧的实现也必须同形（那边只有服务端一个来源，但形状不能少）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("附件按需取字节：来源由 Rust 说", () => {
  it("① 两个调用点都显示 Rust 拼的 `note`（不许写死「从服务器取回」）", () => {
    const disk = read("src/lib/attachmentBytes.ts");
    const files = read("src/components/FileManagerView.tsx");
    expect(disk, "打开文件那条路没有用 Rust 的 note").toContain("toast(res.note");
    expect(files, "文件管理器那条路没有用 Rust 的 note").toContain("toast(res.note");
    for (const [name, src] of [
      ["attachmentBytes.ts", disk],
      ["FileManagerView.tsx", files],
    ] as const) {
      expect(src, `${name} 里还写死了「从服务器取回」 ⇒ 从对端取回时会说谎`).not.toContain("已从服务器取回");
      expect(src, `${name} 里还写死了「已下载「`).not.toContain("已下载「");
    }
  });

  it("② 契约里那条命令回的是读数（size / source / peer / note 四件都要）", () => {
    const cmds = read("src/lib/platform/commands.ts");
    const at = cmds.indexOf("download_attachment:");
    expect(at, "找不到 download_attachment 的契约条目").toBeGreaterThan(-1);
    const entry = cmds.slice(at, at + 700);
    for (const field of ["size: number;", 'source: "server" | "peer";', "peer: string | null;", "note: string;"]) {
      expect(entry, `契约少了 ${field}`).toContain(field);
    }
  });

  it("③ Web 侧同形（那边只有服务端一个来源，但四个字段一个都不能少）", () => {
    const web = read("src/lib/platform/web.ts");
    const at = web.indexOf('if (cmd === "download_attachment")');
    expect(at, "找不到 Web 的实现").toBeGreaterThan(-1);
    const block = web.slice(at, at + 1400);
    expect(block, "Web 侧还是回一个数字 ⇒ 界面会显示成 undefined").toContain("note:");
    expect(block, "Web 侧没有说清 source").toContain('source: "server"');
    expect(block, "Web 侧没有 peer（那边恒为 null）").toContain("peer: null");
  });
});
