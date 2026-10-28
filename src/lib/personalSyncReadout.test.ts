// ⭐ **R176-A（owner 2026-10-28 拍 A）** 的**可机判**那几条 —— 纯函数级：
//   · **J13**：密码自动时**用户无需知道密码也能接入** ＋ ⭐「能读的状态」必须出现走的是哪条路；
//   · **J9**：两端发现参数不一致（端口／网段）⇒ 界面**必须解释原因**（⛔ 只印"连不上" ⇒ 红）；
//   · **J12**：端口预置 ⇒ 首次同步**零手输端口**（这一层只判"端口串怎么拼／什么算不合格"；
//     「默认流程里一个端口输入都没有」那一条在 `src/components/syncPanelPersonalTrust.wiring.test.ts` ✓）；
//   · **⑤**：「不再信任」只停同步、本地数据零字节变化 —— 那一句必须说得出来（文案级）。
//
// ⚠️ 本文件**只测纯函数**（happy-dom 也能跑，但对它没有依赖 ✓）—— 组件级与面板接线级在
//    `src/components/SyncReadout.test.tsx` ／ `src/components/syncPanelPersonalTrust.wiring.test.ts` ✓。
import { describe, expect, it } from "vitest";

import {
  PASSWORD_AUTO_HINT,
  PASSWORD_AUTO_VALUE,
  PORT_ADVANCED_HINT,
  PORT_INVALID_TEXT,
  READOUT_UNREAD,
  ROUTE_DIRECT,
  ROUTE_NOT_OPEN,
  ROUTE_OFF,
  ROUTE_SERVER,
  UNTRUST_LABEL,
  UNTRUST_SCOPE_NOTE,
  countFrom,
  countText,
  discoveryDiagnosis,
  personalSyncReadout,
  portTextToBind,
  readoutCells,
  routeReading,
  type RouteReadings,
} from "./personalSyncReadout";

/** 一句「自己写的界面文案」的检查：⛔ 不许出现 Markdown 的 `**…**` ✗（会在界面上原样显示星号）。
 *  ⚠️ 与 `syncPanelMesh.wiring.test.ts` ⑨c 同源 —— 那条管的是 JSX 文本，这里管的是字符串常量 ✓。 */
function expectNoMarkdownBold(text: string, where: string) {
  expect(text, `⛔ ${where} 里出现了 Markdown 粗体星号（界面会原样显示 ✗）`).not.toMatch(/\*\*[^*\n]{1,40}\*\*/);
}

const baseRoute: RouteReadings = { syncMode: "interval", kind: "lan", meshEnabled: true, bind: "0.0.0.0:8788" };

