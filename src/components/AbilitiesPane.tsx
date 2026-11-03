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
// ⭐ task-14（2026-11-01）：**启停 / 卸载** —— 状态那一半只有一处（`src/lib/abilities/state.ts`），
//    与「Office 导入」那几条入口共用同一份读数（⛔ 不是在界面里各记一个 boolean ✗）。
import {
  type AbilityEnabledFlags,
  abilityEnabledIn,
  loadAbilityStates,
  setAbilityEnabled,
  uninstallAbility,
} from "../lib/abilities/state";
import { confirmDialog } from "../store/confirm";
// ⚠️ 只从 `download.ts` 取 **pack id**（单一来源）——真下载已改由 Rust 做（见 `download()` 里那段注释），
//    那个模块**保留**为"前端侧那套接口与判据"（它的 11 条判据就是它的凭据），⛔ 不是死代码。
import { ECDICT_PACK_ID } from "../lib/dictionary/download";
// ⭐ **第 0 片（2026-10-14）**：清单**可下发** ✓（⭐ 形状／归一化／回退都在那一处 ✓ ——
//    ⛔ 本文件不再自己定义 `Ability` ✗，⭐ 那会变成第二份真相 ✓）。
import { loadAbilitiesManifest, type Ability } from "../lib/abilities/manifest";
// ⭐ 2026-10-18：第四态 `local-endpoint`（看图识字）的探测 —— 只探本机、只读 `/api/tags` ✓。
import { RECOMMENDED_VISION_MODEL, probeVisionModels, visionProbeText } from "../lib/abilities/localEndpoint";

/** Rust 侧下载的进度事件 → 界面那一行字（字节；没给 Content-Length ⇒ **如实**说"总量未知"）。 */
function fmtRustProgress(name: string, p: { received: number; total: number | null }): string {
  const pct = p.total === null ? "百分比未知（服务端没给 Content-Length）" : `${Math.min(100, Math.round((p.received / p.total) * 100))}%`;
  return `${name}：下载中 ${p.received}${p.total === null ? "" : ` / ${p.total}`} 字节 · ${pct}`;
}

