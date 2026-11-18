// ⭐ §13.6 **O1 多设备同步图 —— 数据面第一刀**的可机判判据（纯函数级；⛔ 不渲染组件、⛔ 不碰命令）。
//
// 这一片钉四件事（正好对上 O1 验收判据的四个分句）：
//   ① 每台设备、每个空间、每条边的**最近一次成功 / 落后多少 / 失败原因** —— 用现有读数
//      （`mesh_watermarks` ＋ `list_sync_history`）**只读聚合**，⛔ 不新增命令、⛔ 不联网；
//   ② 「3 台设备时能一眼看出**哪条边断了**」⇒ `counts.down` 与边上的 `reason` 必须点名到序号；
//   ③ 「**每条读数有来源**」⇒ 每格读数带 `source`，且**量不到的**那些格必须进 `missing`
//      （⛔ 不许拿 `null` 冒充「量过、值是 0」）；
//   ④ **读不到 ≠ 0**（空数组 ≠ 没读过）＋ **脱敏**（⛔ 不含空间名/空间 id/设备号/设备名/
//      条目标题/地址/公钥 —— 与 `meshDiagnose.ts` 那张脱敏清单同口径）。
//
// ⚠️ 本片**故意不接线**（红字：用户可见行为变更需 owner 拍板）。所以这里只判纯函数；
//    接线判据等 owner 拍了再补一条 wiring（手法见 `syncPanelMesh.wiring.test.ts`）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { MeshWatermarks, MeshPeerWatermark } from "./platform/commands";
import {
  SYNC_GRAPH_STATUS_TEXT,
  meshSyncGraph,
  meshSyncGraphDiagnosticLines,
  meshSyncGraphText,
  syncGraphRows,
  type SyncHistoryRowLike,
} from "./meshSyncGraph";

/** 空间名：⛔ 绝不许出现在图里（它可能带业务信息）。 */
const SPACE_NAME = "山焦招标-内部";
/** 空间内部 id：⛔ 同上（`INV-UI-copy-no-internal-ids`）。 */
const SPACE_ID = "ws-7f3a9c11-0000-4e2b-9a11-5d6c7e8f9012";
/** 第二条空间的 id／名字（多空间判据用）。 */
const SPACE_ID_2 = "ws-0000aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SPACE_NAME_2 = "产品-路线图";
/** 条目标题：⛔ 不许进图（`items[].title` 是本机正文的标题）。 */
const ITEM_TITLE = "【机密】2027 年定价草案";

function peer(over: Partial<MeshPeerWatermark> = {}): MeshPeerWatermark {
  return { index: 1, cursor: 100, online: true, lastOkAgoMs: 5_000, ...over };
}

function watermarks(peers: MeshPeerWatermark[], localMaxSeq = 100): MeshWatermarks {
  return {
    spaceName: SPACE_NAME,
    localMaxSeq,
    peers,
    onlineCount: peers.filter((p) => p.online === true).length,
    offlineCount: peers.filter((p) => p.online === false).length,
    unknownCount: peers.filter((p) => p.online === null).length,
    note: "口径说明",
  };
}

function historyRow(over: Partial<SyncHistoryRowLike> = {}): SyncHistoryRowLike {
  return {
    ws_id: SPACE_ID,
    ws_name: SPACE_NAME,
    at: 1_700_000_000_000,
    ok: true,
    pushed: 1,
    pulled: 2,
    message: "",
    items: [],
    ...over,
  };
}

const peerEdge = (g: ReturnType<typeof meshSyncGraph>, i: number) =>
  g.edges.find((e) => e.to === `peer-${i}`);

