// 中继那一格（图⑤「中继：已连上中继 ｜ 剩余 N 天」／图⑧「中继许可证」）· **读数映射**的判据。
//
// 为什么这一层也要判据：owner 的口径是**数字必须来自后端读数** ✗ ——
// 界面**只**许把后端给的那句话摆上去，⛔ 不许自己按天数算、⛔ 不许在读数缺失时编一个数字 ✗。
// 所以这一层唯一该做的事是：**形状守门 ＋ 如实兜底**（缺什么就说什么缺，⛔ 不猜 ✗）。
import { describe, expect, it } from "vitest";

import type { RelayStatus } from "../platform/commands";
import { RELAY_UNREADABLE, relayStatusView } from "./statusView";

/** 造一份"正常"的后端读数（每一条只覆盖自己关心的那几格）。 */
function payload(over: {
  available?: boolean;
  note?: string;
  connection?: Partial<RelayStatus["connection"]>;
  license?: Partial<RelayStatus["license"]>;
}): RelayStatus {
  return {
    available: over.available ?? true,
    note: over.note ?? "",
    configured: true,
    url: "http://127.0.0.1:8899",
    connection: {
      state: "connected",
      label: "已连上中继",
      detail: null,
      checked_at: 1_791_529_632,
      ...over.connection,
    },
    license: {
      state: "ok",
      days_left: 27,
      grace_days_left: null,
      label: "剩余 27 天",
      crossnet_allowed: true,
      // ⭐ 2026-10-11：⭐ 来源两格（⭐ 这条是"验过的正常读数"✓）
      source: "verified",
      refusal: null,
      ...over.license,
    },
  };
}

