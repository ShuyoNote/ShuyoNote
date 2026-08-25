// M22.1 进阶 — pure vector-scene model + SVG export for the drawing block.
// Kept free of platform/api/lexical imports so the smoke harness can bundle it.
// A scene is an ordered list of layers; each layer holds vector shapes drawn in
// WORLD coordinates (unbounded), and a view transform maps world→screen.

export interface Pt {
  x: number;
  y: number;
}

export type Shape =
  | { kind: "pen"; color: string; width: number; points: Pt[]; erase?: boolean }
  | { kind: "line" | "arrow"; color: string; width: number; a: Pt; b: Pt }
  | { kind: "rect" | "ellipse" | "triangle" | "diamond" | "pentagon" | "star"; color: string; width: number; a: Pt; b: Pt }
  | { kind: "text"; color: string; size: number; pos: Pt; text: string }
  | { kind: "image"; x: number; y: number; w: number; h: number; src: string };

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  shapes: Shape[];
}

export interface Scene {
  layers: Layer[];
}

export interface View {
  x: number; // pan (screen px)
  y: number;
  zoom: number;
}

export function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyScene(): Scene {
  return { layers: [{ id: uid(), name: "图层 1", visible: true, shapes: [] }] };
}

export function newLayer(name = "图层"): Layer {
  return { id: uid(), name, visible: true, shapes: [] };
}

const NATURAL_W = 1200;
const NATURAL_H = 800;

// ---- Geometry helpers -------------------------------------------------------
export function normRect(a: Pt, b: Pt) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  return { x, y, w, h };
}

export function polygonPoints(kind: Shape["kind"], a: Pt, b: Pt): Pt[] {
  const r = normRect(a, b);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const rx = r.w / 2;
  const ry = r.h / 2;
  if (kind === "triangle") {
    return [
      { x: cx, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
      { x: r.x, y: r.y + r.h },
    ];
  }
  if (kind === "diamond") {
    return [
      { x: cx, y: r.y },
      { x: r.x + r.w, y: cy },
      { x: cx, y: r.y + r.h },
      { x: r.x, y: cy },
    ];
  }
  if (kind === "pentagon") {
    return Array.from({ length: 5 }, (_, i) => {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      return { x: cx + rx * Math.cos(ang), y: cy + ry * Math.sin(ang) };
    });
  }
  if (kind === "star") {
    const pts: Pt[] = [];
    for (let i = 0; i < 10; i++) {
      const ang = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 === 0 ? 1 : 0.42;
      pts.push({ x: cx + rx * r * Math.cos(ang), y: cy + ry * r * Math.sin(ang) });
    }
    return pts;
  }
  return [];
}

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- Bounds -----------------------------------------------------------------
export function shapeBounds(s: Shape): { x: number; y: number; w: number; h: number } | null {
  if (s.kind === "text") return { x: s.pos.x, y: s.pos.y - s.size, w: s.text.length * s.size * 0.6, h: s.size };
  if (s.kind === "image") return { x: s.x, y: s.y, w: s.w, h: s.h };
  if (s.kind === "pen") {
    if (s.points.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of s.points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  const r = normRect(s.a, s.b);
  return r;
}

/** Bounding box of a whole scene (over visible layers), or null if empty. */
export function sceneBounds(scene: Scene): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;
  for (const layer of scene.layers) {
    if (!layer.visible) continue;
    for (const s of layer.shapes) {
      const b = shapeBounds(s);
      if (!b) continue;
      any = true;
      minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x + b.w);
      minY = Math.min(minY, b.y); maxY = Math.max(maxY, b.y + b.h);
    }
  }
  if (!any) return null;
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

// ---- SVG export -------------------------------------------------------------
function shapeToSvg(s: Shape): string {
  if (s.kind === "text") {
    return `<text x="${s.pos.x}" y="${s.pos.y}" fill="${s.color}" font-size="${s.size}">${esc(s.text)}</text>`;
  }
  if (s.kind === "image") {
    return `<image x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" href="${esc(s.src)}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  const stroke = `stroke="${s.color}" stroke-width="${s.width}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  if (s.kind === "pen") {
    if (s.erase) return "";
    if (s.points.length === 0) return "";
    const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
    return `<path d="${d}" ${stroke}/>`;
  }
  if (s.kind === "line") {
    return `<line x1="${s.a.x}" y1="${s.a.y}" x2="${s.b.x}" y2="${s.b.y}" ${stroke}/>`;
  }
  if (s.kind === "arrow") {
    const ang = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
    const len = Math.max(8, s.width * 3);
    const hx = s.b.x - len * Math.cos(ang - Math.PI / 6);
    const hy = s.b.y - len * Math.sin(ang - Math.PI / 6);
    const hx2 = s.b.x - len * Math.cos(ang + Math.PI / 6);
    const hy2 = s.b.y - len * Math.sin(ang + Math.PI / 6);
    return `<line x1="${s.a.x}" y1="${s.a.y}" x2="${s.b.x}" y2="${s.b.y}" ${stroke}/><path d="M${s.b.x} ${s.b.y} L${hx} ${hy} M${s.b.x} ${s.b.y} L${hx2} ${hy2}" ${stroke}/>`;
  }
  if (s.kind === "rect") {
    const r = normRect(s.a, s.b);
    return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" ${stroke}/>`;
  }
  if (s.kind === "ellipse") {
    const r = normRect(s.a, s.b);
    return `<ellipse cx="${r.x + r.w / 2}" cy="${r.y + r.h / 2}" rx="${r.w / 2}" ry="${r.h / 2}" ${stroke}/>`;
  }
  const pts = polygonPoints(s.kind, s.a, s.b);
  if (pts.length === 0) return "";
  const pstr = pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  return `<polygon points="${pstr}" ${stroke}/>`;
}

export interface SvgOutput {
  svg: string;
  width: number;
  height: number;
  viewBox: string;
}

/** Vector-export the visible scene to an SVG string (all shapes, layered order). */
export function sceneToSvg(scene: Scene): SvgOutput {
  const bounds = sceneBounds(scene) ?? { x: 0, y: 0, w: NATURAL_W, h: NATURAL_H };
  const pad = 16;
  const x = bounds.x - pad;
  const y = bounds.y - pad;
  const w = bounds.w + pad * 2;
  const h = bounds.h + pad * 2;
  const body: string[] = [];
  for (const layer of scene.layers) {
    if (!layer.visible) continue;
    for (const s of layer.shapes) {
      const el = shapeToSvg(s);
      if (el) body.push(el);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">${body.join("")}</svg>`;
  return { svg, width: w, height: h, viewBox: `${x} ${y} ${w} ${h}` };
}

/** Fit a view so the scene content frames nicely in a viewport of `vp` px. */
export function fitView(scene: Scene, vp: { w: number; h: number }): View {
  const bounds = sceneBounds(scene) ?? { x: 0, y: 0, w: NATURAL_W, h: NATURAL_H };
  const pad = 60;
  const bw = Math.max(1, bounds.w);
  const bh = Math.max(1, bounds.h);
  const zoom = Math.min((vp.w - pad * 2) / bw, (vp.h - pad * 2) / bh, 3);
  const z = Math.max(0.05, zoom);
  return {
    zoom: z,
    x: (vp.w - bw * z) / 2 - bounds.x * z,
    y: (vp.h - bh * z) / 2 - bounds.y * z,
  };
}

export { NATURAL_W, NATURAL_H };
