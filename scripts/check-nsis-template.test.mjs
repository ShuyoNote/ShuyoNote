// check-nsis-template 的判据自测：每条断言都"改坏那一处就变红"（变异测试）。
// 这里不碰真实文件系统 —— `inspect()` 是纯函数，喂进构造好的输入即可。
import { describe, expect, it } from "vitest";

import {
  SENTINEL,
  UPSTREAM_LINE,
  WANTED_LINE,
  inspect,
  inspectFileAssociations,
  parseMeta,
  stripNsisComments,
  upstreamPart,
} from "./check-nsis-template.mjs";

const HEADER = [
  "; upstream-repo: tauri-apps/tauri",
  "; upstream-crate: tauri-bundler 2.9.4",
  `; upstream-path: src/bundle/windows/nsis/installer.nsi`,
  "; upstream-sha256: deadbeef",
  "; cli-version: 2.11.4",
  "; ============================================================================",
  SENTINEL,
  "",
].join("\n");

// 上游模板的骨架：除了"那一行"，还包括**文件关联要用到的两处 include 与两个 hook 调用**
// （真实上游模板里它们本来就在 52 / 59-60 / 758 / 911 行）。加在这里是为了让
// "我们的 fork 与上游只差那一行"这条（`ourBody` 与 `want` 逐字节相等）继续成立。
const upstreamBody = [
  "Unicode true",
  "ManifestDPIAware true",
  '!include "FileAssociation.nsh"',
  "Section",
  UPSTREAM_LINE,
  "  Call RestorePreviousInstallLocation",
  "SectionEnd",
  '!include "{{installer_hooks}}"',
  "!ifmacrodef NSIS_HOOK_POSTINSTALL",
  "  !insertmacro NSIS_HOOK_POSTINSTALL",
  "!endif",
  "!ifmacrodef NSIS_HOOK_POSTUNINSTALL",
  "  !insertmacro NSIS_HOOK_POSTUNINSTALL",
  "!endif",
  "",
].join("\n");

const ourBody = upstreamBody.replace(UPSTREAM_LINE, WANTED_LINE);

// installerHooks 指的 .nsh 的夹具：登记 4 个扩展名、只写 OpenWithProgids、卸载清干净。
// ⚠️ 第 2 行是**注释里**故意写出那条"抢默认"的语句 —— 用来证明判据**先剥注释**再匹配
//    （否则"讲解红线"本身会被判成"违规"）。
const HOOKS = [
  "; 夹具：登记 4 个扩展名，只写 OpenWithProgids",
  '; WriteRegStr SHCTX "Software\\Classes\\.${EXT}" "" "${PROGID}"',
  "!macro SHUYONOTE_OPENWITH_REGISTER EXT PROGID DESC",
  '  WriteRegStr SHCTX "Software\\Classes\\${PROGID}" "" "${DESC}"',
  '  WriteRegStr SHCTX "Software\\Classes\\.${EXT}\\OpenWithProgids" "${PROGID}" ""',
  '  WriteRegStr SHCTX "Software\\Classes\\${PROGID}\\shell\\open\\command" "" "$INSTDIR\\ShuyoNote.exe --import $\\"%1$\\""',
  "!macroend",
  "!macro SHUYONOTE_OPENWITH_UNREGISTER EXT PROGID",
  '  DeleteRegValue SHCTX "Software\\Classes\\.${EXT}\\OpenWithProgids" "${PROGID}"',
  '  DeleteRegKey /ifempty SHCTX "Software\\Classes\\.${EXT}\\OpenWithProgids"',
  '  DeleteRegKey SHCTX "Software\\Classes\\${PROGID}"',
  "!macroend",
  "!macro NSIS_HOOK_POSTINSTALL",
  '  !insertmacro SHUYONOTE_OPENWITH_REGISTER "docx" "ShuyoNote.docx" "Word 文档"',
  '  !insertmacro SHUYONOTE_OPENWITH_REGISTER "xlsx" "ShuyoNote.xlsx" "Excel 工作簿"',
  '  !insertmacro SHUYONOTE_OPENWITH_REGISTER "pptx" "ShuyoNote.pptx" "演示文稿"',
  '  !insertmacro SHUYONOTE_OPENWITH_REGISTER "md" "ShuyoNote.md" "Markdown"',
  "  !insertmacro UPDATEFILEASSOC",
  "!macroend",
  "!macro NSIS_HOOK_POSTUNINSTALL",
  '  !insertmacro SHUYONOTE_OPENWITH_UNREGISTER "docx" "ShuyoNote.docx"',
  '  !insertmacro SHUYONOTE_OPENWITH_UNREGISTER "xlsx" "ShuyoNote.xlsx"',
  '  !insertmacro SHUYONOTE_OPENWITH_UNREGISTER "pptx" "ShuyoNote.pptx"',
  '  !insertmacro SHUYONOTE_OPENWITH_UNREGISTER "md" "ShuyoNote.md"',
  "  !insertmacro UPDATEFILEASSOC",
  "!macroend",
].join("\n");

