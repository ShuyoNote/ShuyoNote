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
 * @param {{conf:any, templateText:string|null, cliVersion:string, upstreamText:string|null, upstreamFetched:boolean}} o
 */
export function inspect({ conf, templateText, cliVersion, upstreamText, upstreamFetched }) {
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

  const problems = inspect({
    conf,
    templateText,
    cliVersion,
    upstreamText: up.fetched ? up.text : null,
    upstreamFetched: up.fetched,
  });

  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(`[结果] nsis-template ${problems.length} 项不合格`);
    process.exit(1);
  }
  console.log("  ✓ fork 存在，且与上游的差异只在默认安装目录那一行");
  console.log("  ✓ 新装用户默认目录 = %LOCALAPPDATA%\\Programs\\ShuyoNote（老用户沿用注册表里记着的位置）");
  console.log("  ✓ 头部记录的 Tauri CLI 版本与 package.json 一致");
  console.log("[结果] nsis-template 通过");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(`[nsis-template] 运行出错：${e?.message ?? e}`);
    process.exit(1);
  });
}