describe("中继那一格 · 读数映射", () => {
  it("① 后端说几天就显示几天（界面**不**自己算：数字与那句话打架时，以**话**为准）", () => {
    // 后端那句是权威读数；`days_left` 故意写成一个不可能的天数 ⇒ 若界面自己算，这里必红。
    const v = relayStatusView(payload({ license: { days_left: 999, label: "剩余 27 天" } }));
    expect(v.licenseLabel).toBe("剩余 27 天");
    expect(v.licenseReadable).toBe(true);
    expect(v.connectionLabel).toBe("已连上中继");
  });

  it("② 读数缺失 ⇒ 如实说**读不到**（⛔ 不许显示 0 天冒充 ✗）", () => {
    const v = relayStatusView(
      payload({
        license: { state: "missing", days_left: null, grace_days_left: null, label: "", crossnet_allowed: false },
      }),
    );
    expect(v.licenseLabel).toBe(RELAY_UNREADABLE);
    expect(v.licenseReadable).toBe(false);
    expect(v.licenseLabel, "读不到时不许出现任何数字").not.toMatch(/\d/);
    expect(v.licenseLabel).not.toContain("0 天");
  });

  it("②b 连后端读数都没有（null／不可用）⇒ 同样如实说，⛔ 不许当 0 天、⛔ 不许说已连上", () => {
    for (const p of [
      null,
      undefined,
      payload({ available: false, note: "Web 版没有中继这一档 ⇒ 只在桌面版可用" }),
    ]) {
      const v = relayStatusView(p);
      expect(v.licenseLabel).toBe(RELAY_UNREADABLE);
      expect(v.licenseReadable).toBe(false);
      expect(v.connectionLabel, "不许把「读不到」显示成「已连上」").not.toContain("已连上");
      expect(JSON.stringify(v), "整份读数里不许冒出 0 天").not.toContain("0 天");
    }
  });

  it("③「已连上 / 未连上」两句都来自后端（界面不自己判档）", () => {
    expect(relayStatusView(payload({ connection: { state: "unchecked", label: "未连上中继（还没检查）" } })).connectionLabel).toBe(
      "未连上中继（还没检查）",
    );
    // 后端那句**缺了**（形状坏了）⇒ 兜底也**只能**说"未连上"，⛔ 不许说已连上 ✗
    const broken = relayStatusView(payload({ connection: { state: "unreachable", label: "" } }));
    expect(broken.connectionLabel).toContain("未连上中继");
    expect(broken.connectionLabel).not.toContain("已连上");
  });

  it("④ 到期 ⇒ 显示「已到期」，且这一层**没有**任何「禁用本地」的语义", () => {
    const v = relayStatusView(
      payload({
        connection: { state: "refused", label: "未连上中继", detail: "跨网已暂停：已到期" },
        license: { state: "expired", days_left: null, grace_days_left: null, label: "已到期", crossnet_allowed: false },
      }),
    );
    expect(v.licenseLabel).toBe("已到期");
    expect(v.tone).toBe("bad");
    // ⭐ 口径「到期**只**收回跨网」：这一层不许出现任何会动本地数据/功能的开关（那属于别人那一格 ✗）。
    const keys = Object.keys(v).join(",");
    for (const bad of ["disabled", "localLocked", "locked", "readonly", "readOnly"]) {
      expect(keys, `读数映射里不该有「${bad}」这种本地开关`).not.toContain(bad);
    }
  });

  it("⑤ 色调由后端的**状态字**决定，⛔ 不从天数算（所以 0 天既可以是正常也可以是宽限）", () => {
    expect(relayStatusView(payload({ license: { state: "ok", days_left: 0, label: "剩余 0 天" } })).tone).toBe("ok");
    expect(
      relayStatusView(payload({ license: { state: "grace", days_left: 0, grace_days_left: 14, label: "剩余 0 天 · 宽限 14 天" } }))
        .tone,
    ).toBe("warn");
    expect(relayStatusView(payload({ license: { state: "not_yet", label: "还没到生效时间" } })).tone).toBe("muted");
  });

  it("⑥ ⭐ 2026-10-11：**来源**照抄后端（⭐ 验过 ／ ⭐ 占位 ／ ⭐ 拒收 分得开，⛔ 界面不自己判 ✗）", () => {
    // ⭐ 验过 ⇒ 来源是 verified，⭐ 色调仍由**状态字**决定 ✓
    const okRead = relayStatusView(payload({ license: { source: "verified", refusal: null } }));
    expect(okRead.licenseSource).toBe("verified");
    expect(okRead.licenseRefusal).toBe("");
    expect(okRead.tone).toBe("ok");
    // ⭐ 没有签名文本 ⇒ placeholder（⭐ 与"验过"分开 ✓）
    const placeholder = relayStatusView(payload({ license: { source: "placeholder" } }));
    expect(placeholder.licenseSource).toBe("placeholder");
    // ⭐ 验不过 ⇒ refused：⭐ 与"已到期"同一档色调（跨网就是不能用 ✓），
    //    ⛔ 但**不是**"读不到"（⭐ 后端明明给了原因 ✓）
    const refused = relayStatusView(
      payload({
        license: {
          state: "refused",
          days_left: null,
          grace_days_left: null,
          label: "许可证验不过：签发方不在本机信任的名单里",
          crossnet_allowed: false,
          source: "refused",
          refusal: "unknown_kid",
        },
      }),
    );
    expect(refused.tone).toBe("bad");
    expect(refused.licenseSource).toBe("refused");
    expect(refused.licenseRefusal).toBe("unknown_kid");
    expect(refused.licenseLabel).toBe("许可证验不过：签发方不在本机信任的名单里");
    expect(refused.licenseReadable, "拒收也是一条**读数** ⇒ 不是「读不到」").toBe(true);
    // ⛔ 拒收那一档⛔ 不许带天数：⭐ 整份读数里不许冒出"剩余" ✗
    expect(JSON.stringify(refused)).not.toContain("剩余");
    // ⚠️ 形状坏了（后端没给 source）⇒ 空串：⛔ 不许猜成"验过了" ✗
    const nosource = relayStatusView(
      payload({ license: { source: undefined as unknown as string, refusal: undefined as unknown as null } }),
    );
    expect(nosource.licenseSource).toBe("");
    expect(nosource.licenseRefusal).toBe("");
  });
});
