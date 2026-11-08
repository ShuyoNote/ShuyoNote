// P1「连接体检」的**可机判**那几条 —— 纯函数级（`src/lib/meshDiagnose.ts`）＋ 面板接线级。
//
// 覆盖（任务要求的 ≥5 个场景，逐个钉"原因 ＋ 下一步"）：
//   ① 全好：结论 ok，所有项都有话说；
//   ② 发现层关：结论 bad，且"下一步"明确指向开启开关；
//   ③ 端口不一致：精确到端口号（复用 J9 的同一句话 `portMismatchNotice`）；
//   ④ 对端不服务当前空间：用 `serves_reason` 说清 why（⛔ 不许只写"连不上"）；
//   ⑤ 钥匙变了：结论 warn，下一步指向「重新配对」；
//   ⑥ 读不到（旧构建/Web/命令失败）：结论 unknown，⛔ 不许当"没问题"；
//   ⑦ 复制诊断包：脱敏（⛔ 不含设备号/地址/设备名/公钥），但含短标识/端口/原因码；
//   ⑧ 面板真的挂上了入口与对话框（文本级接线判据，与 `syncPanelMesh.wiring.test.ts` 同一手法）。
//
// ⚠️ 本文件只测纯函数 ＋ 源码接线（不渲染组件）：组件级 DOM 判据要真平台/真读数，
//    这一片的价值在"结论对不对、说没说下一步、诊断包会不会泄漏" ⇒ 纯函数就能钉死。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { LanStatus, MeshRoundReport, NearbyPeer } from "./platform/commands";
import {
  LEVEL_LABEL,
  diagnoseMesh,
  levelCountText,
  meshDiagnosticText,
  portOfBind,
} from "./meshDiagnose";

/** 内部设备号：⛔ 诊断包**绝不许**出现它（脱敏判据的探针）。 */
const DEVICE_ID = "dev-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
/** 设备名：⛔ 同样不许进诊断包（它可能带个人信息）。 */
const DEVICE_NAME = "AMD-书房";
/** 对端地址：⛔ 不许进诊断包（排障也不需要把内网地址发给别人）。 */
const PEER_ADDR = "192.168.43.9";
/** 公钥原文：⛔ 不写进诊断包（它不是秘密，但诊断包没必要带）。 */
const PUBKEY = "ab".repeat(32);

function okPeer(over: Partial<NearbyPeer> = {}): NearbyPeer {
  return {
    device_id: DEVICE_ID,
    device_name: DEVICE_NAME,
    short_id: "2QS2T",
    addr: PEER_ADDR,
    announced_port: 8788,
    spaces: ["space-x"],
    serves_current: true,
    serves_reason: "ok",
    invitable: true,
    pubkey: PUBKEY,
    key_changed: false,
    key_reason: "ok",
    ...over,
  };
}

/** 一份"全好"的 `lan_status`；按需覆盖整块 `mesh` 或 `nearby`。 */
function okStatus(over: Partial<LanStatus> = {}): LanStatus {
  return {
    enabled: true,
    peers: 1,
    kind: "lan",
    line: "同步地址：直连（同一网络） ｜ 附近发现 1 台",
    mesh: {
      enabled: true,
      bind: "0.0.0.0:8788",
      tokenSet: true,
      window: "0.0.0.0:8788",
      served: ["space-x"],
      paired: [],
      note: "网格开着",
      reach: "能被别人拉到 —— 报出去的是枚举到的 http://192.168.43.9:8788",
      announced: "http://192.168.43.9:8788",
    },
    nearby: [okPeer()],
    ...over,
  };
}

const item = (s: ReturnType<typeof diagnoseMesh>, key: string) =>
  s.items.find((i) => i.key === key);

