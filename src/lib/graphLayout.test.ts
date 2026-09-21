// 关系图布局的**机器判据**（不进 GUI 就能钉住"几秒就稳定"这件事）。
//
// 为什么值得单独测：这组常数只有量出来才知道对不对 —— 上一版（`damping 0.9`、无退火、停止判据
// 用 `maxSpeed<0.03`）实测**永远不收敛**：每帧最大位移到 600 帧都降不到 1px，于是每次都跑满
// 500 帧上限（60fps 下 8.3 秒）然后冻在抖动状态里。下面四条把"能收敛、够快、可复现、不越界"钉死。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANNEAL,
  DEFAULT_MAX_STEP_PX,
  DEFAULT_STABLE_PX,
  maxDisplacement,
  settle,
  tick,
  type LayoutEdge,
  type LayoutNode,
} from "./graphLayout";

const W = 1200;
const H = 800;

/** 与 GraphView 同形的初始布局：环状 + 抖动，**但用确定性伪随机**（判据要求可复现）。 */
function makeGraph(n: number, seed = 1): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const nodes: LayoutNode[] = [];
  const cx = W / 2;
  const cy = H / 2;
  const r = Math.min(W, H) / 2 - 60;
  for (let i = 0; i < n; i++) {
    const a = (i / Math.max(1, n)) * Math.PI * 2;
    nodes.push({
      id: String(i),
      x: cx + Math.cos(a) * r * (0.6 + rnd() * 0.4) + (rnd() - 0.5) * 20,
      y: cy + Math.sin(a) * r * (0.6 + rnd() * 0.4) + (rnd() - 0.5) * 20,
      vx: 0,
      vy: 0,
    });
  }
  const edges: LayoutEdge[] = [];
  for (let i = 0; i < Math.round(n * 1.4); i++) {
    const a = Math.floor(rnd() * n);
    const b = (a + 1 + Math.floor(rnd() * Math.min(12, n - 1))) % n;
    edges.push({ source: String(a), target: String(b), kind: i % 2 ? "belongs" : "link" });
  }
  return { nodes, edges };
}

describe("关系图布局：能收敛、够快、可复现", () => {
  it("最大图（250 节点，就是 MAX_FORCE 上限）在 160 帧内视觉稳定（<0.2px/帧）", () => {
    const { nodes, edges } = makeGraph(250, 250 * 7 + 3);
    const r = settle(nodes, edges, { w: W, h: H });
    expect(r.stable, "应判定为稳定（而不是靠帧数上限兜底）").toBe(true);
    // 60fps 下 160 帧 = 2.7 秒 —— 留一点余量给真机；实测是 90–110 帧。
    expect(r.frames).toBeLessThanOrEqual(160);
  });

  it("同步预热足够快：250 节点的整段收敛在 250ms 内跑完（首帧就能是稳的）", () => {
    const { nodes, edges } = makeGraph(250, 250 * 7 + 3);
    const r = settle(nodes, edges, { w: W, h: H });
    expect(r.ms).toBeLessThanOrEqual(250);
  });

  it("确定性：同一输入跑两遍，位置逐字节一致（布局里不许有 Math.random）", () => {
    const a = makeGraph(120, 99);
    const b = makeGraph(120, 99);
    settle(a.nodes, a.edges, { w: W, h: H });
    settle(b.nodes, b.edges, { w: W, h: H });
    const pos = (ns: LayoutNode[]) => ns.map((n) => [n.id, n.x, n.y]);
    expect(pos(b.nodes)).toEqual(pos(a.nodes));
  });

  it("预热后布局没塌：节点还互相保持距离，且真的铺开（退火别把人挤成一团）", () => {
    for (const n of [100, 250]) {
      const { nodes, edges } = makeGraph(n, n * 7 + 3);
      const r = settle(nodes, edges, { w: W, h: H });
      expect(r.stable, `n=${n} 应收敛`).toBe(true);
      let minD = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
          if (d < minD) minD = d;
        }
      }
      // 实测：n=100 最小间距 38.9px；n=250 是 25.2px（1200×800 画布）。留足余量到 15px。
      expect(minD, `n=${n} 最小间距 ${minD.toFixed(1)}px —— 退火退过头会让节点叠在一起`).toBeGreaterThan(15);
      const xs = nodes.map((x) => x.x);
      const ys = nodes.map((x) => x.y);
      // 实测铺开 882×760（n=100）/ 1054×760（n=250）；要求至少占画布的 55%。
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(W * 0.55);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(H * 0.55);
    }
  });

  it("单帧位移上限真的生效（早期不受力飞出去）", () => {
    const { nodes, edges } = makeGraph(80, 7);
    const before = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    tick(nodes, edges, { w: W, h: H }, { alpha: 1 });
    // 上限 3px；浮点与夹边（clamp 到画面内）允许极小误差。
    expect(maxDisplacement(before, nodes)).toBeLessThanOrEqual(DEFAULT_MAX_STEP_PX + 1e-6);
  });

  it("兜底：稳定阈值设成 0（永远不稳）时也不会超过帧数上限", () => {
    const { nodes, edges } = makeGraph(60, 5);
    const r = settle(nodes, edges, { w: W, h: H }, { stablePx: 0, maxFrames: 40 });
    expect(r.frames).toBe(40);
    expect(r.stable).toBe(false);
  });

  it("常数是本判据的一部分：退火/阈值/上限被改动时这条会提醒你更新读数", () => {
    expect(DEFAULT_ANNEAL).toBe(0.95);
    expect(DEFAULT_STABLE_PX).toBe(0.2);
    expect(DEFAULT_MAX_STEP_PX).toBe(3);
  });
});