/** 夹具里"合法的 nsis 配置"（文件关联那一半正常）。 */
const goodNsis = {
  template: "nsis/installer.nsi",
  installerHooks: "nsis/file-assoc-hooks.nsh",
};

const base = {
  conf: { bundle: { windows: { nsis: goodNsis } } },
  templateText: HEADER + ourBody,
  cliVersion: "2.11.4",
  upstreamText: upstreamBody,
  upstreamFetched: true,
  hooksText: HOOKS,
};

const joined = (problems) => problems.join("\n");

describe("check-nsis-template", () => {
  it("正常情况：零问题", () => {
    expect(inspect(base)).toEqual([]);
  });

  it("变异 1：没配 template → 报红（默认目录会退回 AppData）", () => {
    const problems = inspect({ ...base, conf: { bundle: { windows: { nsis: {} } } } });
    expect(problems.join()).toContain("没配");
  });

  it("变异 2：模板文件不存在 → 报红", () => {
    const problems = inspect({ ...base, templateText: null });
    expect(problems.join()).toContain("模板文件不存在");
  });

  it("变异 3：那一行改回去了（旧写法残留）→ 报红", () => {
    const problems = inspect({ ...base, templateText: HEADER + upstreamBody });
    expect(problems.join()).toContain("还留着上游的旧默认目录");
    expect(problems.join()).toContain("出现 0 次");
  });

  it("变异 4：把那行写成 Programs 之外的目录 → 报红", () => {
    const wrong = ourBody.replace(WANTED_LINE, '  StrCpy $INSTDIR "$LOCALAPPDATA\\ShuyoNote2"');
    const problems = inspect({ ...base, templateText: HEADER + wrong });
    expect(problems.join()).toContain("出现 0 次");
  });

  it("变异 5：CLI 升级了但模板没重做 → 报红", () => {
    const problems = inspect({ ...base, cliVersion: "2.12.0" });
    expect(problems.join()).toContain("Tauri CLI 升级了");
  });

  it("变异 6：重做 fork 时多改了一行 → 报红（联网比对才查得出）", () => {
    const extra = ourBody.replace("Unicode true", "Unicode tru3");
    const problems = inspect({ ...base, templateText: HEADER + extra });
    expect(problems.join()).toContain("差异不止那一行");
  });

  it("变异 7：哨兵行被删 → 报红（无法定位上游原文）", () => {
    const problems = inspect({ ...base, templateText: ourBody });
    expect(problems.join()).toContain("找不到哨兵行");
  });

  it("变异 8：没联网时不该因为缺上游而失败", () => {
    expect(inspect({ ...base, upstreamText: null, upstreamFetched: false })).toEqual([]);
  });

  it("上游结构变了（找不到那一行）→ 报红", () => {
    const problems = inspect({
      ...base,
      upstreamText: "Unicode true\nSection\nSectionEnd\n",
    });
    expect(problems.join()).toContain("上游结构变了");
  });

  it("parseMeta 只认这几个键、且值里可以有空格（`tauri-bundler 2.9.4`）", () => {
    const meta = parseMeta(
      "; upstream-crate: tauri-bundler 2.9.4\nUnicode true\n; 说明文字\n; cli-version: 2.11.4\n; https://example.com/x\n",
    );
    expect(meta["upstream-crate"]).toBe("tauri-bundler 2.9.4");
    expect(meta["cli-version"]).toBe("2.11.4");
    // 正文里那种 `; https://…` 注释不许被当成键
    expect(Object.keys(meta).sort()).toEqual(["cli-version", "upstream-crate"]);
  });

  it("upstreamPart 返回哨兵之后的原文", () => {
    expect(upstreamPart(HEADER + ourBody)).toBe(ourBody);
  });
});

