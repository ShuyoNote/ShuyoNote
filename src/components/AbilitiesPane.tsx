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

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { platform } from "../lib/platform";
// ⚠️ 只从 `download.ts` 取 **pack id**（单一来源）——真下载已改由 Rust 做（见 `download()` 里那段注释），
//    那个模块**保留**为"前端侧那套接口与判据"（它的 11 条判据就是它的凭据），⛔ 不是死代码。
import { ECDICT_PACK_ID } from "../lib/dictionary/download";

/** Rust 侧下载的进度事件 → 界面那一行字（字节；没给 Content-Length ⇒ **如实**说"总量未知"）。 */
function fmtRustProgress(name: string, p: { received: number; total: number | null }): string {
  const pct = p.total === null ? "百分比未知（服务端没给 Content-Length）" : `${Math.min(100, Math.round((p.received / p.total) * 100))}%`;
  return `${name}：下载中 ${p.received}${p.total === null ? "" : ` / ${p.total}`} 字节 · ${pct}`;
}

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
  // ⭐ 2026-10-10（owner 截图「去掉这个部分」）：原先这里有一条 `pdf-engine-win-x64`，自称
  //    「用来验证『按需下载 ＋ 校验』整条链」—— ⭐ **它不是给用户看的，是给自己试那条链的** ✓
  //    ⇒ ⭐ 已按 owner 的口径**删掉**（用户面不该摆一条"验证用"的条目 ✓）。
  //    ⚠️ **如实记：那个"试下载链"的入口因此没有了** ✗（以后要再试那条链，得另找地方 ✓）。
  // ⭐ 2026-10-11（owner 拍「把 Office 导入登记成一条能力」）：⭐ 它**真的**装在本应用里 ✓ ——
  //    入口＝右下角那颗小按钮 ＋ 双击 `.docx`（`App.tsx` 的 `<OfficeImportPanel />` ✓）；
  //    实现＝`src/lib/office/importPipeline.ts` ⇒ `src/lib/extract/ooxml.ts::docxToNoteBlocks` ✓。
  //    ⚠️ **如实划边界**：⭐ 第一期**只做 `.docx`** ✗ —— `ooxml.ts` 里虽然还有 `xlsxExtractor` /
  //       `pptxExtractor`，但**导入链一次都没调它们** ✗ ⇒ ⛔ 这里不许写"支持 Excel / PPT" ✓
  //       （那两个提取器走的是**另一条**路 ✓）。这一点有判据钉着：见 `AbilitiesPane.test.tsx` 的 i ✓。
  {
    id: "office-import",
    name: "Word 导入（.docx）",
    summary:
      "双击 .docx 或在右下角点一下 ⇒ 直接变成一页新笔记（标题 / 段落 / 列表 / 图片 / 表格都会带过来）",
    state: "builtin",
  },
  {
    id: "ecdict-en-zh",
    name: "英汉词库（ECDICT）",
    // ⚠️ 这里的 bytes/sha256 是**镜像仓上那份 gzip 压缩包**的读数（⛔ 不是解压后的库）——
    //    与 `shuyo-mirror/manifest.json` 那条**逐字一致**（别抄第二份）。解压后的库另有钉子：
    //    89,735,168 字节 / 5dc10a51…，钉在 `src-tauri/src/dictionary.rs`（下载链路会核两遍）。
    // ⚠️⭐ **2026-10-11（owner 截图「去掉这部分文案」）**：这句原来还挂着
    //    「—— ⚠️ 中文词条不在其中，界面会如实说未收录、走 AI」✗ ⇒ ⭐ 删掉 ✓。
    //    ⚠️ **那条事实并没有消失** ✗ —— ⭐ 它落在**该说的地方**：查词那边（`src/lib/dictionary/lookup.ts`
    //    的「未收录」文案 ✓，⭐ 判据在 `lookup.test.ts` 里钉着 ✓：⭐ 明说"英汉词典、不含中文词条、
    //    需解释走 AI、⛔ 不编造" ✓）⇒ ⭐ 用户**真查的时候**才看到它 ✓，⭐ 而能力清单里只列"⭐ 装了什么 ✗" ✓。
    summary: "应用内划词查词的英汉词典（770,611 条词条；下载 39.1 MiB，解压后 85.6 MiB）",
    bytes: 39126809,
    path: "mirror/ecdict/ecdict-en-zh-v1.db.gz",
    sha256: "ce0a2cf36c690038ff3d0e4d385ec18c04110db7a34e9bd8ba4ad30d76ee537b",
    state: "downloadable",
    note:
      "下载走 **Rust 侧**（`dictionary.rs`：先核压缩包的 sha256，再解压并核解压后那份的 sha256，" +
      "两段都过才 rename 落盘；⛔ 不过则一个字节都不留）。⚠️ 取法是 `contents` 拿 blob sha ⇒ `git/blobs` 取内容" +
      "（实测：`contents` 对大文件不回内容、`raw` 回的是 HTML）。",
  },
  { id: "layout", name: "版面分析", summary: "识别表格与分栏；模型较大", state: "not-available", note: "还没上架" },
  { id: "vlm-ocr", name: "看图识字（VLM）", summary: "复杂扫描件与手写", state: "not-available", note: "还没上架" },
  { id: "embeddings", name: "本地向量", summary: "离线语义检索", state: "not-available", note: "还没上架" },
  { id: "transcription", name: "音频转写", summary: "会议录音转文字", state: "not-available", note: "还没上架" },
];