// ⚠️ 清单**先写死在本文件**（随包内置那一份 ✓ —— ⭐ **第 0 片之后它同时是"回退那一份"** ✓）；
//    ⭐ 可下发那一份在 `src/lib/abilities/manifest.ts` ✓（从镜像仓取 `manifest.json` ✓，
//    ⚠️ **逐 `id` 并到这份上面** ✓ ⇒ ⛔ 它**抹不掉**下面 `office-import` ／ `ecdict-en-zh` 两条 ✗）。
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
  // ⭐ 2026-10-18（owner：「把 qwen2.5vl:3b 加到能力下载中心」）⇒ 结论：**不能当 `downloadable` 发** ✗。
  //    视觉抽取只许**本机端点**（红线），而本程序不启动推理进程 ⇒ 真实形态是"能力在、模型自己拉" ✓。
  //    所以它是**第四态** `local-endpoint`：面板给一颗「检查本机模型」，并说清缺了要跑哪条命令 ✓。
  //    ⛔ 别为了"看起来上架了"把它改成 `downloadable` —— 那等于假装"下完就能用"，而装完也没有东西能加载它 ✗。
  {
    id: "vlm-ocr",
    name: "看图识字（VLM）",
    summary: `用本机 Ollama 的视觉模型读图片与扫描件（推荐 ${RECOMMENDED_VISION_MODEL}，约 3.2 GB）`,
    state: "local-endpoint",
    note:
      "本程序不代下模型：视觉抽取只许本机端点（红线）。装好 Ollama 后拉一个视觉模型（`ollama pull " +
      RECOMMENDED_VISION_MODEL +
      "`），再点右边那颗「检查本机模型」。",
  },
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
  /** ⭐ **第 0 片（2026-10-14）**：清单**可下发** ✗ —— ⭐ 起点＝下面那份**内置**的 ✓，
   *  ⚠️ 拉到了就**并上来**（⛔ 不是整份替换 ✗ —— 那会抹掉代码里 `office-import`／`ecdict-en-zh` ✓），
   *  ⭐ **拉不到 ⇒ 就是它** ✓（⛔ 不许整屏空白 ✗）。 */
  const [abilities, setAbilities] = useState<Ability[]>(ABILITIES);
  /** ⭐ 2026-10-18：看图识字（`local-endpoint`）那颗「检查本机模型」的结果 ——
   *  ⚠️ **探不到 ≠ 没有**：连不上就显示"连不上"，⛔ 不许写成"没装模型" ✗（两者读起来一样、处置完全不同）。 */
  const [vlm, setVlm] = useState<{ busy: boolean; text: string } | null>(null);
  /** ⭐ task-14（2026-11-01）：三条能力的**启停读数**（后端 `ability_states`）。
   *  ⚠️ `null` ＝ 还没读到 / 读不到 ⇒ **按全启用**处理（fail-open，与 Rust 同口径）。
   *  ⛔ 它不负责"强制"：词库被拒查、Office 导入被拦都在各自那一处（Rust / `pathImport.ts`）✓。 */
  const [abilityFlags, setAbilityFlags] = useState<AbilityEnabledFlags[] | null>(null);
  /** 正在对哪一条做启停/卸载（同一时刻只允许一个动作，按钮据此禁用）。 */
  const [busyAbility, setBusyAbility] = useState<string | null>(null);
  /** 启停/卸载的结果 —— ⚠️ 失败要把**真实错误**显示出来（⛔ 不许假装成功 ✗）。 */
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const got = await loadAbilityStates({ force: true });
      if (alive) setAbilityFlags(got);
    })();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const got = await loadAbilitiesManifest({ fallback: ABILITIES });
      // ⚠️ 回退是**正常结果**（离线／镜像仓还没有那份清单 ✓）⇒ 不报错、不弹窗 ✓（`got.reason` 留给判据/
      //    将来做诊断用 ✓ —— ⛔ 界面上不许因此冒出红字 ✗）。
      if (alive) setAbilities(got.abilities);
    })();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // ⭐ task-14：多了两个读数 —— `installed`（盘上有没有那个文件）与 `disabled`（被用户停用）。
        //    ⚠️ 已装判定因此是**两档**：① 能用且核验过 ⇒ 已装；② **已装但被停用**（`disabled && installed`）
        //    ⇒ 也算"已装"，只是那一行要标「已禁用」并给「启用」按钮。
        //    ⛔ 不许因为"停用了"就把它挪回「按需下载」✗（那是"没装"才有的待遇）。
        const st = await platform.executor.invoke<{
          available: boolean;
          verified: boolean | null;
          disabled?: boolean;
          installed?: boolean;
        }>("dictionary_status");
        if (alive) {
          const usable = Boolean(st.available && st.verified);
          const installedButDisabled = Boolean(st.disabled && st.installed);
          setPackReady(usable || installedButDisabled);
        }
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

  /** ⭐ task-14：某个能力现在启用吗（读不到状态 ⇒ 启用；缺省＝启用，与后端同口径）。 */
  const enabledOf = (id: string) => abilityEnabledIn(abilityFlags, id);
  /** 能不能卸载：**以后端读数为准**；读数还没回来 ⇒ 回退到代码里那张表（只有词库真的下载过一个 pack）。 */
  const canUninstallOf = (id: string) =>
    abilityFlags?.find((f) => f.id === id)?.uninstallable ?? id === ECDICT_PACK_ID;
  /** 不可卸载时那句人话（与 Rust `abilities::uninstall_refusal` **同口径**，⛔ 不另造一套说法 ✗）。 */
  const uninstallReasonOf = (id: string): string => {
    if (id === "office-import") {
      return t(
        "abilities.uninstallBlockedBuiltin",
        "内置能力：随安装包一起提供，没有可卸载的下载包（可以改为「禁用」）",
      );
    }
    if (id === "vlm-ocr") {
      return t(
        "abilities.uninstallBlockedLocal",
        "本机端点能力：模型在你自己的 Ollama 里，本应用没有下载任何东西（可以改为「禁用」）",
      );
    }
    return t("abilities.uninstallHint", "只会删掉本应用下载的那份 pack，不碰笔记、附件和其它设置。");
  };

  /** ⭐ 启用/停用：成功后用**后端回的那份读数**刷新（⛔ 不自己猜状态 ✗）。 */
  const toggleAbility = async (a: Ability) => {
    const next = !enabledOf(a.id);
    setBusyAbility(a.id);
    setNotice(null);
    try {
      const states = await setAbilityEnabled(a.id, next);
      setAbilityFlags(states);
    } catch (e) {
      // ⛔ 不假装成功：把后端/平台那句**真实错误**原样摆出来
      setNotice({
        tone: "err",
        text: `${t("abilities.toggleFailed", "切换启用状态失败")}：${String(e)}`,
      });
    } finally {
      setBusyAbility(null);
    }
  };

  /** ⭐ 卸载：先确认（说清"只删哪一份、不碰什么"）⇒ 调后端 ⇒ **重新读盘上事实**。 */
  const removeAbility = async (a: Ability) => {
    if (!canUninstallOf(a.id)) return;
    const ok = await confirmDialog({
      title: t("abilities.uninstallConfirmTitle", {
        name: a.name,
        defaultValue: `卸载「${a.name}」？`,
      }),
      message: t("abilities.uninstallConfirmMessage", {
        id: a.id,
        defaultValue:
          `只会删除本应用下载的那份 pack（应用数据目录/packs/${a.id}），不会碰你的笔记、附件和其它设置。` +
          "删掉后这一项会回到「按需下载」，需要时可以再下。",
      }),
      okLabel: t("abilities.uninstall", "卸载"),
      cancelLabel: t("common.cancel", "取消"),
      danger: true,
    });
    if (!ok) return;
    setBusyAbility(a.id);
    setNotice(null);
    try {
      const rep = await uninstallAbility(a.id);
      // 盘上事实变了 ⇒ **重新读**（⛔ 不靠"我刚删过所以肯定没了"猜 ✗）；
      // ECDICT 那份没了 ⇒ 它这块回到「按需下载」（`packReady=false`）。
      setAbilityFlags(await loadAbilityStates({ force: true }));
      if (a.id === ECDICT_PACK_ID) setPackReady(false);
      setNotice({
        tone: "ok",
        text: rep.removed
          ? t("abilities.uninstallDone", {
              path: rep.path,
              size: fmtMB(rep.bytes),
              defaultValue: `已卸载：删掉了 ${rep.path}`,
            })
          : t("abilities.uninstallNoop", {
              path: rep.path,
              defaultValue: `已经卸载过了：${rep.path} 本来就不在`,
            }),
      });
    } catch (e) {
      setNotice({
        tone: "err",
        text: `${t("abilities.uninstallFailed", "卸载失败")}：${String(e)}`,
      });
    } finally {
      setBusyAbility(null);
    }
  };

  // 2026-11-03（owner 拍 A）：把「下载装上的资产」与「随包内置功能」**分开两节** ——
  // ⛔ 内置项不再混进「可用（已装）」：那里写「已装」＋ 不能卸载，读起来像漏了卸载按钮 ✗。
  const installed = abilities.filter((a) => a.state === "downloadable" && packReady);
  const builtinOnly = abilities.filter((a) => a.state === "builtin");
  const downloadable = abilities.filter((a) => a.state === "downloadable" && !packReady);
  const missing = abilities.filter((a) => a.state === "not-available");
  /** ⭐ 2026-10-18：需要用户在自己机器上备模型的那些（看图识字）✓ */
  const localEndpoint = abilities.filter((a) => a.state === "local-endpoint");

  /**
   * 「检查本机模型」：只探 loopback（`localVision` 同一条红线 ✓），只读 `/api/tags`。
   * ⚠️ 结论**如实**：连不上就写"连不上"，有模型但没视觉模型就写"缺什么 + 哪条命令" ✓。
   */
  const checkLocalVision = async () => {
    setVlm({ busy: true, text: "" });
    try {
      const probe = await probeVisionModels();
      setVlm({ busy: false, text: visionProbeText(probe) });
    } catch (e) {
      // 走到这里说明探测本身炸了（不该发生：probeVisionModels 内部已兜住）——照实说
      setVlm({ busy: false, text: `检查失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  return (
    <>
      {/* ⭐ task-14：启停/卸载的结果都摆在这里 —— ⚠️ 失败要显示**真实错误**（⛔ 不许假装成功 ✗）。 */}
      {notice ? (
        <p className="set-hint" data-testid="ability-notice" data-tone={notice.tone}>
          {notice.tone === "err" ? "× " : "√ "}
          {notice.text}
        </p>
      ) : null}

      {/* 2026-11-03：这一节只列**下载装上**的包；没有就整节收起（⛔ 不拿内置项填门面 ✗）。 */}
      {installed.length > 0 && (
        <section className="set-section">
          <div className="set-section-title">{t("abilities.installedTitle", "可用（已装）")}</div>
          {installed.map((a) => {
            const on = enabledOf(a.id);
            const uninstallable = canUninstallOf(a.id);
            const reason = uninstallReasonOf(a.id);
            return (
              <div className="set-row" key={a.id} data-ability={a.id} data-enabled={on ? "true" : "false"}>
                <div className="set-row-text">
                  <div className="set-row-name">{a.name}</div>
                  <div className="set-row-sub">{a.summary}</div>
                  {!on ? (
                    <div className="set-row-sub" data-testid="ability-disabled-hint">
                      {t("abilities.disabledHint", "这一项已被停用：不再参与任何功能，随时可以启用。")}
                    </div>
                  ) : null}
                  {!uninstallable ? (
                    <div className="set-row-sub" data-testid="ability-uninstall-reason" title={reason}>
                      {reason}
                    </div>
                  ) : null}
                </div>
                <span className={`set-badge ${on ? "is-ok" : "is-warn"}`} data-testid="ability-badge">
                  {on ? `√ ${t("abilities.installed", "已装")}` : t("abilities.disabled", "已禁用")}
                </span>
                <AbilityToggle
                  id={a.id}
                  name={a.name}
                  enabled={on}
                  busy={busyAbility === a.id}
                  onToggle={() => void toggleAbility(a)}
                />
                <AbilityUninstall
                  id={a.id}
                  name={a.name}
                  uninstallable={uninstallable}
                  reason={reason}
                  busy={busyAbility === a.id}
                  onUninstall={() => void removeAbility(a)}
                />
              </div>
            );
          })}
        </section>
      )}

      {/* 2026-11-03（owner 拍 A）：内置能力单独一节 —— 标「内置」不标「已装」，只留禁用/启用，⛔ 不显示卸载。 */}
      {builtinOnly.length > 0 && (
        <section className="set-section" data-testid="builtin-only-section">
          <div className="set-section-title">{t("abilities.builtinOnlyTitle", "内置能力")}</div>
          <p className="set-hint">
            {t("abilities.builtinOnlyHint", "随安装包提供，无需下载；不可卸载，但可以停用。")}
          </p>
          {builtinOnly.map((a) => {
            const on = enabledOf(a.id);
            return (
              <div className="set-row" key={a.id} data-ability={a.id} data-enabled={on ? "true" : "false"}>
                <div className="set-row-text">
                  <div className="set-row-name">{a.name}</div>
                  <div className="set-row-sub">{a.summary}</div>
                  {!on ? (
                    <div className="set-row-sub" data-testid="ability-disabled-hint">
                      {t("abilities.disabledHint", "这一项已被停用：不再参与任何功能，随时可以启用。")}
                    </div>
                  ) : null}
                </div>
                <span className={`set-badge ${on ? "is-ok" : "is-warn"}`} data-testid="ability-badge">
                  {on ? t("abilities.builtin", "内置") : t("abilities.disabled", "已禁用")}
                </span>
                <AbilityToggle
                  id={a.id}
                  name={a.name}
                  enabled={on}
                  busy={busyAbility === a.id}
                  onToggle={() => void toggleAbility(a)}
                />
              </div>
            );
          })}
        </section>
      )}

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
        {downloadable.map((a) => {
          const on = enabledOf(a.id);
          return (
            <div className="set-row" key={a.id} data-ability={a.id} data-enabled={on ? "true" : "false"}>
              <div className="set-row-text">
                <div className="set-row-name">{a.name}</div>
                <div className="set-row-sub">
                  {a.summary} · {fmtMB(a.bytes)} · sha256 {a.sha256?.slice(0, 12)}…
                </div>
                {/* ⭐ task-14：已停用 ⇒ 这一行也得说清（并且**不许**在停用状态下"顺手下一份"） */}
                {!on ? (
                  <div className="set-row-sub" data-testid="ability-disabled-hint">
                    {t("abilities.disabledHint", "这一项已被停用：不再参与任何功能，随时可以启用。")}
                  </div>
                ) : null}
              </div>
              {!on ? (
                <span className="set-badge is-warn" data-testid="ability-badge">
                  {t("abilities.disabled", "已禁用")}
                </span>
              ) : null}
              <AbilityToggle
                id={a.id}
                name={a.name}
                enabled={on}
                busy={busyAbility === a.id}
                onToggle={() => void toggleAbility(a)}
              />
              <button
                className="set-btn is-primary"
                data-testid="ability-download"
                onClick={() => void download(a)}
                disabled={phase.kind === "working" || busyAbility === a.id || !on}
                title={
                  !on
                    ? t("abilities.downloadBlockedDisabled", "这一项已停用 ⇒ 先启用，再下载")
                    : t("abilities.download", "下载")
                }
                aria-label={
                  !on
                    ? t("abilities.downloadBlockedDisabled", "这一项已停用 ⇒ 先启用，再下载")
                    : t("abilities.download", "下载")
                }
              >
                {/* ⭐ 2026-10-11：成功后同一颗按钮改叫「重新下载」✓。
                    ⚠️ **如实记**：`phase` 是**这一节共用**的 ⇒ 今天这节只有一条可下载项 ⇒ 无碍 ✓；
                    将来多于一条要改成**按条目**记状态 ✗（写在这里免得忘 ✓）。 */}
                {phase.kind === "ok" ? t("abilities.redownload", "重新下载") : t("abilities.download", "下载")}
              </button>
            </div>
          );
        })}
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

      {/* ⭐ 2026-10-18：第四态 `local-endpoint` —— 能力在，但模型**由用户在本机自己拉**（红线：视觉只许本机端点 ✓）。
          ⚠️ 这一节**不是**"还没上架"：它现在就能用，只是前提在用户机器上 ✓ —— 所以单独一节 + 一颗检查键 ✓。 */}
      {localEndpoint.length > 0 ? (
        <section className="set-section" data-testid="local-endpoint-section">
          <div className="set-section-title">{t("abilities.localEndpointTitle", "需要本机模型（本应用不代下）")}</div>
          {localEndpoint.map((a) => {
            const on = enabledOf(a.id);
            const uninstallable = canUninstallOf(a.id);
            const reason = uninstallReasonOf(a.id);
            return (
              <div className="set-row" key={a.id} data-ability={a.id} data-enabled={on ? "true" : "false"}>
                <div className="set-row-text">
                  <div className="set-row-name">{a.name}</div>
                  <div className="set-row-sub">{a.summary}</div>
                  {a.note ? (
                    <div className="set-row-sub set-row-note" title={a.note}>
                      {a.note}
                    </div>
                  ) : null}
                  {!on ? (
                    <div className="set-row-sub" data-testid="ability-disabled-hint">
                      {t("abilities.disabledHint", "这一项已被停用：不再参与任何功能，随时可以启用。")}
                    </div>
                  ) : null}
                  {!uninstallable ? (
                    <div className="set-row-sub" data-testid="ability-uninstall-reason" title={reason}>
                      {reason}
                    </div>
                  ) : null}
                </div>
                {!on ? (
                  <span className="set-badge is-warn" data-testid="ability-badge">
                    {t("abilities.disabled", "已禁用")}
                  </span>
                ) : null}
                <AbilityToggle
                  id={a.id}
                  name={a.name}
                  enabled={on}
                  busy={busyAbility === a.id}
                  onToggle={() => void toggleAbility(a)}
                />
                <AbilityUninstall
                  id={a.id}
                  name={a.name}
                  uninstallable={uninstallable}
                  reason={reason}
                  busy={busyAbility === a.id}
                  onUninstall={() => void removeAbility(a)}
                />
                {/* ⭐ task-14：停用 ⇒ 「检查本机模型」这颗按钮**不可用**（并说清为什么） */}
                <button
                  className="set-btn is-primary"
                  data-testid="check-local-vision"
                  disabled={vlm?.busy === true || busyAbility === a.id || !on}
                  title={
                    !on
                      ? t("abilities.disabledHint", "这一项已被停用：不再参与任何功能，随时可以启用。")
                      : "检查本机模型"
                  }
                  aria-label={
                    !on
                      ? t("abilities.disabledHint", "这一项已被停用：不再参与任何功能，随时可以启用。")
                      : "检查本机模型"
                  }
                  onClick={() => void checkLocalVision()}
                >
                  {vlm?.busy ? "检查中…" : "检查本机模型"}
                </button>
              </div>
            );
          })}
          {vlm && !vlm.busy ? (
            <p className="set-hint" data-testid="local-vision-result">
              {vlm.text}
            </p>
          ) : null}
        </section>
      ) : null}

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

/**
 * ⭐ task-14（2026-11-01）：「能力」页那一排操作 —— **启用/停用** 与 **卸载** 两颗键。
 *
 * ⚠️ 为什么抽成组件：已装 / 按需下载 / 本机端点**三节**都要同一套判定
 * （抄三份 ⇒ 迟早有一份忘了"停用时不许再动作" ✗）。
 * ⚠️ 两颗键都带 `title` ＋ `aria-label`：
 *   · `title` 是**理由**（悬停看得到：为什么不能卸载／停用意味着什么）；
 *   · `aria-label` 带上**这一项的名字** —— 读屏只念"禁用"等于没说是哪一条。
 * ⚠️ 卸载在 builtin / local-endpoint 上是 `disabled`，理由同时写在**行里**（触屏没有 hover ✓）。
 */
function AbilityToggle(props: {
  id: string;
  name: string;
  enabled: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = props.enabled ? t("abilities.disable", "禁用") : t("abilities.enable", "启用");
  const hint = props.enabled
    ? "停用这一项：停用后与它相关的入口会**真的拒绝**（不是只变灰），随时可以再启用。"
    : "重新启用这一项。";
  return (
    <button
      className="set-btn"
      data-testid="ability-toggle"
      data-ability-id={props.id}
      aria-pressed={!props.enabled}
      disabled={props.busy}
      title={`${label}「${props.name}」：${hint}`}
      aria-label={`${label}「${props.name}」`}
      onClick={props.onToggle}
    >
      {label}
    </button>
  );
}

function AbilityUninstall(props: {
  id: string;
  name: string;
  uninstallable: boolean;
  reason: string;
  busy: boolean;
  onUninstall: () => void;
}) {
  const { t } = useTranslation();
  const label = t("abilities.uninstall", "卸载");
  return (
    <button
      className="set-btn is-danger-ghost"
      data-testid="ability-uninstall"
      data-ability-id={props.id}
      disabled={!props.uninstallable || props.busy}
      title={props.uninstallable ? `${label}「${props.name}」：${props.reason}` : `不能卸载「${props.name}」：${props.reason}`}
      aria-label={
        props.uninstallable ? `${label}「${props.name}」` : `不能卸载「${props.name}」：${props.reason}`
      }
      onClick={props.onUninstall}
    >
      {/* ⚠️ 禁用**不等于**隐藏：按钮在那儿但点不动 ＋ 行里有理由 —— 用户才知道"为什么没有这颗键"。 */}
      {label}
    </button>
  );
}