/** 每个场景都跑一遍的通用不变量：每项四个字段都有话说、键唯一、级别只用四档。 */
function expectWellFormed(s: ReturnType<typeof diagnoseMesh>) {
  expect(s.items.length).toBeGreaterThan(0);
  const keys = s.items.map((i) => i.key);
  expect(new Set(keys).size, `体检项的键必须唯一，实得 ${JSON.stringify(keys)}`).toBe(keys.length);
  for (const i of s.items) {
    expect(["ok", "warn", "bad", "unknown"], `级别不认识：${i.level}`).toContain(i.level);
    expect(i.title.trim().length, `「${i.key}」缺标题`).toBeGreaterThan(0);
    expect(i.reason.trim().length, `「${i.key}」缺原因（用户要知道为什么）`).toBeGreaterThan(0);
    expect(i.next.trim().length, `「${i.key}」缺下一步（用户要知道怎么办）`).toBeGreaterThan(0);
  }
  expect(s.counts.ok + s.counts.warn + s.counts.bad + s.counts.unknown).toBe(s.items.length);
  expect(levelCountText(s.counts)).toContain("未读到");
}

describe("体检纯函数 · 场景① 全好", () => {
  it("结论 ok；发现层/窗口/附近/端口/逐台都给出结论，且都有下一步", () => {
    const s = diagnoseMesh(okStatus(), null, { at: 1_700_000_000_000 });
    expectWellFormed(s);
    expect(s.overall, s.headline).toBe("ok");
    expect(s.counts).toEqual({ ok: 8, warn: 0, bad: 0, unknown: 0 });
    expect(s.headline).toContain("没有发现问题");
    for (const key of [
      "discovery",
      "window",
      "nearby",
      "port",
      "peer-1-serves",
      "peer-1-key",
      "peer-1-identity",
      "peer-1-short-id",
    ]) {
      expect(item(s, key), `少了一项：${key}`).toBeTruthy();
      expect(item(s, key)!.level, `「${key}」本该是 ok`).toBe("ok");
    }
    // 显示主体（设备名）只给界面；标题本身不带设备名（脱敏安全）。
    expect(item(s, "peer-1-serves")!.subject).toBe(DEVICE_NAME);
    expect(item(s, "peer-1-serves")!.title).not.toContain(DEVICE_NAME);
    // 窗口那项写的是真端口（来自 mesh.bind，⛔ 不写死）。
    expect(item(s, "window")!.reason).toContain(":8788");
  });
});

describe("体检纯函数 · 场景② 发现层关", () => {
  it("结论 bad；发现层那条说清后果，下一步指向「开启局域网同步」", () => {
    // 用户把「局域网同步」关掉时的形状：发现层关 ＋ 网格那一档也关（`mesh_set_config("", null)` 清掉绑定）。
    const off = okStatus().mesh;
    const s = diagnoseMesh(
      okStatus({
        enabled: false,
        peers: 0,
        nearby: [],
        kind: "",
        mesh: { ...off, enabled: false, bind: null, window: null, announced: null },
      }),
      null,
      { at: 1 },
    );
    expectWellFormed(s);
    expect(s.overall).toBe("bad");
    const d = item(s, "discovery")!;
    expect(d.level).toBe("bad");
    expect(d.reason).toContain("发现层关着");
    expect(d.reason).toContain("局域网同步不会发生");
    expect(d.next).toContain("开启局域网同步");
    // 附近设备：发现层关着 ⇒ 读不到（⛔ 不是"0 台"这个结论）
    const n = item(s, "nearby")!;
    expect(n.level).toBe("unknown");
    expect(n.reason, "⛔ 不许把「发现层关」写成「网段里没人」").toContain("不成立");
    // 窗口也没起来 ⇒ unknown（不是 bad：先修发现层那一条）
    expect(item(s, "window")!.level).toBe("unknown");
  });
});

