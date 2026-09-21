// 关系图的力导向布局（**纯函数**，从 `GraphView.tsx` 抽出来）。
//
// 为什么抽出来：原来的 `tick()` 藏在组件里，判据只能靠肉眼看 —— 而实测（Node 同参数复刻，
// 见提交信息）暴露出两个只有量出来才知道的事：
//   ① 停止判据 `maxSpeed < 0.03` 在那个力/阻尼组合下**永远达不到** ⇒ 每次都跑满 500 帧上限
//      （60fps 下 8.3 秒，120Hz 屏 4.2 秒 ⇒ 墙钟还随刷新率变）；
//   ② 更要紧的是它**根本没在收敛**：每帧最大位移到 600 帧仍降不到 1px —— 是在平衡点附近**永久抖动**，
//      500 帧后只是"冻在半抖状态"。
//
// 改法（力的公式一个字没动，只加"降温"与"单帧位移上限"）：
//   · **退火**：每帧把全部力乘 `alpha`，`alpha *= anneal`（默认 ×0.95）—— 这是让它真的停下来的关键；
//   · **单帧位移上限** `maxStepPx`（默认 3px）：防止早期受力过大而"飞出去/来回弹"；
//   · **停止判据换成位移口径**：每帧最大位移 < `stablePx`（默认 0.2px，即"肉眼看不出动"）即稳，
//     另有 `alpha < 0.001` 与 `maxFrames` 两道兜底。
//
// 实测（同参数、合成图 n=100/250）：到"每帧 <0.2px" 只需 90–108 帧（60fps 下 1.5–1.8 秒），
// 而这 90–108 帧**同步一次性跑完只要 16–71 ms** ⇒ 可以首帧就已经稳定（`settle` 就是干这个的）。

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
  /** `belongs` 的边长更短（80），其余 150 —— 与原实现一致。 */
  kind?: string;
}

export interface LayoutOptions {
  /** 这一帧的"温度"（力的总乘子）。1 = 全热；`settle` 会逐帧乘 `anneal`。 */
  alpha?: number;
  /** 速度衰减/帧。原实现是 0.9（太快停不下来），实测 .7 收敛最好。 */
  damping?: number;
  /** 每帧位移上限（px）；0 = 不限。 */
  maxStepPx?: number;
  /** 被拖拽的节点：它不动，其余照常受力。 */
  dragId?: string | null;
  /** 被钉住的节点：不动。 */
  pinned?: ReadonlySet<string> | null;
  /** 分组键（同键的节点互相吸引）。返回 null 表示不参与分组。 */
  clusterKey?: ((n: LayoutNode) => string | null) | null;
}

export const DEFAULT_DAMPING = 0.7;
export const DEFAULT_ANNEAL = 0.95;
export const DEFAULT_MAX_STEP_PX = 3;
export const DEFAULT_STABLE_PX = 0.2;
export const DEFAULT_MAX_FRAMES = 500;
/** 退火到这个温度就停手（`0.95^135 ≈ 0.001`）。 */
export const MIN_ALPHA = 0.001;