describe("J13 · 「能读的状态」必须出现走的是哪条路（⛔ 永远不许空着）", () => {
  it("① 每一格真读数都映射到一句人话，且都不是空串", () => {
    // 三种真读数 ＋ 两种"读不到" ＝ 5 个分支，逐个跑
    const cases: Array<{ r: RouteReadings; want: string; why: string }> = [
      { r: { ...baseRoute, syncMode: "off" }, want: ROUTE_OFF, why: "总闸关了 ⇒ 不许说还在同步" },
      { r: { ...baseRoute, kind: "lan" }, want: ROUTE_DIRECT, why: "Rust 判的是 lan ⇒ 设备直连" },
      { r: { ...baseRoute, kind: "" , meshEnabled: true }, want: ROUTE_DIRECT, why: "网格开着 ⇒ 个人版走的就是设备直连" },
      { r: { ...baseRoute, kind: "configured", meshEnabled: false }, want: ROUTE_SERVER, why: "配了服务器地址 ⇒ 服务器那条路" },
      { r: { ...baseRoute, kind: "", meshEnabled: false }, want: ROUTE_NOT_OPEN, why: "两样都没开 ⇒ 还没开通同步" },
      { r: { ...baseRoute, kind: null, meshEnabled: null }, want: READOUT_UNREAD, why: "读数没来 ⇒ 未读到（⛔ 不挑一个看起来正常的档）" },
    ];
    for (const c of cases) {
      const got = routeReading(c.r);
      expect(got, c.why).toBe(c.want);
      expect(got.trim().length, "⭐ J13：「走哪条路」那一格**永远不许空**（空 ⇒ 那条判据就是红）").toBeGreaterThan(0);
    }
  });

  it("② 读不到时**不许**拿「设备直连」冒充（那是结论，不是默认值）", () => {
    // 只给出半边读数（kind 读不到、mesh 也读不到）⇒ 必须如实说未读到
    expect(routeReading({ syncMode: "interval", kind: undefined, meshEnabled: undefined, bind: undefined })).toBe(
      READOUT_UNREAD,
    );
    // 而 mesh 有值（true）时就算 kind 读不到，也说得出来走哪条路（真读数 → 结论）
    expect(routeReading({ syncMode: "interval", kind: null, meshEnabled: true, bind: "0.0.0.0:8788" })).toBe(
      ROUTE_DIRECT,
    );
  });

  it("③ 「服务 N 个空间」／「已信任 N 台」：读不到 ≠ 0（⛔ 不许用 0 冒充没有）", () => {
    expect(countFrom(null)).toEqual({ kind: "unread" });
    expect(countFrom(undefined)).toEqual({ kind: "unread" });
    // ⚠️ 非数组（老构建／Web 档给了个怪东西）也算读不到 —— 与 null 同一把尺
    expect(countFrom("nope" as unknown as readonly unknown[])).toEqual({ kind: "unread" });
    expect(countText(countFrom(null))).toBe(READOUT_UNREAD);
    // 真的空数组才是「一台都没有／一个空间都没服务」
    expect(countFrom([])).toEqual({ kind: "ok", n: 0 });
    expect(countText(countFrom([]))).toBe("0");
    expect(countFrom(["a", "b"])).toEqual({ kind: "ok", n: 2 });
  });

  it("④ 三格的顺序／标签／单位逐字（效果图 ⑦ 那个顺序）", () => {
    const cells = readoutCells({ route: ROUTE_DIRECT, served: { kind: "ok", n: 3 }, trusted: { kind: "ok", n: 2 } });
    expect(cells.map((c) => c.key)).toEqual(["route", "served", "trusted"]);
    expect(cells.map((c) => c.label)).toEqual(["这一轮走的是", "服务", "本机"]);
    expect(cells[0].value).toBe(ROUTE_DIRECT);
    expect(cells[0].unit).toBe("");
    expect(cells[1].value).toBe("3");
    expect(cells[1].unit).toBe("个空间");
    expect(cells[2].value).toBe("2");
    expect(cells[2].unit).toBe("台已信任");
    // 读不到那两格必须显示「未读到」（⛔ 不是 0 ✗）
    const unread = readoutCells({ route: READOUT_UNREAD, served: { kind: "unread" }, trusted: { kind: "unread" } });
    expect(unread[0].value).toBe(READOUT_UNREAD);
    expect(unread[1].value).toBe(READOUT_UNREAD);
    expect(unread[2].value).toBe(READOUT_UNREAD);
  });

  it("⑤ 合成入口：三格全从读数来（⛔ 不在这里补默认值）", () => {
    const r = personalSyncReadout({
      route: baseRoute,
      served: ["s1", "s2"],
      trusted: [{ deviceId: "d1" }],
      discoveryOn: true,
      nearbyCount: 1,
    });
    expect(r.route).toBe(ROUTE_DIRECT);
    expect(r.served).toEqual({ kind: "ok", n: 2 });
    expect(r.trusted).toEqual({ kind: "ok", n: 1 });
    expect(r.diagnosis, "这一轮附近看得见设备 ⇒ 没有「不一致」可说 ⇒ 不许摆诊断句").toBeNull();
    // 读数全缺 ⇒ 三格全部如实「未读到」（⛔ 不编 0）
    const empty = personalSyncReadout({
      route: { syncMode: "interval", kind: null, meshEnabled: null, bind: null },
      served: null,
      trusted: null,
      discoveryOn: false,
      nearbyCount: null,
    });
    expect(empty.route).toBe(READOUT_UNREAD);
    expect(empty.served.kind).toBe("unread");
    expect(empty.trusted.kind).toBe("unread");
    expect(empty.diagnosis).toBeNull();
  });
});

describe("J9 · 两端发现参数不一致 ⇒ 界面必须解释原因（⛔ 不许只印「连不上」）", () => {
  it("① 已信任 2 台、这一轮一台都没出现 ⇒ 必须把原因说出来（含「端口」与「同一网络」）", () => {
    const d = discoveryDiagnosis({ discoveryOn: true, trusted: { kind: "ok", n: 2 }, nearbyCount: 0 });
    expect(d, "⭐ 这个形状下必须有话（J9 的红线就是只剩「连不上」）").toBeTruthy();
    const text = d!;
    expect(text, "必须说出**端口**这条原因（J9 逐字点名）").toContain("端口");
    expect(text, "必须说清是**同一个网络**的问题（J9 逐字点名网段）").toContain("同一个网络");
    expect(text, "必须带上那台数（用户看得出「该出现几台」）").toContain("2");
    // ⛔ 不许只印一句「连不上」（那正是 J9 要消灭的形状）
    expect(text.trim()).not.toBe("连不上");
    expect(text).not.toBe("connection refused");
    expectNoMarkdownBold(text, "J9 的诊断句");
    // ⛔ 不引用内部标识（设备号／地址／暗号一个都不许出现）
    expect(text).not.toMatch(/[0-9a-f]{16,}/i);
  });

  it("② 五种「没什么可说」的形状一律不摆诊断句（⛔ 不许空话常显）", () => {
    expect(discoveryDiagnosis({ discoveryOn: false, trusted: { kind: "ok", n: 2 }, nearbyCount: 0 })).toBeNull();
    expect(discoveryDiagnosis({ discoveryOn: true, trusted: { kind: "ok", n: 0 }, nearbyCount: 0 })).toBeNull();
    expect(discoveryDiagnosis({ discoveryOn: true, trusted: { kind: "ok", n: 2 }, nearbyCount: 1 })).toBeNull();
    expect(discoveryDiagnosis({ discoveryOn: true, trusted: { kind: "unread" }, nearbyCount: 0 })).toBeNull();
    expect(discoveryDiagnosis({ discoveryOn: true, trusted: { kind: "ok", n: 2 }, nearbyCount: null })).toBeNull();
  });
});