describe("体检纯函数 · 场景③ 端口不一致", () => {
  it("精确到两端的端口号，下一步指向「高级」里改一致", () => {
    const s = diagnoseMesh(okStatus({ nearby: [okPeer({ announced_port: 47999 })] }), null, { at: 1 });
    expectWellFormed(s);
    const p = item(s, "port-1")!;
    expect(p.level).toBe("warn");
    expect(p.reason).toContain("端口不一致");
    expect(p.reason).toContain("本机 :8788");
    expect(p.reason).toContain("对方 :47999");
    expect(p.next).toContain("「高级」");
    expect(p.next).toContain("端口");
    // 两边一致时不许摆"不一致"（把结论说反比不说更坏）
    const same = diagnoseMesh(okStatus(), null, { at: 1 });
    expect(same.items.some((i) => i.title.includes("不一致"))).toBe(false);
  });

  it("对端没报端口 ⇒ unknown（说「没法比对」，⛔ 不拿本机端口替它凑）", () => {
    const s = diagnoseMesh(okStatus({ nearby: [okPeer({ announced_port: null })] }), null, { at: 1 });
    expectWellFormed(s);
    const p = item(s, "port")!;
    expect(p.level).toBe("unknown");
    expect(p.reason).toContain("没法比对");
  });
});

describe("体检纯函数 · 场景④ 对端不服务当前空间（用原因码说清 why）", () => {
  const cases: Array<{ code: string; level: string; why: string; next: string }> = [
    { code: "peer_not_serving", level: "warn", why: "没报", next: "升级" },
    { code: "mismatch", level: "warn", why: "对不上", next: "同一个空间" },
    { code: "no_secret", level: "warn", why: "配对暗号", next: "配对" },
    { code: "space_deleted", level: "warn", why: "已删", next: "放回来" },
    // 不认识的原因码 ⇒ unknown（没有结论；⛔ 不替它编一个原因）
    { code: "future_code", level: "unknown", why: "不认识", next: "诊断包" },
  ];
  for (const c of cases) {
    it(`serves_reason=${c.code} ⇒ ${c.level}，原因含「${c.why}」，下一步含「${c.next}」`, () => {
      const s = diagnoseMesh(
        okStatus({ nearby: [okPeer({ serves_current: false, serves_reason: c.code })] }),
        null,
        { at: 1 },
      );
      expectWellFormed(s);
      const it0 = item(s, "peer-1-serves")!;
      expect(it0.level).toBe(c.level);
      expect(it0.reason).toContain(c.why);
      expect(it0.next).toContain(c.next);
    });
  }
});

describe("体检纯函数 · 场景⑤ 钥匙变了", () => {
  it("结论 warn；原因说清「与本机记录不一致」，下一步指向「重新配对」", () => {
    const s = diagnoseMesh(
      okStatus({ nearby: [okPeer({ key_changed: true, key_reason: "ok" })] }),
      null,
      { at: 1 },
    );
    expectWellFormed(s);
    expect(s.overall).toBe("warn");
    const k = item(s, "peer-1-key")!;
    expect(k.level).toBe("warn");
    expect(k.title).toContain("钥匙变了");
    expect(k.reason).toContain("不一致");
    expect(k.next).toContain("重新配对");
  });
});

describe("体检纯函数 · 补充：本轮网格读数（可选输入）", () => {
  const report = (over: Partial<MeshRoundReport> = {}): MeshRoundReport => ({
    enabled: true,
    note: "网格：拉了 1 台对端",
    candidates: 1,
    applied: 0,
    peers: [
      { peer: DEVICE_ID, fetched: 0, applied: 0, cursor: 0, superseded: 0, awaiting: 0, error: null },
    ],
    window: "0.0.0.0:8788",
    ...over,
  });

  it("网格没跑 ⇒ unknown；有台没拉动 ⇒ warn，原因里点出台数", () => {
    const off = diagnoseMesh(okStatus(), report({ enabled: false, note: "网格这一档没开" }), { at: 1 });
    expectWellFormed(off);
    expect(item(off, "round")!.level).toBe("unknown");
    expect(item(off, "round")!.next).toContain("立即同步");

    const bad = diagnoseMesh(
      okStatus(),
      report({
        peers: [
          { peer: DEVICE_ID, fetched: 0, applied: 0, cursor: 0, superseded: 0, awaiting: 0, error: "连不上" },
        ],
      }),
      { at: 1 },
    );
    expectWellFormed(bad);
    expect(item(bad, "round")!.level).toBe("warn");
    expect(item(bad, "round")!.reason).toContain("1 台没拉动");
  });

  it("后端原文里的 Markdown 标记不进诊断包（诊断包是纯文本）", () => {
    const s = diagnoseMesh(
      okStatus(),
      // `round_note` 的 Rust 原文带 `**…**`（如「**同名个人空间**」）⇒ 诊断包里要剥掉标记。
      report({ note: "网格：拉了 1 台对端，其中 1 台把**同名个人空间**并进来了" }),
      { at: 1 },
    );
    const text = meshDiagnosticText(s);
    expect(text).not.toContain("**");
    expect(text).toContain("同名个人空间");
  });
});

