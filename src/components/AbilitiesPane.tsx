// 「能力」页 —— 官方引擎与按需下载。
//
// ⚠️ **口径纪律（本页存在的全部意义就在这）**：
//    · 状态只写**真实**的：`builtin`＝本应用里已经装好并且真的能用 ✓；`downloadable`＝清单里有
//      真实的 `url ＋ sha256` ⇒ 现在就能下一份并当场校验 ✓；`not-available`＝还没上架 ✓。
//    · ⛔ **不许**把"还没接入"写成"已内置" ✗ —— 今天 P0 引擎（Kreuzberg）**还没并进本应用** ✓，
//      所以本页顶部直接写这一句 ✓，而不是拿好看的绿底糊过去 ✗。
//    · 离线/失败：把**真实错误**打出来 ✓，并明说"这个能力需要一次下载" ✓（与离线不撒谎同一条脾气）。
//
// ⚠️ 这一版**真的落盘** ✓：校验通过后交给 Rust 命令写进 `应用数据/packs/`（那边**自己再校验一遍** ✓）。
//    ⛔ 仍然不假装：取不到、校验不过、Rust 拒收 ⇒ 都显示**真实错误** ✓。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";

/** 清单条目 —— 只认**真实值** ✓（url / sha256 任缺 ⇒ 不许出现下载按钮 ✗）。 */
interface Ability {
  id: string;
  name: string;
  summary: string;
  bytes?: number;
  /** GitCode 上的仓库路径（相对 https://gitcode.com/shuyo-cn/shuyo-mirror ✓） */
  path?: string;
  sha256?: string;
  /** 状态：真实三态 ✓ */
  state: "builtin" | "downloadable" | "not-available";
  note?: string;
}

// ⚠️ 清单先**写死在本文件**（随包内置那一份的雏形 ✓）；将来搬进 `src/lib/abilities/manifest.json` ✓。
//    sha256 是 2026-10-02 实测值 ✓（取回后与推送前一致 = True ✓）。
const ABILITIES: Ability[] = [
  {
    id: "pdf-engine-win-x64",
    name: "PDF 引擎（Windows x64）",
    summary: "本应用已在用的 PDFium；这一条用来验证「按需下载 ＋ 校验」整条链",
    bytes: 3826721,
    path: "mirror/pdfium/8076/pdfium-win-x64.tgz",
    sha256: "808d36da9bc5a3104315fb307c80998121f565ee53953633bf33e80d7429e5ac",
    state: "downloadable",
  },
  {
    id: "ecdict-en-zh",
    name: "英汉词库（ECDICT）",
    summary: "应用内划词查词的英汉词典（770,611 条词条 / 85.6 MiB）—— ⚠️ 中文词条不在其中，界面会如实说未收录、走 AI",
    bytes: 89735168,
    path: "mirror/ecdict/ecdict-en-zh.bin",
    sha256: "5dc10a51f33a0a61d4cb4f368a220a50f8bccb8c2ff3488fdadd5eaaaea2bb31",
    state: "not-available",
    note:
      "包已产出（`node scripts/fetch-ecdict.mjs` 报出 sha256 与字节数，与 Rust 侧白名单同源），但**还没托管**到镜像仓 ⇒ 现在还不能下载。" +
      "⚠️ 另：85.6 MiB 走「base64 过 IPC」那条链**太大**（那条链的设计目标是 3.8 MB 级的 PDFium，见 abilities.rs 文件头）" +
      "⇒ 要不要改成 Rust 侧下载（同一份白名单＋sha256＋fail-closed，先写 .part 再改名）待拍板。",
  },
  { id: "layout", name: "版面分析", summary: "识别表格与分栏；模型较大", state: "not-available", note: "还没上架" },
  { id: "vlm-ocr", name: "看图识字（VLM）", summary: "复杂扫描件与手写", state: "not-available", note: "还没上架" },
  { id: "embeddings", name: "本地向量", summary: "离线语义检索", state: "not-available", note: "还没上架" },
  { id: "transcription", name: "音频转写", summary: "会议录音转文字", state: "not-available", note: "还没上架" },
];