type Phase =
  | { kind: "idle" }
  | { kind: "working"; text: string }
  // ⭐ 2026-10-11（owner 截图「下载完了的界面优化一下」）：成功那档**带上三个事实** ——
  //    ⛔ 不是把它们从界面删掉 ✗（用户要能自己核 ✓），而是**排版分开**：
  //    ⭐ 大小并进标题行、⭐ sha256 与路径落到下面那行灰字（⭐ 路径挂 `title` ⇒ 悬停看全 ✓）。
  //    ⚠️ 原来三样挤成一行、⭐ 还印生字节数（`89735168 B` ✗）⇒ 那一行长到折行 ✓。
  | { kind: "ok"; text: string; bytes?: number; sha256?: string; path?: string }
  | { kind: "err"; text: string };

const API = "https://api.gitcode.com/api/v5/repos/shuyo-cn/shuyo-mirror/contents/";

// ⚠️⭐ **2026-10-11 单位订正**：原来这里印的是 `MB` ✗ —— 而同一行里 `summary` 写的是 `MiB` ✓
//   ⇒ 同一个文件**两个口径并列**（39.1 MiB ／ 37.31 MB ✓ 其实都对，但用户看着像两个数 ✓）⇒ 统一成 `MiB` ＋ 一位小数 ✓。
function fmtMB(n?: number): string {
  if (!n) return "—";
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
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
  // ⭐ 2026-10-11（owner 截图问「下载完了，是不是应该移到『可用（已装）』？」）：⭐ **该移** ✓ ——
  //    但⛔ **不能写死** ✗：那份包**可能被清掉**（存储清理 ✓）／**可能被换掉**（指纹不符 ✓）
  //    ⇒ ⭐ 去盘上问一句 —— 后端 `dictionary_status` 本来就干这件事 ✓ 而且**带缓存校验** ✓。
  //    ⚠️⭐ **查不到 ／ 没核过 ⇒ 当作没装** ✗（⛔ 不许在查不动的时候说"已装" ✓）——
  //      所以默认 `false`，只有 `available && verified` 两件都为真才算 ✓。
  const [packReady, setPackReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const st = await platform.executor.invoke<{ available: boolean; verified: boolean | null }>("dictionary_status");
        if (alive) setPackReady(Boolean(st.available && st.verified));
      } catch {
        // ⛔ 查不动 ⇒ 不假装已装 ✓（那条会**留在「按需下载」**里，用户还能再下一次 ✓）
        if (alive) setPackReady(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const download = async (a: Ability) => {
    if (!a.path || !a.sha256) return;
    // ⭐ 词库那条：**真下载由 Rust 侧做**（owner 2026-10-10 拍；86 MiB 过 base64-IPC 那条链
    //    结构上不成立 —— `abilities.rs` 文件头写明那条链的设计目标是 3.8 MB 级的 PDFium）。
    //    Rust 侧语义与前端那套**逐条一致**：白名单＋钉死 sha256＋体积（＝pin）＋先写 `.part`
    //    再改名＋校验不过**一个字节都不留**；进度走事件（字节数；服务端没给 Content-Length ⇒ total 为 null，⛔ 不猜）。
    //    ⚠️ 这一格今天是 `not-available`（镜像仓里那个文件**还没提**）⇒ 按钮不会出现；
    //       提包之后把 `state` 改成 `downloadable` 即可（判据不变）。
    if (a.id === ECDICT_PACK_ID) {
      setPhase({ kind: "working", text: `${t("abilities.fetching", "正在取回")} ${a.name} …` });
      let off: (() => void) | null = null;
      try {
        off = await platform.event.listen<{ received: number; total: number | null }>(
          "dictionary-pack-progress",
          (e) => setPhase({ kind: "working", text: fmtRustProgress(a.name, e.payload) }),
        );
        const rep = await platform.executor.invoke<{ path: string; bytes: number; sha256: string; source: string }>(
          "dictionary_install_pack",
          { url: null },
        );
        // ⭐ 2026-10-11：⭐ 三个事实**结构化**带下去 ✓（⛔ 不再拼成一长串生数据 ✗）——
        //    `bytes` 交给 `fmtMB` 变人类可读，`sha256` ／ `path` 由渲染层排到下面那行灰字 ✓。
        setPhase({ kind: "ok", text: t("abilities.saved", "已保存到本地"), bytes: rep.bytes, sha256: rep.sha256, path: rep.path });
        // ⭐ 刚下完并当场核过 ⇒ 立刻把它算作**已装** ✓ ⇒ 它会**自己移到「可用（已装）」**里（owner 2026-10-11 ✓）
        setPackReady(true);
      } catch (e) {
        setPhase({ kind: "err", text: `${t("abilities.needNetwork", "这个能力需要一次下载 —— 现在取不到")}：${String(e)}` });
      } finally {
        off?.();
      }
      return;
    }
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

  // ⭐ 已装那一节 ＝ 源码里 `builtin` 的 ＋ ⭐ **盘上核实过的**可下载项 ✓（⛔ 不写死 ✗）；未核实的留在「按需下载」✓
  const builtin = ABILITIES.filter((a) => a.state === "builtin" || (a.state === "downloadable" && packReady));
  const downloadable = ABILITIES.filter((a) => a.state === "downloadable" && !packReady);
  const missing = ABILITIES.filter((a) => a.state === "not-available");

  return (
    <>
      <section className="set-section">
        <div className="set-section-title">{t("abilities.builtinTitle", "可用（已装）")}</div>
        {builtin.length === 0 ? (
          <p className="set-hint">
            {t(
              "abilities.builtinEmpty",
              // ⚠️⭐ **2026-10-11 订正**：上一句写的是「P0 那套格式解析……**但还没并进应用**」✗ ——
              //    ⭐ 它**已经并进来了**（Office 导入那条线合进 dev ✓：入口在右下角，双击 `.docx` 也能唤起 ✓）。
              //    ⇒ 这句话**过时了** ⇒ 改成如实说：**已接入，只是还没登记进这张表** ✓（所以这节仍是空的 ✓）。
              //    ⚠️ 如实记：**更彻底的做法**是把那条登记成 `ABILITIES` 里的一条（那这节就不空了 ✓）——
              //    ⛔ 那要动能力注册表，**等 owner 拍**再动 ✓。
              // ⚠️⭐ **2026-10-11 改实**：这句话原来写着「P0 那套格式解析（Word/Excel/PPT/邮件/压缩包…）
              //    **已经并进本应用**」✗ —— ⭐ **那句是夸大的** ✗：导入链**只做 `.docx`** ✓
              //    （`xlsxExtractor` / `pptxExtractor` 在 `ooxml.ts` 里存在，但导入链**没调**它们 ✓）。
              //    ⇒ ⭐ 改成不含格式清单的实话 ✓。
              //    ⚠️ 而且现在这条**根本不会显示**了 —— 「Word 导入」已经登记成 `builtin` ⇒ 这一节不空 ✓；
              //       留着它是为了"哪天那条被拿走"时这节仍有话说 ✓。
              "本应用目前还没有登记进下面这张表的「已接入」能力。",
            )}
          </p>
        ) : (
          builtin.map((a) => (
            <div className="set-row" key={a.id}>
              <div className="set-row-text">
                <div className="set-row-name">{a.name}</div>
                <div className="set-row-sub">{a.summary}</div>
              </div>
              {/* ⭐ 2026-10-11（owner 截图「优化这个界面」）：这一格原来复用 `.set-status` ✗ ——
                  而那是**整块卡片**（`padding:12px 14px` ＋ 边框 ＋ 背景 ＋ **`margin-bottom:16px`** ✓）⇒
                  ⭐ 既看着**像能点的按钮** ✗，⭐ 又把那一行撑高、还多出一大块节间空白 ✗。
                  ⇒ ⭐ 换成**行内徽章** `.set-badge is-ok`（小胶囊 ＋ 成功色 ＋ 无边无阴影 ✓）。 */}
              <span className="set-badge is-ok">√ {t("abilities.installed", "已装")}</span>
            </div>
          ))
        )}
      </section>

      {/* ⭐ 2026-10-11：⭐ 没有可下载的项时**整节收起来** ✗ —— 否则会剩一个空标题配上
          「只在点「下载」时才联网…」的说明，看着像坏了 ✓（⭐ 装机后词库已移到上一节 ✓）。 */}
      {downloadable.length > 0 && (
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
            <button className="set-btn is-primary" onClick={() => void download(a)} disabled={phase.kind === "working"}>
              {/* ⭐ 2026-10-11：成功后同一颗按钮改叫「重新下载」✓。
                  ⚠️ **如实记**：`phase` 是**这一节共用**的 ⇒ 今天这节只有一条可下载项 ⇒ 无碍 ✓；
                  将来多于一条要改成**按条目**记状态 ✗（写在这里免得忘 ✓）。 */}
              {phase.kind === "ok" ? t("abilities.redownload", "重新下载") : t("abilities.download", "下载")}
            </button>
          </div>
        ))}
        {/* ⭐ 2026-10-11（owner 截图「下载完了的界面优化一下」）：成功那档**不再是一句生数据** ✗ ——
            ⭐ 改成一张小成功卡：⭐ 第一行「√ 已保存到本地 · 85.6 MiB」✓，
            ⭐ 第二行灰字放 sha256 前 12 位与路径（⭐ 路径挂 `title` 悬停看全 ✓，⭐ 长路径自动折行 ✓）。
            ⚠️ **如实**：三个事实**一个都没删** ✗ —— 原来它们挤在一行、还印着 `89735168 B` ✓。
            进行中／失败仍用现成的 `set-hint`（⛔ 不新增类 ✓，⛔ 那两档一个字没动 ✓）。 */}
        {phase.kind === "ok" ? (
          <div className="set-pack-result">
            <div className="set-pack-result-head">
              <span className="set-pack-result-mark">√</span>
              <span>{phase.text}</span>
              {phase.bytes ? <span className="set-pack-result-size">· {fmtMB(phase.bytes)}</span> : null}
            </div>
            <div className="set-pack-result-meta" title={phase.path}>
              {phase.sha256 ? <span>sha256 {phase.sha256.slice(0, 12)}…</span> : null}
              {phase.path ? <span className="set-pack-result-path">{phase.path}</span> : null}
            </div>
          </div>
        ) : phase.kind !== "idle" ? (
          <p className="set-hint">
            {phase.kind === "err" ? "× " : "… "}
            {phase.text}
          </p>
        ) : null}
      </section>
      )}

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
