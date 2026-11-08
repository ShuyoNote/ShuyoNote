// P1「连接体检」：把 `lan_status` 的读数翻成**结构化体检项** ＋ 可复制的**脱敏诊断包**。
//
// ## 这个文件为什么存在
// 个人版同步的第一条路是局域网。用户说「连不上」时，今天面板只能给一两句总说明
// （`lanStatus.line` / `mesh.note` / J9 的诊断句）—— 而那几句话**分不清**：
//   ① 发现层根本没开；② 窗口端口没起来；③ 网段里没人；④ 有人但不服务这个空间；
//   ⑤ 两端端口不一致；⑥ 对方钥匙变了；⑦ 只是读不到（旧版本/Web）。
// 这七件事的**处置完全不同**，所以本文件把它们拆成逐项读数（每项：级别 / 标题 / 原因 / 下一步）。
//
// ## 三条纪律（与仓内那几条同源）
// 1. **⛔ 不新增任何命令／字段**：输入只有现成的 `LanStatus`（可选加本轮 `MeshRoundReport`）——
//    界面这一层不猜、不扫描、不联网。读数从哪来都写在每个 `makeItem` 的 reason 里。
// 2. **读不到 ≠ 正常**：老版本构建 / Web 档没有某些读数时，给 `unknown`（"没有结论"），
//    ⛔ 不许拿 0 或默认值冒充"没问题"（`INV-*` 同族口径，见 `personalSyncReadout.ts`）。
// 3. **脱敏**：诊断包 ⛔ 不含 `device_id` / 地址 / 配对秘密 / 页面正文 / 设备名；
//    只含级别、原因码、短标识、端口号、数量这类**可以给支持人员看**的东西。
//    ⚠️ 因此体检项拆成 `title`（脱敏安全）＋ `subject`（只给界面显示的设备名，⛔ 不进诊断包）。
//
// 判据：`src/lib/meshDiagnose.test.ts`（纯函数 ≥5 场景 ＋ 脱敏 ＋ 面板接线）。

import type { LanStatus, MeshRoundReport, NearbyPeer } from "./platform/commands";
import { READOUT_UNREAD, portMismatchNotice } from "./personalSyncReadout";

/** 一项体检查结论的四个级别。`unknown` ＝ **没有结论**（读不到），⛔ 不是"没问题"。 */
export type DiagnoseLevel = "ok" | "warn" | "bad" | "unknown";

/** 级别 → 用户能读的一个词（对话框里摆成小胶囊；⛔ 不显示英文码）。 */
export const LEVEL_LABEL: Record<DiagnoseLevel, string> = {
  ok: "好",
  warn: "注意",
  bad: "问题",
  unknown: READOUT_UNREAD,
};

/** 一条体检项（纯数据，组件只负责摆）。 */
export interface DiagnoseItem {
  /** 稳定键（判据按它取元素；⛔ 不含任何运行时值）。 */
  key: string;
  level: DiagnoseLevel;
  /** 标题：**脱敏安全**（不含设备名／设备号／地址）。 */
  title: string;
  /**
   * 只给界面显示的**主体**（设备名等）—— ⛔ **不进诊断包** ✗。
   * 没有可显示主体（或它就是"本机整体"那一项）时省略。
   */
  subject?: string;
  /** 为什么是这个结论（读数/原因码；脱敏安全）。 */
  reason: string;
  /** 下一步做什么（永远有话说；「不用处理」也是一种话）。 */
  next: string;
}

/**
 * 一台对端的**脱敏摘要**（诊断包里的「设备明细」只用这些字段）。
 * ⛔ 不含 `device_id` / `addr` / `device_name` / `pubkey`。
 */
export interface PeerDigest {
  /** 1 起的序号（诊断包里用来区分"第几台"，⛔ 不是设备号）。 */
  index: number;
  /** 对方公告的短标识；空串 ＝ 对方没报。 */
  shortId: string;
  /** 对方公告里的端口；`null` ＝ 没报/没解析出来。 */
  announcedPort: number | null;
  servesCurrent: boolean;
  /** 原因码原文（`ok` / `no_secret` / …；⛔ 不含任何值）。 */
  servesReason: string;
  keyChanged: boolean | null;
  keyReason: string;
  /** 对方有没有报出身份材料（`pubkey` 非空）。 */
  hasIdentity: boolean;
}