describe("O1 数据面 · 边的状态（哪条边断了）", () => {
  it("3 台：已齐 / 在线但落后 / 离线 ⇒ counts 与每条边的 reason 都对得上序号", () => {
    const g = meshSyncGraph({
      at: 1_700_000_100_000,
      watermarks: watermarks([
        peer({ index: 1, cursor: 100, online: true, lastOkAgoMs: 3_000 }),
        peer({ index: 2, cursor: 97, online: true, lastOkAgoMs: 30_000 }),
        peer({ index: 3, cursor: 100, online: false, lastOkAgoMs: 600_000 }),
      ]),
    });
    expect(g.counts).toEqual({ ok: 1, behind: 1, down: 1, unknown: 0 });
    expect(g.edges).toHaveLength(3);
    expect(peerEdge(g, 1)!.status).toBe("ok");
    expect(peerEdge(g, 2)!.status).toBe("behind");
    expect(peerEdge(g, 3)!.status).toBe("down");
    // 「一眼看出哪条边断了」：断的那条必须在 reason 里点名（序号），而不是只给个总数。
    expect(peerEdge(g, 3)!.reason).toContain("对端 3");
    expect(peerEdge(g, 3)!.reason).toContain("离线");
    // headline 也得说得出断了几条（3 台里 1 条）。
    expect(g.headline).toContain("断 1");
  });

  it("`online: null`（还没有成功记录）⇒ unknown，⛔ 不许当离线，也⛔ 不许当已齐", () => {
    const g = meshSyncGraph({
      watermarks: watermarks([peer({ index: 1, cursor: 0, online: null, lastOkAgoMs: null })]),
      at: 1_700_000_000_000,
    });
    expect(peerEdge(g, 1)!.status).toBe("unknown");
    expect(peerEdge(g, 1)!.reason).toContain("还没有成功记录");
    expect(g.counts).toEqual({ ok: 0, behind: 0, down: 0, unknown: 1 });
  });

  it("落后数 = 本机高水位 − 已收；已收超过本机 ⇒ 0（⛔ 不出负数）", () => {
    const g = meshSyncGraph({
      watermarks: watermarks(
        [
          peer({ index: 1, cursor: 99, online: true }),
          peer({ index: 2, cursor: 105, online: true }),
        ],
        100,
      ),
      at: 1_700_000_000_000,
    });
    expect(peerEdge(g, 1)!.reads.lag.value).toBe(1);
    expect(peerEdge(g, 2)!.reads.lag.value).toBe(0);
    // 已收超过本机不是"已齐"的证据 —— 但也不能写成负数落后；如实标 0 并保持 ok 语义之外的中立说法。
    expect(peerEdge(g, 2)!.reason).toContain("105");
  });

  it("对应位置坏掉（cursor 不是有限数）⇒ 落后读不到 ⇒ 状态 unknown，⛔ 不判已齐", () => {
    const bad = { index: 1, cursor: Number.NaN, online: true, lastOkAgoMs: 1_000 };
    const g = meshSyncGraph({
      watermarks: watermarks([bad as unknown as MeshPeerWatermark]),
      at: 1_700_000_000_000,
    });
    expect(peerEdge(g, 1)!.reads.lag.value).toBeNull();
    expect(peerEdge(g, 1)!.status).toBe("unknown");
    expect(peerEdge(g, 1)!.missing.join(" ")).toContain("落后");
  });
});

describe("O1 数据面 · 每条读数有来源", () => {
  it("逐台那几格都点名来源；逐边延迟这一格永远读不到，且必须进 missing", () => {
    const g = meshSyncGraph({
      watermarks: watermarks([peer({ index: 1 })]),
      at: 1_700_000_000_000,
    });
    const e = peerEdge(g, 1)!;
    const allowed = ["mesh_watermarks", "derived:mesh_watermarks"];
    for (const [name, read] of Object.entries(e.reads)) {
      expect(read.source === null || allowed.includes(read.source), `「${name}」的来源不认识：${read.source}`).toBe(
        true,
      );
      if (read.value === null) {
        expect(read.source, `「${name}」值是 null 却声称有来源`).toBeNull();
      } else {
        expect(allowed, `「${name}」有值却没有来源`).toContain(read.source as string);
      }
    }
    // ⛔ 现有读数里没有"逐边一轮花了多久" —— 不许编，且要在边与全局两处都点名。
    expect(e.reads.latencyMs.value).toBeNull();
    expect(e.missing.join(" ")).toContain("延迟");
    expect(g.missing.join(" ")).toContain("延迟");
  });

  it("对端只能用序号指代（不是稳定 id）：identityBasis 如实标注", () => {
    const g = meshSyncGraph({ watermarks: watermarks([peer({ index: 1 })]), at: 1 });
    const peerNode = g.nodes.find((n) => n.key === "peer-1")!;
    expect(peerNode.identityBasis).toBe("cursor-ordinal");
    expect(g.nodes.find((n) => n.key === "self")!.identityBasis).toBe("self");
  });
});