describe("J12 · 端口：预置 ＋ 只在高级可改（这一层判拼串与拒收）", () => {
  it("① 合法端口 ⇒ 拼成 Rust 认的 bind 串（地址不变）", () => {
    expect(portTextToBind("0.0.0.0", "8788")).toBe("0.0.0.0:8788");
    expect(portTextToBind("192.168.1.5", " 9000 ")).toBe("192.168.1.5:9000");
    expect(portTextToBind("", "8788"), "缺地址 ⇒ 回落通配（听所有网卡那条后端口径）").toBe("0.0.0.0:8788");
    // 边界：1 与 65535 都合法
    expect(portTextToBind("0.0.0.0", "1")).toBe("0.0.0.0:1");
    expect(portTextToBind("0.0.0.0", "65535")).toBe("0.0.0.0:65535");
  });

  it("② 不合格的端口一律**不拼**（⛔ 别拼一个必然被后端拒的串）", () => {
    for (const bad of ["", " ", "0", "65536", "abc", "80.5", "-1", "１２３"]) {
      expect(portTextToBind("0.0.0.0", bad), `端口 ${JSON.stringify(bad)} 不该被接受`).toBeNull();
    }
    expect(PORT_INVALID_TEXT, "拒收时要有一句可操作的人话（说清范围）").toContain("65535");
  });

  it("③ 高级里那句解释：说清「预置／只在高级改／两端要一致」", () => {
    expect(PORT_ADVANCED_HINT).toContain("预置");
    expect(PORT_ADVANCED_HINT).toContain("高级");
    expect(PORT_ADVANCED_HINT).toContain("不同端口");
    expectNoMarkdownBold(PORT_ADVANCED_HINT, "端口说明");
  });
});

describe("② 同步密码：自动派生 ⇒ 用户不用填、不用知道", () => {
  it("① 那一格的值说清「自动」与「不用你填」", () => {
    expect(PASSWORD_AUTO_VALUE).toContain("自动");
    expect(PASSWORD_AUTO_VALUE).toContain("不用你填");
  });

  it("② 解释里说清「配对时自动交换」且不出现密码值／长度（⛔ 不许把密码摆到界面上）", () => {
    expect(PASSWORD_AUTO_HINT).toContain("自动");
    expect(PASSWORD_AUTO_HINT).toContain("不用知道");
    // ⛔ 不许出现任何像"密码本身"的东西：长度／字符集／十六进制串
    expect(PASSWORD_AUTO_HINT).not.toMatch(/\b\d{2,}\s*位/);
    expect(PASSWORD_AUTO_HINT).not.toMatch(/[0-9a-f]{16,}/i);
    expectNoMarkdownBold(PASSWORD_AUTO_HINT, "密码说明");
  });
});

describe("⑤ 「不再信任」：语义写在按钮旁（只停止同步 ＋ 本地数据一个字节都不动）", () => {
  it("① 按钮上的词是 owner 逐字给的那个", () => {
    expect(UNTRUST_LABEL).toBe("不再信任");
  });

  it("② 按钮旁那句必须同时说清两个承诺", () => {
    expect(UNTRUST_SCOPE_NOTE).toContain("只停止同步");
    expect(UNTRUST_SCOPE_NOTE).toContain("一个字节都不动");
    // 旧词也点一句（用户／文档里两套叫法都对得上）——这也让既有那条判据（认「撤销配对」）
    // 仍然钉在一个**用户看得见**的位置上 ✓
    expect(UNTRUST_SCOPE_NOTE).toContain("撤销配对");
    expectNoMarkdownBold(UNTRUST_SCOPE_NOTE, "解除语义那句");
  });
});