/** 一次体检的完整结果。 */
export interface MeshDiagnosis {
  overall: DiagnoseLevel;
  /** 一句总评（对话框顶部那句话）。 */
  headline: string;
  counts: Record<DiagnoseLevel, number>;
  items: DiagnoseItem[];
  /** 脱敏的设备摘要（诊断包用；界面不用它记事，界面用 `items`）。 */
  peers: PeerDigest[];
  /** 生成时刻（ms）；诊断包里会写成可读时间。 */
  at: number;
}

/** 把 `mesh.bind`（形如 `0.0.0.0:8788` / `[::]:8788`）拆出端口号。 */
///
/// 只认**最后一个 `:`** 后面那 1–5 位十进制；拆不出来／越界 ⇒ `null`（⛔ 不猜默认端口 ✗）。
/// ⚠️ 与 `SyncPanel.tsx` 的 `splitMeshBind` 同一口径（那边拆字符串给状态条，这边只要数字）。
export function portOfBind(bind: string | null | undefined): number | null {
  const raw = (bind ?? "").trim();
  if (!raw) return null;
  const i = raw.lastIndexOf(":");
  if (i < 0) return null;
  const tail = raw.slice(i + 1);
  if (!/^\d{1,5}$/.test(tail)) return null;
  const n = Number(tail);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** 一台对端在界面上叫什么（⛔ 不回落成设备号；没名字就如实说）。 */
function subjectOf(p: NearbyPeer): string {
  const name = (p.device_name ?? "").trim();
  return name || "这一台（没报名字）";
}

/** `serves_reason` → 人话＋下一步（⛔ 未知原因码不许猜，如实说"不认识"）。 */
function servesReasonWhy(code: string): { reason: string; next: string } {
  switch (code) {
    case "ok":
      return {
        reason: "对端报出的服务范围里没有当前这个空间（原因码 ok，但结论是不服务）",
        next: "切到它服务的那个空间，或重新配对后再看一次",
      };
    case "no_secret":
      return {
        reason: "本机这个空间还没有可直连的标识（个人档＝还没设配对暗号；团队档＝还没绑组织空间）",
        next: "先在本机完成这个空间的配对/绑定，再重新读取",
      };
    case "space_deleted":
      return {
        reason: "对端服务的那个空间在本机已删",
        next: "要接着同步，先把那个空间放回来",
      };
    case "peer_not_serving":
      return {
        reason: "对端没报它在服务哪些空间（多半是旧版本）",
        next: "把对端升级到同一版本后重新读取",
      };
    case "mismatch":
      return {
        reason: "两边报的空间对不上",
        next: "切到同一个空间，或重新配对后再看一次",
      };
    default:
      return {
        reason: `原因码 ${code.trim() || "（空）"} 不认识，没法替你解释`,
        next: "复制诊断包给开发者核对",
      };
  }
}

/** `key_reason` → 读不到时那一句（⛔ 不把"读不到"说成"没变"）。 */
function keyUnreadWhy(code: string): string {
  switch (code) {
    case "peer_no_key":
      return "对端没报公钥（多半是旧版本），没法核对钥匙";
    case "no_record":
      return "本机还没记过这一台的公钥（还没配对过），没法核对钥匙";
    default:
      return `原因码 ${code.trim() || "（空）"} 不认识，没法核对钥匙`;
  }
}

function peerDigest(p: NearbyPeer, index: number): PeerDigest {
  return {
    index,
    shortId: (p.short_id ?? "").trim(),
    announcedPort:
      typeof p.announced_port === "number" && Number.isFinite(p.announced_port)
        ? p.announced_port
        : null,
    servesCurrent: p.serves_current === true,
    servesReason: (p.serves_reason ?? "").trim(),
    keyChanged: p.key_changed === true ? true : p.key_changed === false ? false : null,
    keyReason: (p.key_reason ?? "").trim(),
    hasIdentity: (p.pubkey ?? "").trim().length > 0,
  };
}

function countsOf(items: DiagnoseItem[]): Record<DiagnoseLevel, number> {
  const counts: Record<DiagnoseLevel, number> = { ok: 0, warn: 0, bad: 0, unknown: 0 };
  for (const it of items) counts[it.level] += 1;
  return counts;
}

function overallOf(counts: Record<DiagnoseLevel, number>): DiagnoseLevel {
  // 顺序即优先级：有问题 > 要注意 > 没有结论 > 都好。
  if (counts.bad > 0) return "bad";
  if (counts.warn > 0) return "warn";
  if (counts.unknown > 0) return "unknown";
  return "ok";
}

function headlineOf(counts: Record<DiagnoseLevel, number>, overall: DiagnoseLevel): string {
  switch (overall) {
    case "bad":
      return `发现 ${counts.bad} 个需要处理的问题` +
        (counts.warn > 0 ? `，另有 ${counts.warn} 项需要注意` : "");
    case "warn":
      return `有 ${counts.warn} 项需要注意`;
    case "unknown":
      return `有 ${counts.unknown} 项读不到，这次还下不了结论`;
    default:
      return "这次读数没有发现问题";
  }
}

/**
 * 把 `lan_status`（可选本轮网格读数）变成结构化体检项。**纯函数**（时间可注入）。
 *
 * @param status `lan_status` 的读数；`null`/`undefined` ＝ 这一次读不到（命令没注册/老构建）。
 * @param round 本轮 `mesh_sync_now` 的读数（可选；只看它已经拼好的 `note` 与失败台数，
 *               ⛔ 不拿 `peers[].error` 里的地址拼句子）。
 * @param opts.at 生成时刻（测试注入；省略＝现在）。
 */
export function diagnoseMesh(
  status: LanStatus | null | undefined,
  round?: MeshRoundReport | null,
  opts?: { at?: number },
): MeshDiagnosis {
  const at = opts?.at ?? Date.now();
  const items: DiagnoseItem[] = [];

  // ① 整份读数都读不到 ⇒ 只有一条 unknown（⛔ 不许装成"一切正常"）。
  if (!status) {
    items.push({
      key: "status",
      level: "unknown",
      title: "局域网读数",
      reason: "这一次没读到局域网状态（命令没注册、旧构建，或读的时候出错了）",
      next: "点「重新读取」；仍然读不到就重启应用后再看",
    });
    const counts0 = countsOf(items);
    return {
      overall: "unknown",
      headline: headlineOf(counts0, "unknown"),
      counts: counts0,
      items,
      peers: [],
      at,
    };
  }

  const mesh = status.mesh;
  const nearbyRaw = status.nearby;
  const nearbyReadable = Array.isArray(nearbyRaw);
  const nearby: NearbyPeer[] = nearbyReadable ? (nearbyRaw as NearbyPeer[]) : [];
  const peers = nearby.map((p, i) => peerDigest(p, i + 1));

  // ② 发现层开没开
  if (status.enabled) {
    items.push({
      key: "discovery",
      level: "ok",
      title: "局域网发现",
      reason: "发现层开着，这一轮读数就是从这条发现层拿到的",
      next: "不用处理",
    });
  } else {
    items.push({
      key: "discovery",
      level: "bad",
      title: "局域网发现",
      reason: "发现层关着 —— 收不到同网段设备的公告，局域网同步不会发生",
      next: "点状态条右上角的「开启局域网同步」；仍然不行就重启应用",
    });
  }

  // ③ 同步窗口 / 端口（本机 `mesh.bind`）
  const meshEnabled = mesh?.enabled === true;
  const bind = (mesh?.bind ?? "").trim();
  const localPort = portOfBind(bind);
  if (!meshEnabled) {
    items.push({
      key: "window",
      level: "unknown",
      title: "同步窗口端口",
      reason: "网格这一档没开，窗口没起来 ⇒ 端口也读不到（没有结论）",
      next: "先开启局域网同步，再重新读取",
    });
  } else if (!bind) {
    items.push({
      key: "window",
      level: "bad",
      title: "同步窗口端口",
      reason: "网格这一档开着，但读不到监听地址 ⇒ 窗口多半没起来",
      next: "在状态条右上角把局域网同步关一次再开；仍然不行就重启应用",
    });
  } else if (localPort === null) {
    items.push({
      key: "window",
      level: "unknown",
      title: "同步窗口端口",
      reason: "读到了监听地址，但从里面拆不出端口号（格式不是 地址:端口）",
      next: "复制诊断包给开发者核对；暂时不用改设置",
    });
  } else {
    items.push({
      key: "window",
      level: "ok",
      title: "同步窗口端口",
      reason: `本机监听已就绪，端口 :${localPort}`,
      next: "不用处理",
    });
  }

  // ④ 附近设备数（⛔ 读不到 / 发现层关 都不许写成 0 台）
  if (!nearbyReadable) {
    items.push({
      key: "nearby",
      level: "unknown",
      title: "附近设备",
      reason: "这一版读数里没有附近设备列表（旧构建或 Web 档），不知道网段里有谁",
      next: "用桌面版最新构建再看一次；Web 版没有这一层",
    });
  } else if (!status.enabled) {
    items.push({
      key: "nearby",
      level: "unknown",
      title: "附近设备",
      reason: "发现层关着 ⇒ 附近设备读数不成立（这不是「一台都没有」）",
      next: "先开启局域网同步，再重新读取",
    });
  } else if (nearby.length === 0) {
    items.push({
      key: "nearby",
      level: "warn",
      title: "附近设备",
      reason: "发现层开着，但这一轮一台设备的公告都没收到",
      next: "确认两台在同一 Wi-Fi；仍不行就换一个网络（有些网络会隔离设备）并让对方也打开局域网同步",
    });
  } else {
    items.push({
      key: "nearby",
      level: "ok",
      title: "附近设备",
      reason: `这一轮收到 ${nearby.length} 台设备的公告`,
      next: "不用处理",
    });
  }

  // ⑤ 端口是否不一致（本机 `mesh.bind` 的端口 vs 每台对端公告的端口）
  if (nearby.length > 0) {
    if (localPort === null) {
      items.push({
        key: "port",
        level: "unknown",
        title: "两端端口",
        reason: "本机端口读不到，没法比对对方报的端口",
        next: "先让同步窗口就绪（见上一条），再重新读取",
      });
    } else {
      const known = peers.filter((p) => p.announcedPort !== null);
      if (known.length === 0) {
        items.push({
          key: "port",
          level: "unknown",
          title: "两端端口",
          reason: "附近的对端都没报端口（多半是旧版本），没法比对",
          next: "把对端升级到同一版本后再看一次",
        });
      } else {
        const mismatched = known.filter((p) => p.announcedPort !== localPort);
        if (mismatched.length === 0) {
          items.push({
            key: "port",
            level: "ok",
            title: "两端端口",
            reason: `本机 :${localPort}，报了端口的那几台对端都是 :${localPort}`,
            next: "不用处理",
          });
        }
        for (const p of mismatched) {
          items.push({
            key: `port-${p.index}`,
            level: "warn",
            title: "两端端口不一致",
            subject: `设备 ${p.index}（短标识 ${p.shortId || "未报"}）`,
            reason: portMismatchNotice(localPort, p.announcedPort as number),
            next: "在「高级」里把两端的广播端口改成一样，再重新读取",
          });
        }
        const missing = peers.filter((p) => p.announcedPort === null);
        if (missing.length > 0) {
          items.push({
            key: "port-missing",
            level: "unknown",
            title: "两端端口（部分）",
            reason: `${missing.length} 台对端没报端口（旧版本），这几台没法比对`,
            next: "把对端升级到同一版本后再看一次",
          });
        }
      }
    }
  }

  // ⑥ 逐台设备：服务当前空间 / 钥匙 / 身份材料 / 短标识
  for (const p of peers) {
    const subject = subjectOf(nearby[p.index - 1]);
    // 6a 服务当前空间（用原因码说清 why）
    if (p.servesCurrent) {
      items.push({
        key: `peer-${p.index}-serves`,
        level: "ok",
        title: "这一台在服务当前空间",
        subject,
        reason: `对端自报服务这个空间（原因码 ${p.servesReason || "ok"}）`,
        next: "不用处理",
      });
    } else {
      const why = servesReasonWhy(p.servesReason);
      // 原因码不认识 ⇒ 给 unknown（没有结论），⛔ 不替它猜一个原因
      const known = ["ok", "no_secret", "space_deleted", "peer_not_serving", "mismatch"].includes(
        p.servesReason,
      );
      items.push({
        key: `peer-${p.index}-serves`,
        level: known ? "warn" : "unknown",
        title: "这一台没有服务当前空间",
        subject,
        reason: why.reason,
        next: why.next,
      });
    }
    // 6b 钥匙变没变
    if (p.keyChanged === true) {
      items.push({
        key: `peer-${p.index}-key`,
        level: "warn",
        title: "这一台的钥匙变了",
        subject,
        reason: "对方报的公钥和本机记录的不一致（可能是重装或换了设备）",
        next: "点「重新配对」确认对方身份；确认前不要用它同步",
      });
    } else if (p.keyChanged === false) {
      items.push({
        key: `peer-${p.index}-key`,
        level: "ok",
        title: "这一台的钥匙没变",
        subject,
        reason: "对方报的公钥与本机记录的一致",
        next: "不用处理",
      });
    } else {
      items.push({
        key: `peer-${p.index}-key`,
        level: "unknown",
        title: "这一台的钥匙",
        subject,
        reason: keyUnreadWhy(p.keyReason),
        next: "先配对，或把对端升级到同一版本后重新读取",
      });
    }
    // 6c 身份材料（pubkey）
    items.push(
      p.hasIdentity
        ? {
            key: `peer-${p.index}-identity`,
            level: "ok",
            title: "这一台报出了身份材料",
            subject,
            reason: "对方公告里带了自己的公钥（公钥不是秘密，但本文件不把它写进诊断包）",
            next: "不用处理",
          }
        : {
            key: `peer-${p.index}-identity`,
            level: "unknown",
            title: "这一台没报身份材料",
            subject,
            reason: "对方公告里没有公钥（多半是旧版本）⇒ 没法核对它是谁",
            next: "把对端升级到同一版本；核对身份之前不要信任它",
          },
    );
    // 6d 短标识（界面核对身份用的那一小段）
    items.push(
      p.shortId
        ? {
            key: `peer-${p.index}-short-id`,
            level: "ok",
            title: "这一台报出了短标识",
            subject,
            reason: `短标识 ${p.shortId}`,
            next: "不用处理",
          }
        : {
            key: `peer-${p.index}-short-id`,
            level: "unknown",
            title: "这一台没报短标识",
            subject,
            reason: "对方公告里没有可显示的短标识（多半是旧版本）",
            next: "把对端升级到同一版本；不影响同步，只影响核对身份",
          },
    );
  }

  // ⑦ 本轮网格读数（可选）：只看它已经拼好的人话与失败台数
  if (round) {
    if (round.enabled !== true) {
      items.push({
        key: "round",
        level: "unknown",
        title: "上一轮网格同步",
        reason: round.note || "网格这一档没跑（没有说明）",
        next: "先开启局域网同步，再点一次「立即同步」",
      });
    } else {
      const failed = Array.isArray(round.peers)
        ? round.peers.filter((p) => p.error).length
        : 0;
      items.push({
        key: "round",
        level: failed > 0 ? "warn" : "ok",
        title: "上一轮网格同步",
        reason: failed > 0
          ? `${round.note}（${failed} 台没拉动）`
          : round.note || "上一轮网格同步没有报错",
        next: failed > 0 ? "点一次「立即同步」再试；仍失败就看上面逐台那几项" : "不用处理",
      });
    }
  }

  const counts = countsOf(items);
  const overall = overallOf(counts);
  return { overall, headline: headlineOf(counts, overall), counts, items, peers, at };
}

/** 读数的三档写法：开 / 关 / 未读到（⛔ 不让"读不到"混进"关"）。 */
function switchText(v: boolean | undefined | null): string {
  if (v === true) return "开";
  if (v === false) return "关";
  return READOUT_UNREAD;
}

function countText(v: unknown[] | null | undefined): string {
  return Array.isArray(v) ? `${v.length} 台` : READOUT_UNREAD;
}

function keyText(p: PeerDigest): string {
  if (p.keyChanged === true) return "变了";
  if (p.keyChanged === false) return "未变";
  return `读不到（${p.keyReason || "无原因码"}）`;
}

/** 诊断包里的原因写成**纯文本**：后端原文可能带行内 Markdown 的 `**`（如 `round.note`），
 *  诊断包是给人贴进聊天框/工单的 ⇒ 只去掉成对标记本身，⛔ 不吞字、⛔ 不改语义。 */
function plainText(s: string): string {
  return s.replace(/\*\*/g, "");
}

/**
 * 「复制诊断包」的纯文本。**纯函数**（只读 `MeshDiagnosis`，不读环境）。
 *
 * ⛔ 不含：`device_id` / 地址（IP）/ 配对秘密 / 页面正文 / 设备名 / 公钥原文。
 * ✅ 含：级别、原因（含原因码）、短标识、端口号、数量、生成时间。
 * 口径见文件头第 3 条（脱敏）。
 */
export function meshDiagnosticText(d: MeshDiagnosis): string {
  const lines: string[] = [
    "连接体检",
    `时间：${new Date(d.at).toLocaleString("zh-CN")}`,
    `结论：${d.headline}`,
    `统计：好 ${d.counts.ok} · 注意 ${d.counts.warn} · 问题 ${d.counts.bad} · 未读到 ${d.counts.unknown}`,
    "",
    "体检项：",
  ];
  for (const it of d.items) {
    lines.push(`[${LEVEL_LABEL[it.level]}] ${it.title}`);
    lines.push(`  原因：${plainText(it.reason)}`);
    // ok 项的"下一步"永远是「不用处理」，写出来只是占行 —— 非 ok 才写（⛔ 不是漏字段）。
    if (it.level !== "ok") lines.push(`  下一步：${it.next}`);
  }
  lines.push("", "设备明细（脱敏：不含设备号、地址与设备名）：");
  if (d.peers.length === 0) {
    lines.push("  这一轮没有可列出的设备");
  } else {
    for (const p of d.peers) {
      lines.push(
        `  设备[${p.index}] 短标识=${p.shortId || "未报"}` +
          ` · 公告端口=${p.announcedPort === null ? "未报" : `:${p.announcedPort}`}` +
          ` · 服务当前空间=${p.servesCurrent ? "是" : "否"}（原因码 ${p.servesReason || "空"}）` +
          ` · 钥匙=${keyText(p)}` +
          ` · 身份材料=${p.hasIdentity ? "已报" : "未报"}`,
      );
    }
  }
  lines.push(
    "",
    "（这份诊断包只含读数与原因码；不含设备号、网络地址、配对秘密或页面内容。）",
  );
  return lines.join("\n");
}

/** 只给测试/调试用的稳定统计（⛔ 界面不摆它）。 */
export function levelCountText(counts: Record<DiagnoseLevel, number>): string {
  return `好 ${counts.ok} · 注意 ${counts.warn} · 问题 ${counts.bad} · 未读到 ${counts.unknown}`;
}

/** ⭐ `switchText` 的公开别名：对话框/测试需要"开/关/未读到"这三档文案时用它（一处实现）。 */
export const diagSwitchText = switchText;

/** ⭐ `countText` 的公开别名（同上：读数三档一处实现）。 */
export const diagCountText = countText;