describe("O1 数据面 · 读不到 ≠ 0", () => {
  it("水位读数整支读不到 ⇒ 一条边都不造、readable 记 false、missing 点名，且⛔ 不说「0 台」", () => {
    const g = meshSyncGraph({ at: 1_700_000_000_000 });
    expect(g.edges).toHaveLength(0);
    expect(g.readable).toEqual({ watermarks: false, history: false });
    expect(g.nodes.map((n) => n.key)).toEqual(["self"]);
    expect(g.missing.join(" ")).toContain("mesh_watermarks");
    expect(g.missing.join(" ")).toContain("list_sync_history");
    // 「没有边」只能读成"读不到"，不能读成"一台都没有/都齐了"。
    expect(g.headline).not.toContain("0 台");
    expect(g.headline).toContain("读不到");
  });

  it("历史是空数组 ≠ 没读过：readable.history 记 true，且⛔ 不写「没有失败」这种结论", () => {
    const g = meshSyncGraph({ history: [], at: 1_700_000_000_000 });
    expect(g.readable.history).toBe(true);
    expect(g.spaces).toHaveLength(0);
    expect(g.headline).toContain("历史里还没有轮次");
    expect(g.headline).not.toContain("没有失败");
  });

  it("水位是空数组 ⇒ 0 台是**真读数**（readable 记 true），与读不到区分开", () => {
    const g = meshSyncGraph({ watermarks: watermarks([]), at: 1 });
    expect(g.readable.watermarks).toBe(true);
    expect(g.edges).toHaveLength(0);
    expect(g.headline).toContain("0 台");
  });
});

describe("O1 数据面 · 逐空间的轮次（失败原因）", () => {
  it("两个空间 ⇒ 两个空间节点，按最近一条记录排序；成功/失败计数与最近失败原文都对", () => {
    const g = meshSyncGraph({
      at: 1_700_000_100_000,
      history: [
        historyRow({ ws_id: SPACE_ID_2, ws_name: SPACE_NAME_2, at: 1_700_000_090_000, ok: false, message: "**对端返回 401**：没通过" }),
        historyRow({ ws_id: SPACE_ID, ws_name: SPACE_NAME, at: 1_700_000_080_000, ok: true, message: "" }),
        historyRow({ ws_id: SPACE_ID, ws_name: SPACE_NAME, at: 1_700_000_070_000, ok: false, message: "连接超时" }),
      ],
    });
    expect(g.spaces).toHaveLength(2);
    expect(g.spaces[0].label).toBe("空间 1");
    // 最近一条记录属于 SPACE_ID_2 ⇒ 它排第一（⛔ 不按 id 排、⛔ 不按名字排）。
    expect(g.spaces[0].rounds).toBe(1);
    expect(g.spaces[0].failCount).toBe(1);
    expect(g.spaces[0].lastFailMessage).toBe("对端返回 401：没通过");
    expect(g.spaces[1].rounds).toBe(2);
    expect(g.spaces[1].okCount).toBe(1);
    expect(g.spaces[1].failCount).toBe(1);
    expect(g.spaces[1].lastFailAt).toBe(1_700_000_070_000);
    expect(g.spaces[1].lastOkAt).toBe(1_700_000_080_000);
  });

  it("空间级失败⛔ 不许挂到某台对端上（逐台边的状态必须与历史无关）", () => {
    const wm = watermarks([peer({ index: 1, cursor: 100, online: true })]);
    const without = meshSyncGraph({ watermarks: wm, at: 1 });
    const with_ = meshSyncGraph({
      watermarks: wm,
      history: [historyRow({ ok: false, message: "对端 1 拉不动" })],
      at: 1,
    });
    expect(with_.edges).toEqual(without.edges);
    expect(without.missing.join(" ")).toContain("逐边失败原因");
  });

  it("窄形状的调用方（行里没有 ws_id/ws_name）⇒ 并成**一个**空间，⛔ 不按行号拆成 N 个（那等于替它们编出独立关系）", () => {
    const g = meshSyncGraph({
      at: 1_700_000_100_000,
      history: [
        { at: 1_700_000_090_000, ok: false, pushed: 0, pulled: 0, message: "超时", items: [] },
        { at: 1_700_000_080_000, ok: true, pushed: 1, pulled: 1, message: "", items: [] },
      ],
    });
    expect(g.spaces).toHaveLength(1);
    expect(g.spaces[0].rounds).toBe(2);
    expect(g.spaces[0].okCount).toBe(1);
    expect(g.spaces[0].failCount).toBe(1);
    // 排第一的仍然是**最近**那条记录所属的桶（这里是同一桶）。
    expect(g.spaces[0].lastFailAt).toBe(1_700_000_090_000);
  });
});

