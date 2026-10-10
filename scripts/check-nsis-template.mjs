// NSIS 模板门禁：我们 **fork 了** Tauri 的安装器模板（只为改默认安装目录），这里钉住四件事。
//
// 为什么需要它：`bundle.windows.nsis` 没有"自定义默认安装目录"的配置项（只有 installMode），
// 默认目录写在模板文件里（上游 feature request：tauri-apps/tauri#11015）。fork 一份 847 行的
// 上游模板是**唯一**的办法，但它带来两个长期风险，都不吵不闹：
//   ① 模板被删 / 被改回去 / 路径写错 —— 打包时不一定报错，用户那端只是"又装到 AppData 里了"
//      （这次正是 owner 截图问"安装地址不专业啊？"才被翻出来的）；
//   ② **Tauri CLI 升级后上游模板变了**，我们的 fork 停在旧版本：轻则缺新特性，重则与 CLI
//      传入的占位符对不上、打出来的包装不上。CLI 版本一升就必须重做这个文件。
//
// 查四件事（前三条离线，第四条要联网）：
//   1. `bundle.windows.nsis.template` 指向的文件存在；
//   2. 模板里**恰好**有那一行改动（`$LOCALAPPDATA\Programs\${PRODUCTNAME}`），且旧写法不再残留；
//   3. 模板头部记录的 `cli-version` 与 package.json 里的 `@tauri-apps/cli` 一致；
//   4. （联网）下载同版本 tauri-bundler 的上游模板逐行比对，差异**只允许那一行**；
//      取不到就打印 `· 跳过（网络原因）`，**不算失败**（与 check-release-state 同一口径：
//      网络失败与"真的不符"要分开报）。
//
// 判据逻辑抽成 `inspect()` 便于单测（check-nsis-template.test.mjs）；每条断言都做过变异测试
// （改坏对应那一处 → 用例变红）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SENTINEL =
  "; ---- UPSTREAM STARTS BELOW (byte-identical except the one line documented above) ----";
export const WANTED_LINE = '  StrCpy $INSTDIR "$LOCALAPPDATA\\Programs\\${PRODUCTNAME}"';
export const UPSTREAM_LINE = '  StrCpy $INSTDIR "$LOCALAPPDATA\\${PRODUCTNAME}"';

/** 读模板头部的 `; key: value` 元信息（只认我们自己的这几个键，免得把正文里 `; https://…` 当成键）。 */
export const META_KEYS = new Set([
  "upstream-repo",
  "upstream-crate",
  "upstream-path",
  "upstream-sha256",
  "cli-version",
]);

export function parseMeta(text) {
  const meta = {};
  for (const line of text.split("\n")) {
    const m = /^;\s*([a-z-]+):\s*(.+?)\s*$/.exec(line.trim());
    if (m && META_KEYS.has(m[1])) meta[m[1]] = m[2];
  }
  return meta;
}

/** 模板里"上游原文"那一段（哨兵行之后全部）；找不到哨兵返回 null。 */
export function upstreamPart(text) {
  const i = text.indexOf(SENTINEL);
  if (i < 0) return null;
  return text.slice(i + SENTINEL.length).replace(/^\r?\n/, "");
}

/**
 * 纯逻辑：返回问题清单（空数组 = 通过）。
 * @param {{conf:any, templateText:string|null, cliVersion:string, upstreamText:string|null, upstreamFetched:boolean, hooksText?:string|null}} o
 *   `hooksText` = `bundle.windows.nsis.installerHooks` 指的那个 `.nsh` 的内容（文件关联那一半，见 `inspectFileAssociations`）。
 */