describe("体检纯函数 · 场景⑥ 读不到（unknown，不许假装正常）", () => {  it("整份读数读不到 ⇒ 只有一条 unknown，且说清怎么办", () => {
    const s = diagnoseMesh(null, null, { at: 1 });
    expect(s.overall).toBe("unknown");
    expect(s.items).toHaveLength(1);
    expect(s.items[0].level).toBe("unknown");
    expect(s.items[0].reason).toContain("没读到");
    expect(s.items[0].next).toContain("重新读取");
    expect(meshDiagnosticText(s)).toContain("连接体检");
  });

  it("对端没报短标识 / 没报身份 / 钥匙读不到 ⇒ 各自 unknown，而不是「没问题」", () => {
    const s = diagnoseMesh(
      okStatus({
        nearby: [
          okPeer({
            short_id: "",
            pubkey: "",
            key_changed: null,
            key_reason: "peer_no_key",
            announced_port: null,
          }),
        ],
      }),
      null,
      { at: 1 },
    );
    expectWellFormed(s);
    expect(s.overall).toBe("unknown");
    expect(item(s, "peer-1-short-id")!.level).toBe("unknown");
    expect(item(s, "peer-1-short-id")!.reason).toContain("短标识");
    expect(item(s, "peer-1-identity")!.level).toBe("unknown");
    expect(item(s, "peer-1-identity")!.reason).toContain("没有公钥");
    const k = item(s, "peer-1-key")!;
    expect(k.level).toBe("unknown");
    expect(k.reason).toContain("没法核对钥匙");
    // ⛔ 读不到不许被算成"没变"（那是一个结论，而这里没有结论）
    expect(k.title).not.toContain("没变");
  });
});

describe("体检纯函数 · 场景⑦ 诊断包脱敏", () => {
  it("含短标识/端口/原因码；⛔ 不含设备号/地址/设备名/公钥", () => {
    const s = diagnoseMesh(okStatus(), null, { at: 1_700_000_000_000 });
    const text = meshDiagnosticText(s);
    expect(text).toContain("连接体检");
    expect(text).toContain(`短标识=2QS2T`);
    expect(text).toContain(":8788");
    expect(text).toContain("原因码 ok");
    expect(text, `⛔ 诊断包泄漏了设备号：${DEVICE_ID}`).not.toContain(DEVICE_ID);
    expect(text, `⛔ 诊断包泄漏了设备名：${DEVICE_NAME}`).not.toContain(DEVICE_NAME);
    expect(text, `⛔ 诊断包泄漏了地址：${PEER_ADDR}`).not.toContain(PEER_ADDR);
    expect(text, "⛔ 诊断包泄漏了公钥").not.toContain(PUBKEY);
    // 每个非 ok 项都要把"下一步"写进诊断包（支持人员需要它）；ok 项不写（不用处理，占行）。
    for (const i of s.items.filter((x) => x.level !== "ok")) {
      expect(text).toContain(`下一步：${i.next}`);
    }
  });
});