type Phase = { kind: "idle" } | { kind: "working"; text: string } | { kind: "ok"; text: string } | { kind: "err"; text: string };

const API = "https://api.gitcode.com/api/v5/repos/shuyo-cn/shuyo-mirror/contents/";

function fmtMB(n?: number): string {
  if (!n) return "—";
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // ⚠️ `crypto.subtle` 要一个独立 ArrayBuffer（TS 的 ArrayBufferLike 不含 SharedArrayBuffer 分支 ✓）
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function AbilitiesPane() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const download = async (a: Ability) => {
    if (!a.path || !a.sha256) return;
    setPhase({ kind: "working", text: `${t("abilities.fetching", "正在取回")} ${a.name} …` });
    try {
      const res = await fetch(API + a.path + "?ref=main");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { encoding?: string; content?: string; size?: number };
      if (j.encoding !== "base64" || !j.content) throw new Error(t("abilities.badShape", "返回结构不是预期的 base64"));
      const bin = atob(j.content.replace(/\s/g, ""));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      setPhase({ kind: "working", text: `${t("abilities.verifying", "校验中")} … ${bytes.length} B` });
      const got = await sha256Hex(bytes);
      if (got !== a.sha256) {
        setPhase({ kind: "err", text: `${t("abilities.mismatch", "sha256 不一致 ⇒ 拒绝启用")}（${got.slice(0, 12)}…）` });
        return;
      }
      // ⭐ 校验过了 ⇒ 交给 **Rust 侧落盘** ✓（那边会**自己再算一遍** sha256 ✓ —— 不信任 webview ✓）。
      //    ⚠️ 直接把 `j.content`（本来就是 base64 ✓）递过去 ⇒ 不再编码一遍 ✓。
      setPhase({ kind: "working", text: `${t("abilities.saving", "校验通过，正在保存")} …` });
      const saved = await api.saveAbilityPack(a.id, j.content.replace(/\s/g, ""));
      setPhase({
        kind: "ok",
        text: `${t("abilities.saved", "已保存到本地")}：${saved.bytes} B · sha256 ${saved.sha256.slice(0, 12)}… · ${saved.path} · ${t(
          "abilities.audit",
          "已记一条本地审计",
        )}`,
      });
    } catch (e) {
      setPhase({
        kind: "err",
        text: `${t("abilities.needNetwork", "这个能力需要一次下载 —— 现在取不到")}：${String(e)}`,
      });
    }
  };

  const builtin = ABILITIES.filter((a) => a.state === "builtin");
  const downloadable = ABILITIES.filter((a) => a.state === "downloadable");
  const missing = ABILITIES.filter((a) => a.state === "not-available");

  return (
    <>
      <section className="set-section">
        <div className="set-section-title">{t("abilities.builtinTitle", "可用（已装）")}</div>
        {builtin.length === 0 ? (
          <p className="set-hint">
            {t(
              "abilities.builtinEmpty",
              "本应用目前没有已接入的官方能力。⚠️ P0 那套格式解析（Word/Excel/PPT/邮件/压缩包…）已经在本地验证通过，但还没并进应用 —— 所以这里不能写「已内置」。",
            )}
          </p>
        ) : (
          builtin.map((a) => (
            <div className="set-row" key={a.id}>
              <div className="set-row-text">
                <div className="set-row-name">{a.name}</div>
                <div className="set-row-sub">{a.summary}</div>
              </div>
              <span className="set-status">√ {t("abilities.installed", "已装")}</span>
            </div>
          ))
        )}
      </section>

      <section className="set-section">
        <div className="set-section-title">{t("abilities.downloadTitle", "按需下载")}</div>
        <p className="set-hint">
          {t(
            "abilities.downloadHint",
            "只在点「下载」时才联网；取回后按清单里钉的 sha256 硬校验，对不上就拒绝启用。",
          )}
        </p>
        {downloadable.map((a) => (
          <div className="set-row" key={a.id}>
            <div className="set-row-text">
              <div className="set-row-name">{a.name}</div>
              <div className="set-row-sub">
                {a.summary} · {fmtMB(a.bytes)} · sha256 {a.sha256?.slice(0, 12)}…
              </div>
            </div>
            <button className="set-btn" onClick={() => void download(a)} disabled={phase.kind === "working"}>
              {t("abilities.download", "下载")}
            </button>
          </div>
        ))}
        {phase.kind !== "idle" && (
          // ⚠️ 不新增 CSS 类 ✓：本仓已有 `set-hint`，与界面别处一样用 `√/×` 前缀表达成败 ✓。
          <p className="set-hint">
            {phase.kind === "ok" ? "√ " : phase.kind === "err" ? "× " : "… "}
            {phase.text}
          </p>
        )}
      </section>

      <section className="set-section">
        <div className="set-section-title">{t("abilities.soonTitle", "还没上架")}</div>
        {missing.map((a) => (
          <div className="set-row" key={a.id}>
            <div className="set-row-text">
              <div className="set-row-name">{a.name}</div>
              <div className="set-row-sub">{a.summary}</div>
            </div>
            {/* ⚠️ 2026-10-02 观感修正：这一格原来是 `.set-status`（带边框，像按钮 ✗ ⇒ 会被当成"能点"）。
                改成**灰字** ✓ —— 用现成的 `set-row-sub`（说明文字那档灰 ✓）。
                ⚠️⭐ **2026-10-10 修 bug（owner 截图：ECDICT 那条的说明 + 名字都被压成"一个字一列"✗）——
                   我第一版诊断写反了 ✗，纠正留在这里**：
                   · 我说"少 `min-width: 0` ⇒ 被压成一列"✗ —— **反了**：`min-width: 0` 是**允许它缩到 0** ✗，
                     那**正是**成因；而 `min-width: auto`（默认）**反而**会撑着不缩 ✓。
                   · 真成因（CDP 实量，面板 626px）：这一格 `flex: 0 1 auto` ⇒ flex base ＝ max-content
                     ＝ **整句自然宽**（那条 note 236 字 ⇒ **590px**）✗，而 `.set-row-text` 是 `flex: 1`
                     （`1 1 0%`，base ＝ **0**，没有要守护的基准 ✗）⇒ **被它饿死**：
                     实测 `textW = 0` ／ `nameW = 0` ／ `nameH = 90`（名字一列一个字 ✓）。
                   ⇒ 修法＝**给这一格一个确定且有限的宽度** ✗（`set-row-note` 里给死 `flex: 0 0 40%` ✓，
                     ⛔ 不是靠收缩 ✗）：修后实测 `textW = 349.2` ／ `nameH = 18`（一行 ✓）／`noteW = 240.8` ✓。
                ⛔ 别把这几条注释删掉：上一次事故正是"用现成的类、⛔ 不新增 CSS"这个决定造成的 ✓。 */}
            {/* ⭐ **2026-10-10（owner 拍 C）**：这一格在列表里**只显示 2 行 ＋ 省略号** ✗（CSS 在 `App.css` 的
                `.set-row-note`）★ 而 ⭐ **全文一个字都不许少** ✗ —— ⛔ 不许把文案改短 ✗：
                DOM 里仍是**完整那句**（只是视觉上截断）＋ ⭐ **悬停看全文**（`title` ＝ 同一句，用现成属性 ⇒ ⛔ 不自己写浮层）。
                ⚠️ 判据：`AbilitiesPane.test.tsx` 的 f／g／h（2 行 ／ 全文还在 ／ `title` ＝ 全文）＋ 真量高度。 */}
            <span className="set-row-sub set-row-note" title={a.note ?? t("abilities.soon", "还没上架")}>{a.note ?? t("abilities.soon", "还没上架")}</span>
          </div>
        ))}
      </section>

      <p className="set-hint">
        {t("abilities.policy", "只下引擎与模型，不发用户内容，也没有遥测。下载源：api.gitcode.com（GitCode）。")}
      </p>
    </>
  );
}