// ---------------------------------------------------------------------------
// 文件关联那一半（判据 a/b/c/d）—— 每条都"改坏一处就变红"
// ---------------------------------------------------------------------------
describe("check-nsis-template · 文件关联", () => {
  it("判据 a：没配 installerHooks → 报红（双击 .docx 不会唤起）", () => {
    const problems = inspect({
      ...base,
      conf: { bundle: { windows: { nsis: { template: "nsis/installer.nsi" } } } },
    });
    expect(joined(problems)).toContain("没配");
  });

  it("判据 a：installerHooks 指的文件不存在 → 报红", () => {
    expect(joined(inspect({ ...base, hooksText: null }))).toContain("指的文件不存在");
  });

  it("判据 a：少登记一个扩展名（.md）→ 报红", () => {
    const noMd = HOOKS.split("\n")
      .filter((l) => !l.includes('SHUYONOTE_OPENWITH_REGISTER "md"'))
      .join("\n");
    expect(joined(inspect({ ...base, hooksText: noMd }))).toContain("没有登记 .md");
  });

  it("判据 a：用了 OpenWithProgids 之外的形态（没有它）→ 报红", () => {
    const noOpenWith = HOOKS.split("\n")
      .filter((l) => !l.includes("OpenWithProgids"))
      .join("\n");
    const problems = joined(inspect({ ...base, hooksText: noOpenWith }));
    expect(problems).toContain("没有 `OpenWithProgids`");
  });

  it("判据 a：打开命令里没有 --import → 报红", () => {
    const noImport = HOOKS.replace("--import", "--oops");
    expect(joined(inspect({ ...base, hooksText: noImport }))).toContain("--import");
  });

  it("判据 b（反向）：出现 `bundle.fileAssociations` → 报红（它在 Windows 上会抢默认）", () => {
    const problems = inspect({
      ...base,
      conf: {
        bundle: {
          fileAssociations: [{ ext: ["docx"], name: "Word 文档" }],
          windows: { nsis: goodNsis },
        },
      },
    });
    expect(joined(problems)).toContain("bundle.fileAssociations");
  });

  it("判据 b（反向）：.nsh 里真的写了 `.ext` 的默认值 → 报红", () => {
    const realWrite = HOOKS.replace(
      '  WriteRegStr SHCTX "Software\\Classes\\${PROGID}" "" "${DESC}"',
      '  WriteRegStr SHCTX "Software\\Classes\\${PROGID}" "" "${DESC}"\n' +
        '  WriteRegStr SHCTX "Software\\Classes\\.${EXT}" "" "${PROGID}"',
    );
    expect(joined(inspect({ ...base, hooksText: realWrite }))).toContain("抢默认");
  });

  it("判据 b：**注释里**那条语句不算违规（先剥注释再匹配）", () => {
    // 夹具 HOOKS 第 2 行本身就是注释形态的那条语句 ⇒ 对照组必须零问题
    expect(inspect(base)).toEqual([]);
    // 而剥注释函数确实把它剥掉了
    expect(stripNsisComments(HOOKS)).not.toContain('"Software\\Classes\\.${EXT}" ""');
  });

  it("判据 c：卸载段少清一个扩展名 → 报红（留孤儿关联）", () => {
    const noUnregMd = HOOKS.split("\n")
      .filter((l) => !l.includes('SHUYONOTE_OPENWITH_UNREGISTER "md"'))
      .join("\n");
    expect(joined(inspect({ ...base, hooksText: noUnregMd }))).toContain("卸载段没有清理 .md");
  });

  it("判据 c：整段没有 POSTUNINSTALL → 报红", () => {
    const noHook = HOOKS.replace("!macro NSIS_HOOK_POSTUNINSTALL", "!macro SOMETHING_ELSE");
    expect(joined(inspect({ ...base, hooksText: noHook }))).toContain("没有 `NSIS_HOOK_POSTUNINSTALL`");
  });

  it("判据 c（反向）：反登记去删 `.ext` 本身 → 报红（会破坏别人的关联）", () => {
    const delExt = HOOKS.replace(
      '  DeleteRegKey /ifempty SHCTX "Software\\Classes\\.${EXT}\\OpenWithProgids"',
      '  DeleteRegKey /ifempty SHCTX "Software\\Classes\\.${EXT}\\OpenWithProgids"\n' +
        '  DeleteRegKey SHCTX "Software\\Classes\\.${EXT}"',
    );
    expect(joined(inspect({ ...base, hooksText: delExt }))).toContain("破坏**别人的**关联");
  });

  it("判据 c：反登记没用 /ifempty 清空键 → 报红", () => {
    const noIfEmpty = HOOKS.replace("DeleteRegKey /ifempty SHCTX", "DeleteRegKey SHCTX");
    // 去掉 /ifempty 后，"清空键必须 /ifempty"那条判据就认不出来了
    expect(joined(inspect({ ...base, hooksText: noIfEmpty }))).toContain("必须**用 `DeleteRegKey /ifempty`");
  });

  it("判据 d：hook 名写错（模板 !ifmacrodef ⇒ 静默不插入）→ 报红", () => {
    const badHook = HOOKS.replace("!macro NSIS_HOOK_POSTINSTALL", "!macro NSIS_HOOK_POSTINSTALLX");
    expect(joined(inspect({ ...base, hooksText: badHook }))).toContain("不是 Tauri 支持的名字");
  });

  it("判据 d：模板里没有 !insertmacro 那个 hook → 报红（它永远不会跑）", () => {
    const tpl = (HEADER + ourBody).replace("  !insertmacro NSIS_HOOK_POSTINSTALL\n", "");
    expect(joined(inspect({ ...base, templateText: tpl }))).toContain("永远不会跑");
  });

  it("判据 d：模板把 FileAssociation.nsh 的 include 排到 installerHooks 之后 → 报红", () => {
    const swapped = ourBody
      .replace('!include "FileAssociation.nsh"\n', "")
      .replace('!include "{{installer_hooks}}"', '!include "{{installer_hooks}}"\n!include "FileAssociation.nsh"');
    const problems = inspectFileAssociations({
      conf: base.conf,
      hooksText: HOOKS,
      templateText: swapped,
    });
    expect(joined(problems)).toContain("它还没定义");
  });

  it("判据 d：.nsh 里一个 hook 都没定义 → 报红", () => {
    const noHooks = HOOKS.replace(/!macro NSIS_HOOK_[A-Z_]+/g, "!macro NOT_A_HOOK");
    expect(joined(inspect({ ...base, hooksText: noHooks }))).toContain("什么都不会发生");
  });
});
