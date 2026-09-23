// 冲刺 S9 · 客户端接线（第一片）的判据：HTTP claim 端口的形状与状态码口径。
//
// 这里要钉死的是"**一个失败到底是哪种失败**"—— 两种必须分得开，混成一种就会出错：
//   · 拿到（granted）        ⇒ 由本机建血统；
//   · **明确没有（200 ＋ `granted:false`）** ⇒ `denied` ⇒ **不许**建（别人先 claim 了），等对端；
//   · 问不到（401/403/5xx/网络） ⇒ 抛 ⇒ 上层归一成 `unavailable` ⇒ **离线照旧能写**（不挡用户）。
//
// ⚠️ 第 42 轮改：**403 从 denied 挪到 unavailable**。服务端把"别人先 claim"表达成 200＋false、
// 把"你不是这个空间的成员/空间没选"表达成 403 —— 把 403 当 denied 会给用户一句错话，还会让这台
// 设备在这一页上永远 `wait-for-remote`（详见 `claimScope.ts` 文件头）。
import { describe, expect, it } from "vitest";
import { claimVerdict } from "./bootstrap";
import { createHttpClaimPort, LINEAGE_CLAIM_PATH, type FetchLike } from "./claimClient";

/** 假 fetch：记录调用，按脚本回状态码/体。 */
function fakeFetch(status: number, body: unknown = {}) {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { impl, calls };
}

describe("冲刺 S9 · HTTP claim 端口", () => {
  it("① `200 {granted:true|false}` ⇒ 原样回布尔；请求形状对（POST/JSON/Bearer/路径/体）", async () => {
    const yes = fakeFetch(200, { granted: true });
    const portY = createHttpClaimPort({
      server: "https://sync.example.com/",
      token: "tk",
      spaceId: "sp1",
      fetchImpl: yes.impl,
    });
    expect(await portY.claim("p1", "devA")).toBe(true);

    expect(yes.calls).toHaveLength(1);
    expect(yes.calls[0].url).toBe(`https://sync.example.com${LINEAGE_CLAIM_PATH}`); // 结尾斜杠被归一
    expect(yes.calls[0].init.method).toBe("POST");
    expect(yes.calls[0].init.headers.authorization).toBe("Bearer tk");
    expect(JSON.parse(yes.calls[0].init.body)).toEqual({ space_id: "sp1", page_id: "p1", device_id: "devA" });

    const no = fakeFetch(200, { granted: false });
    const portN = createHttpClaimPort({ server: "https://s", token: "tk", spaceId: "sp1", fetchImpl: no.impl });
    expect(await portN.claim("p1", "devB")).toBe(false);

    // 缺字段/类型不对 ⇒ **不算拿到**（不静默放行）
    const weird = fakeFetch(200, { granted: "yes" });
    const portW = createHttpClaimPort({ server: "https://s", token: "tk", spaceId: "sp1", fetchImpl: weird.impl });
    expect(await portW.claim("p1", "devC")).toBe(false);
  });

  it("② ★ 401／5xx／没有 token ⇒ **抛** ⇒ 上层归一成 `unavailable`（离线降级：照旧能写）", async () => {
    for (const status of [401, 500, 502]) {
      const f = fakeFetch(status);
      const port = createHttpClaimPort({ server: "https://s", token: "tk", spaceId: "sp1", fetchImpl: f.impl });
      await expect(port.claim("p1", "devA")).rejects.toThrow(/claim 失败/);
      // 上层口径：抛 ⇒ unavailable（**离线那一支**，不是 denied）
      expect(await claimVerdict(port, "p1", "devA")).toBe("unavailable");
    }
    // 没有 token（未登录）也会被服务端 401 ⇒ 同样落 unavailable
    const f = fakeFetch(401);
    const port = createHttpClaimPort({ server: "https://s", token: null, spaceId: "sp1", fetchImpl: f.impl });
    // ⚠️ 顺序：**先真的发一次**，再看请求形状（第一版写反了 ⇒ `f.calls[0]` 是 undefined）
    expect(await claimVerdict(port, "p1", "devA")).toBe("unavailable");
    expect(f.calls[0].init.headers.authorization).toBeUndefined();
  });

  it("③ ★ **403 ⇒ 抛 ⇒ `unavailable`**（不是 denied）：403 是「你不是这个空间的人」，不是「别人先 claim」", async () => {
    const f = fakeFetch(403);
    const port = createHttpClaimPort({ server: "https://s", token: "tk", spaceId: "sp1", fetchImpl: f.impl });
    await expect(port.claim("p1", "devA")).rejects.toThrow(/claim 失败/);
    // ⇒ 决策走「离线临时建」（照旧能写）；`denied`（wait-for-remote）**只**由 200＋false 触发
    expect(await claimVerdict(port, "p1", "devA")).toBe("unavailable");
    // 对照：200 ＋ granted:false 才是 denied —— 两条别混（混了就是第 42 轮那个 bug）
    const no = fakeFetch(200, { granted: false });
    const portNo = createHttpClaimPort({ server: "https://s", token: "tk", spaceId: "sp1", fetchImpl: no.impl });
    expect(await claimVerdict(portNo, "p1", "devA")).toBe("denied");
  });

  it("④ 环境里没有 fetch ⇒ **如实抛**（不静默返回一个「看起来能用」的端口）", async () => {
    const saved = globalThis.fetch;
    // @ts-expect-error 判据里故意把 fetch 拿掉
    delete globalThis.fetch;
    try {
      const port = createHttpClaimPort({ server: "https://s", token: "tk", spaceId: "sp1" });
      await expect(port.claim("p1", "devA")).rejects.toThrow(/没有 fetch/);
    } finally {
      globalThis.fetch = saved;
    }
  });
});