export function inspect({ conf, templateText, cliVersion, upstreamText, upstreamFetched, hooksText = null }) {
  const problems = [];
  const declared = conf?.bundle?.windows?.nsis?.template;

  if (typeof declared !== "string" || declared.length === 0) {
    problems.push(
      "`bundle.windows.nsis.template` 没配 —— 默认安装目录会退回 `%LOCALAPPDATA%\\ShuyoNote`",
    );
    return problems;
  }
  if (templateText === null) {
    problems.push(`模板文件不存在：${declared}（路径相对 src-tauri/）`);
    return problems;
  }

  const meta = parseMeta(templateText);
  const body = upstreamPart(templateText);
  if (body === null) {
    problems.push(`模板里找不到哨兵行，无法判断"上游原文"从哪开始：${SENTINEL}`);
    return problems;
  }

  const wantCount = body.split(WANTED_LINE).length - 1;
  if (wantCount !== 1) {
    problems.push(`那一行改动出现 ${wantCount} 次（应为恰好 1 次）：${WANTED_LINE.trim()}`);
  }
  if (body.includes(UPSTREAM_LINE)) {
    problems.push(`模板里还留着上游的旧默认目录：${UPSTREAM_LINE.trim()}`);
  }

  const recorded = meta["cli-version"];
  if (!recorded) {
    problems.push("模板头部没有 `; cli-version:` 记录 —— 升级 Tauri 时无法核对 fork 的来源");
  } else if (recorded !== cliVersion) {
    problems.push(
      `模板记录的 cli-version=${recorded}，package.json 里是 ${cliVersion} —— ` +
        "**Tauri CLI 升级了，上游模板可能已变**：重新 fork 并重放那 1 行改动",
    );
  }

  if (upstreamFetched) {
    if (upstreamText === null) {
      problems.push("已标记取到上游模板却没内容（内部错误）");
    } else {
      const want = upstreamText.replace(UPSTREAM_LINE, WANTED_LINE);
      if (want === upstreamText) {
        problems.push("上游模板里找不到那一行 —— 上游结构变了，fork 需要重做");
      } else if (body !== want) {
        const a = want.split("\n");
        const b = body.split("\n");
        const diffs = [];
        for (let i = 0; i < Math.max(a.length, b.length) && diffs.length < 5; i++) {
          if (a[i] !== b[i]) diffs.push(`第 ${i + 1} 行`);
        }
        problems.push(
          `模板与上游的差异不止那一行（${diffs.join("、")}）—— 重做 fork 时改多了，或者上游又变了`,
        );
      }
    }
  }

  problems.push(...inspectFileAssociations({ conf, hooksText, templateText }));

  return problems;
}

// ---------------------------------------------------------------------------
// 文件关联（`bundle.windows.nsis.installerHooks`）—— 判据 a / b / c / d
//
// 为什么长在这条门禁里：它本来就同时读 `tauri.conf.json` 与 `nsis/` 下的模板，而
// 「双击 .docx 能唤起本应用、但 ⛔ 不抢默认」正是 Windows 安装器配置的另一半。
// 形状、两条红线与逐字依据见 docs/specs/2026-10-09-file-associations.md。
// ---------------------------------------------------------------------------

/** 这一轮登记的 4 个扩展名（只取导入引擎真的支持的那些，源码行号见那份 docs）。 */
export const FILE_ASSOC_EXTS = ["docx", "xlsx", "pptx", "md"];

/** Tauri `installerHooks` 支持的四个 hook 名。写错名字时模板用 `!ifmacrodef` ⇒ **静默不插入** ✗ */
export const SUPPORTED_HOOKS = [
  "NSIS_HOOK_PREINSTALL",
  "NSIS_HOOK_POSTINSTALL",
  "NSIS_HOOK_PREUNINSTALL",
  "NSIS_HOOK_POSTUNINSTALL",
];

/**
 * 剥掉 NSIS 行注释（`;` 到行尾）。
 * 为什么必须先剥：说明「红线长什么样」的**注释里**本来就会写出那条不许出现的语句 ——
 * 不剥就会把**讲解**判成**违规**（本仓记过同形的"围栏感知"教训）。
 * ⚠️ 边界：不解析字符串里的 `;`（当前文件用不到；真需要时再按引号感知重写）。
 */
export function stripNsisComments(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/;.*$/, ""))
    .join("\n");
}