describe("体检纯函数 · 小工具", () => {
  it("portOfBind 只认 地址:端口 的最后一段，拆不出来就 null（⛔ 不猜默认端口）", () => {
    expect(portOfBind("0.0.0.0:8788")).toBe(8788);
    expect(portOfBind("[::]:47999")).toBe(47999);
    expect(portOfBind(" 127.0.0.1:1 ")).toBe(1);
    expect(portOfBind("")).toBeNull();
    expect(portOfBind(null)).toBeNull();
    expect(portOfBind(undefined)).toBeNull();
    expect(portOfBind("0.0.0.0")).toBeNull();
    expect(portOfBind("0.0.0.0:0")).toBeNull();
    expect(portOfBind("0.0.0.0:65536")).toBeNull();
    expect(portOfBind("0.0.0.0:abc")).toBeNull();
  });

  it("LEVEL_LABEL 四档都有人话（未知档写「未读到」，⛔ 不写「正常」）", () => {
    expect(LEVEL_LABEL.ok).toBe("好");
    expect(LEVEL_LABEL.warn).toBe("注意");
    expect(LEVEL_LABEL.bad).toBe("问题");
    expect(LEVEL_LABEL.unknown).toBe("未读到");
  });
});

describe("面板接线 · 连接体检（文本级，与 syncPanelMesh.wiring.test.ts 同一手法）", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const panel = read("src/components/SyncPanel.tsx");
  const dialog = read("src/components/MeshDiagnoseDialog.tsx");

  it("入口在「局域网同步」状态卡里：有 testid、有开关、挂上了对话框", () => {
    expect(panel, "面板里没有体检入口 ⇒ 用户找不到这一屏").toContain('data-testid="mesh-diagnose-entry"');
    expect(panel, "入口按钮没有 testid ⇒ 判据/验收点不到它").toContain('data-testid="mesh-diagnose-open"');
    expect(panel, "没有挂对话框 ⇒ 点开是空的").toContain("<MeshDiagnoseDialog");
    // 开关：点入口要真的把 open 置真（⛔ 只挂一个没有 onClick 的按钮 ✗）
    expect(panel).toContain("setMeshDiagnoseOpen(true)");
    // 重新读取只重读 lan_status（⛔ 不许在体检里新开第二条同步路）
    expect(panel).toContain("const reloadLanForDiagnose = async () => {");
    expect(panel).toContain("await api.lanStatus(activeId)");
  });

  it("对话框只摆纯函数的结论（⛔ 组件里不自己判档）＋ 真的提供三个动作", () => {
    expect(dialog).toContain("diagnoseMesh(");
    expect(dialog).toContain("meshDiagnosticText(");
    // ⭐ 后端原文（`round.note`）按行内 Markdown 写 ⇒ 渲染边界必须过 `inlineMd`（⛔ 不许裸渲染 ✗）
    expect(dialog, "原因那一项没过 inlineMd ⇒ 屏上会出现字面 **").toContain("inlineMd(it.reason)");
    expect(dialog).toContain('data-testid="mesh-diagnose-reload"');
    expect(dialog).toContain('data-testid="mesh-diagnose-copy"');
    expect(dialog).toContain('data-testid="mesh-diagnose-close"');
    // 关闭/返回栈：浮层必须登记（否则安卓返回键会直接退出应用 —— check-overlay-registry 的来由）
    expect(dialog).toContain('useOverlayLayer("mesh-diagnose"');
    // ⛔ 可见代码里不许出现内部标识（剥注释后再判：文件头用注释解释这条纪律是允许的）
    const code = dialog
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    for (const id of ["device_id", "space_id", "ws_id", "pair_secret"]) {
      expect(code, `⛔ 对话框可见代码里出现内部标识 ${id}`).not.toContain(id);
    }
    // ⛔ 自己写的 JSX 文案不许用 Markdown 粗体（会在界面上原样显示星号）
    const bold = code.match(/\*\*[^*\n]{1,40}\*\*/g);
    expect(bold, `JSX 文本里出现了 Markdown 粗体：${bold?.[0]}`).toBeNull();
  });
});