describe("O1 数据面 · 脱敏（⛔ 不含空间名/id/设备号/设备名/条目标题）", () => {
  it("结构与文本里都不许出现这些串", () => {
    const g = meshSyncGraph({
      at: 1_700_000_100_000,
      watermarks: watermarks([
        peer({ index: 1, cursor: 100, online: true }),
        peer({ index: 2, cursor: 3, online: false }),
      ]),
      history: [
        historyRow({
          ok: false,
          // ⚠️ 后端原文按 O2 的口径原样进图（只去 `**`）—— 所以这条消息里**不**放标题；
          //    下面 `items[].title` 才是本片真正要钉住的那一格（⛔ 图里一行都不许读它）。
          message: "连接超时",
          items: [
            { entity: "page", entity_id: "pg-1", op: "update", dir: "in", title: ITEM_TITLE },
          ],
        }),
      ],
    });
    const dump = JSON.stringify(g) + "\n" + meshSyncGraphText(g);
    for (const secret of [SPACE_NAME, SPACE_ID, SPACE_NAME_2, SPACE_ID_2, ITEM_TITLE]) {
      expect(dump.includes(secret), `图里泄漏了：${secret}`).toBe(false);
    }
  });

  it("文本形态：逐台逐空间都写出来，并且把量不到的东西列在最后", () => {
    const g = meshSyncGraph({
      at: 1_700_000_100_000,
      watermarks: watermarks([peer({ index: 1, cursor: 98, online: true })]),
      history: [historyRow({ ok: true })],
    });
    const text = meshSyncGraphText(g);
    expect(text).toContain("对端 1");
    expect(text).toContain("空间 1");
    expect(text).toContain("落后 2");
    expect(text).toContain("这一版量不到");
  });

  it("诊断包段落（唯一实现）：有结论/逐台/逐空间，但⛔ 不列 missing 全文、也不跟 O2 两段撞标题", () => {
    const g = meshSyncGraph({
      at: 1_700_000_100_000,
      watermarks: watermarks([peer({ index: 1, cursor: 98, online: true })]),
      history: [historyRow({ ok: true })],
    });
    const lines = meshSyncGraphDiagnosticLines(g);
    const text = lines.join("\n");
    expect(text).toContain("结论：");
    expect(text).toContain("对端 1：behind");
    expect(text).toContain("各空间轮次");
    expect(text).toContain("空间 1");
    // 独立版里那些长句只属于独立版：诊断包里一句「本包没有」就够。
    expect(text).not.toContain("这一版量不到");
    expect(text).toContain("本包没有");
    // 与 O2 已有的两段标题撞车 ⇒ 会让 O2 那两条 `not.toContain(...)` 判据假红。
    expect(text).not.toContain("水位矩阵");
    expect(text).not.toContain("最近同步轮次");
    // ⛔ 逐台边永远不给"逐边失败原因"（历史是空间级的），要写清没有。
    expect(text).toContain("逐边失败原因");
  });
});