/** 「把 `.ext` 的默认值写成自己」那种形态 —— **判据 b 就是钉住它不出现**。 */
const WRITE_EXT_DEFAULT_RE =
  /(?:WriteRegStr|WriteRegExpandStr)\s+\S+\s+"Software\\Classes\\\.\$\{EXT\}"\s+""/;

/** 文件关联那一半的纯逻辑（判据 a/b/c/d）。返回问题清单；空数组 = 通过。 */
export function inspectFileAssociations({ conf, hooksText, templateText }) {
  const problems = [];
  const declared = conf?.bundle?.windows?.nsis?.installerHooks;

  // ---- 判据 b 前半（反向）：`bundle.fileAssociations` 一个都不许有 ----
  // 它在 Windows 上走上游 FileAssociation.nsh 的 APP_ASSOCIATE，那个宏里逐字有
  //   WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "" "${FILECLASS}"
  // = 把用户双击 .docx 时打开的程序改成我们 ⇒ 抢掉 Word ✗
  if (conf?.bundle?.fileAssociations !== undefined) {
    problems.push(
      "出现了 `bundle.fileAssociations` —— 它在 Windows 上走上游 `APP_ASSOCIATE`，写的是 " +
        "`Software\\Classes\\.<ext>` 的**默认值**（= 抢掉 Word）⇒ 必须改走 " +
        "`bundle.windows.nsis.installerHooks` ＋ 只写 `OpenWithProgids`",
    );
  }

  // ---- 判据 a：必须真的配了 installerHooks，且文件在 ----
  if (typeof declared !== "string" || declared.length === 0) {
    problems.push(
      "`bundle.windows.nsis.installerHooks` 没配 —— 文件关联不会登记，双击 .docx 不会唤起本应用",
    );
    return problems;
  }
  if (hooksText === null) {
    problems.push("`installerHooks` 指的文件不存在：" + declared + "（路径相对 src-tauri/）");
    return problems;
  }

  const body = stripNsisComments(hooksText);

  // ---- 判据 b 后半：剥注释后，任何"写 .ext 默认值"的形态都不许有 ----
  if (WRITE_EXT_DEFAULT_RE.test(body)) {
    problems.push(
      "installerHooks 文件里出现了「写 `.ext` 默认值」的语句（剥注释后）：" +
        '`WriteRegStr … "Software\\Classes\\.${EXT}" "" …` ⇒ 那就是抢默认 ✗',
    );
  }

  // ---- 判据 a 后半：每个扩展名都真的登记了，且走 OpenWithProgids ----
  if (!/OpenWithProgids/.test(body)) {
    problems.push("installerHooks 文件里没有 `OpenWithProgids` —— 那就不是「可以用它打开」语义");
  }
  for (const ext of FILE_ASSOC_EXTS) {
    if (!body.includes(`SHUYONOTE_OPENWITH_REGISTER "${ext}"`)) {
      problems.push(`installerHooks 文件没有登记 .${ext}（缺 ` + "`SHUYONOTE_OPENWITH_REGISTER \"" + ext + "\" …`" + `）`);
    }
  }
  if (!/--import/.test(body)) {
    problems.push("installerHooks 文件的打开命令里没有 `--import` —— 双击后不会走那条导入路径");
  }

  // ---- 判据 c：卸载必须把我们登记的两处都清掉，且不碰别人的默认值 ----
  const unregHook = /!macro\s+NSIS_HOOK_POSTUNINSTALL([\s\S]*?)!macroend/.exec(body);
  if (!unregHook) {
    problems.push("没有 `NSIS_HOOK_POSTUNINSTALL` —— 卸载后登记不会被清掉（留孤儿关联）");
  } else {
    for (const ext of FILE_ASSOC_EXTS) {
      if (!unregHook[1].includes(`SHUYONOTE_OPENWITH_UNREGISTER "${ext}"`)) {
        problems.push(`卸载段没有清理 .${ext}（缺 ` + "`SHUYONOTE_OPENWITH_UNREGISTER \"" + ext + "\" …`" + `）`);
      }
    }
  }
  const unregMacro = /!macro\s+SHUYONOTE_OPENWITH_UNREGISTER[\s\S]*?!macroend/.exec(body);
  if (!unregMacro) {
    problems.push("找不到 `SHUYONOTE_OPENWITH_UNREGISTER` 宏（卸载靠它清理）");
  } else {
    const m = unregMacro[0];
    if (!/DeleteRegValue\s+\S+\s+"Software\\Classes\\\.\$\{EXT\}\\OpenWithProgids"/.test(m)) {
      problems.push("反登记没删 `.ext\\OpenWithProgids\\<ProgID>` ⇒ 留孤儿项");
    }
    if (!/DeleteRegKey\s+\/ifempty\s+\S+\s+"Software\\Classes\\\.\$\{EXT\}\\OpenWithProgids"/.test(m)) {
      problems.push(
        "反登记清理 `.ext\\OpenWithProgids` 时**必须**用 `DeleteRegKey /ifempty`" +
          "（别人还有条目时不许整键删 ⇒ 否则会把 Word/WPS 的「打开方式」一起扫掉）",
      );
    }
    if (!/DeleteRegKey\s+\S+\s+"Software\\Classes\\\$\{PROGID\}"/.test(m)) {
      problems.push("反登记没删自有 ProgID 类键 ⇒ 留孤儿");
    }
    if (/DeleteRegKey[\s\S]{0,200}?"Software\\Classes\\\.\$\{EXT\}"/.test(m)) {
      problems.push("反登记在删 `.ext` 本身/它的默认值 ⇒ 会破坏**别人的**关联 ✗");
    }
  }

  // ---- 判据 d：hook 名必须是 Tauri 支持的四个，且模板真的在调它 ----
  const defined = [...body.matchAll(/!macro\s+(NSIS_HOOK_[A-Z_]+)/g)].map((mm) => mm[1]);
  if (defined.length === 0) {
    problems.push("installerHooks 文件里一个 `NSIS_HOOK_*` 都没定义 ⇒ 什么都不会发生");
  }
  for (const h of defined) {
    if (!SUPPORTED_HOOKS.includes(h)) {
      problems.push(
        `自定义 hook \`${h}\` 不是 Tauri 支持的名字（支持：${SUPPORTED_HOOKS.join(" / ")}）` +
          "—— 模板用 `!ifmacrodef`，写错会**静默不插入**",
      );
    }
  }
  if (templateText) {
    for (const h of defined) {
      if (!new RegExp(`!insertmacro\\s+${h}\\b`).test(templateText)) {
        problems.push(`模板里没有 \`!insertmacro ${h}\` ⇒ 它永远不会跑`);
      }
    }
    const iAssoc = templateText.indexOf('!include "FileAssociation.nsh"');
    const iHooks = templateText.indexOf('!include "{{installer_hooks}}"');
    if (iAssoc < 0) {
      problems.push('模板没有 `!include "FileAssociation.nsh"` ⇒ `UPDATEFILEASSOC` 未定义（编译不过）');
    }
    if (iHooks < 0) {
      problems.push('模板没有 `!include "{{installer_hooks}}"` ⇒ installerHooks 根本不会被 include');
    }
    if (iAssoc >= 0 && iHooks >= 0 && iAssoc > iHooks) {
      problems.push(
        "模板里 `FileAssociation.nsh` 的 include 排在 installerHooks **之后** ⇒ " +
          "我们的 hook 用到 `UPDATEFILEASSOC` 时它还没定义",
      );
    }
  }

  return problems;
}