/** 一帧的力与位移。**不改力的公式**，只让它们整体乘 `alpha`。 */
export function tick(
  ns: LayoutNode[],
  edges: LayoutEdge[],
  size: { w: number; h: number },
  opts: LayoutOptions = {},
): void {
  const alpha = opts.alpha ?? 1;
  const damping = opts.damping ?? DEFAULT_DAMPING;
  const maxStepPx = opts.maxStepPx ?? DEFAULT_MAX_STEP_PX;
  const dragId = opts.dragId ?? null;
  const pinned = opts.pinned ?? null;
  const clusterKey = opts.clusterKey ?? null;
  const nodeById = new Map(ns.map((n) => [n.id, n]));
  const cx = size.w / 2;
  const cy = size.h / 2;
  const isFree = (id: string) => dragId !== id && !(pinned?.has(id) ?? false);

  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      const a = ns[i];
      const b = ns[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        d2 = 1;
        dx = 1;
        dy = 0;
      }
      const d = Math.sqrt(d2);
      const f = (9000 / d2) * alpha;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      if (isFree(a.id)) {
        a.vx += fx;
        a.vy += fy;
      }
      if (isFree(b.id)) {
        b.vx -= fx;
        b.vy -= fy;
      }
    }
  }

  for (const e of edges) {
    const a = nodeById.get(e.source);
    const b = nodeById.get(e.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const ideal = e.kind === "belongs" ? 80 : 150;
    const f = 0.04 * (d - ideal) * alpha;
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    if (isFree(a.id)) {
      a.vx += fx;
      a.vy += fy;
    }
    if (isFree(b.id)) {
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  // 分组力：同组节点互相靠拢（同标签/同属性值成团）。
  if (clusterKey) {
    const groups = new Map<string, { x: number; y: number; count: number }>();
    for (const n of ns) {
      const k = clusterKey(n);
      if (!k) continue;
      const g = groups.get(k) ?? { x: 0, y: 0, count: 0 };
      g.x += n.x;
      g.y += n.y;
      g.count++;
      groups.set(k, g);
    }
    for (const n of ns) {
      if (!isFree(n.id)) continue;
      const k = clusterKey(n);
      if (!k) continue;
      const g = groups.get(k)!;
      if (g.count < 2) continue;
      n.vx += ((g.x / g.count - n.x) * 0.02) * alpha;
      n.vy += ((g.y / g.count - n.y) * 0.02) * alpha;
    }
  }

  for (const n of ns) {
    if (!isFree(n.id)) {
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx = (n.vx + (cx - n.x) * 0.001 * alpha) * damping;
    n.vy = (n.vy + (cy - n.y) * 0.001 * alpha) * damping;
    if (maxStepPx > 0) {
      const sp = Math.hypot(n.vx, n.vy);
      if (sp > maxStepPx) {
        n.vx = (n.vx / sp) * maxStepPx;
        n.vy = (n.vy / sp) * maxStepPx;
      }
    }
    n.x = Math.max(20, Math.min(size.w - 20, n.x + n.vx));
    n.y = Math.max(20, Math.min(size.h - 20, n.y + n.vy));
  }
}

/** 这一帧里**动得最多的那个节点**动了多少 px（稳定判据用的就是它）。 */
export function maxDisplacement(before: ReadonlyMap<string, { x: number; y: number }>, ns: LayoutNode[]): number {
  let m = 0;
  for (const n of ns) {
    const b = before.get(n.id);
    if (!b) continue;
    const d = Math.hypot(n.x - b.x, n.y - b.y);
    if (d > m) m = d;
  }
  return m;
}

export interface SettleResult {
  frames: number;
  /** 是否达到"肉眼看不出动"（每帧位移 < stablePx）。 */
  stable: boolean;
  /** 停手时的温度。 */
  alpha: number;
  ms: number;
}

/**
 * 把布局**同步**跑到稳（用于首帧之前预热；有预算就提前收手）。
 *
 * 返回 `stable=false` 表示预算/帧数用完了还没稳（大图）—— 调用方接手继续跑 rAF 即可。
 */
export function settle(
  ns: LayoutNode[],
  edges: LayoutEdge[],
  size: { w: number; h: number },
  opts: LayoutOptions & { stablePx?: number; maxFrames?: number; anneal?: number; budgetMs?: number } = {},
): SettleResult {
  const stablePx = opts.stablePx ?? DEFAULT_STABLE_PX;
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
  const anneal = opts.anneal ?? DEFAULT_ANNEAL;
  const budgetMs = opts.budgetMs ?? Number.POSITIVE_INFINITY;
  const t0 = Date.now();
  let alpha = opts.alpha ?? 1;
  const before = new Map(ns.map((n) => [n.id, { x: n.x, y: n.y }]));
  let frames = 0;
  let stable = false;
  while (frames < maxFrames && alpha >= MIN_ALPHA) {
    tick(ns, edges, size, { ...opts, alpha });
    alpha *= anneal;
    frames++;
    const moved = maxDisplacement(before, ns);
    for (const n of ns) {
      const b = before.get(n.id);
      if (b) {
        b.x = n.x;
        b.y = n.y;
      }
    }
    if (moved < stablePx) {
      stable = true;
      break;
    }
    if (Date.now() - t0 > budgetMs) break;
  }
  return { frames, stable, alpha, ms: Date.now() - t0 };
}