// ⭐ §13.6 O1 第二刀（owner 2026-11-18 拍「在同步面板上真画出来」）：
// 面板那几行**只能**由 `syncGraphRows()` 出 —— 组件不许自己判 online/lag（两份真相源）。
describe("O1 面板行（syncGraphRows）", () => {
  it("四档各自有中文词与颜色档（⛔ 不把英文状态码显示给用户）", () => {
    const g = meshSyncGraph({
      at: 1_700_000_100_000,
      watermarks: watermarks([
        peer({ index: 1, cursor: 100, online: true }),
        peer({ index: 2, cursor: 97, online: true }),
        peer({ index: 3, cursor: 100, online: false }),
        peer({ index: 4, cursor: 0, online: null, lastOkAgoMs: null }),
      ]),
    });
    const rows = syncGraphRows(g);
    expect(rows.map((r) => r.status)).toEqual(["ok", "behind", "down", "unknown"]);
    expect(rows.map((r) => r.statusText)).toEqual(["已齐", "落后", "断了", "未知"]);
    expect(rows.map((r) => r.level)).toEqual(["ok", "warn", "bad", "unknown"]);
    for (const r of rows) {
      expect(r.label).toBe(`对端 ${r.key.split("peer-")[1]}`);
      expect(r.detail).toContain("已收");
      expect(r.detail).toContain("最近成功");
      // ⛔ 英文状态码/设备号不许出现在给用户看的字段里
      expect([r.label, r.statusText, r.detail].join(" ")).not.toContain(r.status);
    }
  });

  it("落后几条写进 detail；读不到就写「未读到」而⛔ 不写 0", () => {
    const g = meshSyncGraph({
      at: 1_700_000_100_000,
      watermarks: watermarks([peer({ index: 1, cursor: 98, online: true })]),
    });
    expect(syncGraphRows(g)[0].detail).toContain("落后 2");
    const bad = meshSyncGraph({
      at: 1_700_000_100_000,
      watermarks: watermarks([
        { index: 1, cursor: Number.NaN, online: true, lastOkAgoMs: 1_000 } as unknown as MeshPeerWatermark,
      ]),
    });
    const row = syncGraphRows(bad)[0];
    expect(row.statusText).toBe("未知");
    expect(row.detail).toContain("未读到");
    expect(row.detail).not.toContain("落后 0");
  });

  it("状态词表只有那四个（判据按它取；改词会先红在这一条）", () => {
    expect(SYNC_GRAPH_STATUS_TEXT).toEqual({ ok: "已齐", behind: "落后", down: "断了", unknown: "未知" });
  });
});

// ⭐ §13.6 O1 第二刀的**接线判据**（文本级，与 `syncPanelMesh.wiring.test.ts` 同一手法）：
// 面板只负责摆，状态/读数一律来自纯函数 —— 这条钉的是"没有第二份判断"。
describe("O1 接线 · 同步面板", () => {
  const panel = readFileSync(resolve(process.cwd(), "src/components/SyncPanel.tsx"), "utf8");

  it("面板用纯函数算图、用行渲染，并且有可供验收点到的 testid", () => {
    expect(panel, "面板没拿这两支读数算图").toContain("meshSyncGraph({ watermarks, history })");
    expect(panel, "面板没走唯一的行生成处").toContain("syncGraphRows(meshGraph)");
    expect(panel, "没有图容器 testid ⇒ 验收/判据点不到它").toContain('data-testid="mesh-sync-graph"');
    expect(panel, "没有逐行 testid ⇒ 数不出几台/哪条断了").toContain(
      'data-testid="mesh-sync-graph-row"',
    );
    expect(panel, "没有汇总 testid ⇒ 折叠时看不到「断 N」").toContain(
      'data-testid="mesh-sync-graph-summary"',
    );
  });

  it("旧的自判句子已经退役（⛔ 同一屏两套状态口径）", () => {
    expect(panel, "面板里还留着 `p.online === true` 自判 ⇒ 两份真相源").not.toContain("p.online === true");
    expect(panel, "面板里还留着旧的「已收至」拼句").not.toContain("已收至");
  });

  // ⭐ owner 2026-11-18 拍：「没有对端水位时也要说一声」（原来整块不显示 ⇒ 用户看不到这块东西）
  it("空状态：没有对端水位时那块**照样显示**，并写一行「还没有对端水位」", () => {
    // ① 显示条件**不再要求有行**（否则没数据就整块消失 —— 那正是 owner 说"看不到"的原因）
    expect(panel, "显示条件里还带着 meshGraphRows.length > 0 ⇒ 没数据时整块消失").not.toContain(
      "meshGraph.readable.watermarks && meshGraphRows.length > 0",
    );
    expect(panel, "显示条件应只看「水位读得到」").toContain(
      "{watermarks && meshGraph.readable.watermarks && (",
    );
    // ② 空状态那一行必须在，且说得清"没和任何设备成功同步过"（⛔ 不许只写"暂无数据"）
    expect(panel, "没有空状态文案 ⇒ 空着一块会让人以为坏了").toContain("这个空间还没有对端水位");
    expect(panel, "空状态要给出原因（没成功同步过）").toContain("没和任何设备成功同步过");
  });
});