/** 有网就下上游模板并解包；任何失败都返回 { fetched:false }（不算门禁失败）。 */
export async function fetchUpstream(crateVersion, tmpDir) {
  if (!crateVersion) return { fetched: false };
  const dir = tmpDir ?? join(ROOT, "target", "nsis-upstream-check");
  const crate = join(dir, `tauri-bundler-${crateVersion}.crate`);
  const tpl = join(dir, `tauri-bundler-${crateVersion}`, "src", "bundle", "windows", "nsis", "installer.nsi");
  try {
    if (existsSync(tpl)) return { fetched: true, text: readFileSync(tpl, "utf8") };
    mkdirSync(dir, { recursive: true });
    const res = await fetch(
      `https://static.crates.io/crates/tauri-bundler/tauri-bundler-${crateVersion}.crate`,
      { signal: AbortSignal.timeout(45000) },
    );
    if (!res.ok) return { fetched: false };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 10000) return { fetched: false };
    writeFileSync(crate, buf);
    execFileSync("tar", ["-xzf", crate, "-C", dir], { stdio: "ignore", timeout: 60000 });
    if (!existsSync(tpl)) return { fetched: false };
    return { fetched: true, text: readFileSync(tpl, "utf8") };
  } catch {
    return { fetched: false };
  }
}

async function main() {
  const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const cliVersion = String(
    pkg.devDependencies?.["@tauri-apps/cli"] ?? pkg.dependencies?.["@tauri-apps/cli"] ?? "",
  ).replace(/^[\^~]/, "");

  const declared = conf?.bundle?.windows?.nsis?.template;
  const abs = typeof declared === "string" ? join(ROOT, "src-tauri", declared) : null;
  const templateText = abs && existsSync(abs) ? readFileSync(abs, "utf8") : null;

  // 文件关联那一半的输入：`installerHooks` 指的 `.nsh`（判据 a/b/c/d 靠它）
  const hooksDeclared = conf?.bundle?.windows?.nsis?.installerHooks;
  const hooksAbs =
    typeof hooksDeclared === "string" && hooksDeclared.length > 0
      ? join(ROOT, "src-tauri", hooksDeclared)
      : null;
  const hooksText = hooksAbs && existsSync(hooksAbs) ? readFileSync(hooksAbs, "utf8") : null;

  const crateVersion = templateText
    ? (parseMeta(templateText)["upstream-crate"] ?? "").split(/\s+/).pop()
    : "";
  const up = await fetchUpstream(crateVersion);

  if (templateText) {
    console.log(`[nsis-template] ${declared} · cli=${cliVersion} · 上游 fork 自 tauri-bundler ${crateVersion}`);
  }
  console.log(
    up.fetched
      ? `[nsis-template] 已取到上游模板逐行比对（${(up.text.match(/\n/g) ?? []).length + 1} 行）`
      : "[nsis-template] · 跳过与上游的逐行比对（取不到 crates.io，网络原因）—— 离线三条仍已检查",
  );

  if (typeof hooksDeclared === "string" && hooksDeclared.length > 0) {
    console.log(
      `[nsis-template] 文件关联走 installerHooks：${hooksDeclared}` +
        (hooksText === null ? "（⚠️ 文件读不到）" : "（只写 OpenWithProgids，不写 .ext 默认值）"),
    );
  }

  const problems = inspect({
    conf,
    templateText,
    cliVersion,
    upstreamText: up.fetched ? up.text : null,
    upstreamFetched: up.fetched,
    hooksText,
  });

  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(`[结果] nsis-template ${problems.length} 项不合格`);
    process.exit(1);
  }
  console.log("  ✓ fork 存在，且与上游的差异只在默认安装目录那一行");
  console.log("  ✓ 新装用户默认目录 = %LOCALAPPDATA%\\Programs\\ShuyoNote（老用户沿用注册表里记着的位置）");
  console.log("  ✓ 头部记录的 Tauri CLI 版本与 package.json 一致");
  console.log(
    "  ✓ 文件关联：走 installerHooks ＋ 只写 OpenWithProgids（⛔ 没有写任何 `.ext` 的默认值），" +
      "卸载段清掉自己登记的两处",
  );
  console.log("[结果] nsis-template 通过");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(`[nsis-template] 运行出错：${e?.message ?? e}`);
    process.exit(1);
  });
}
