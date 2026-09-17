// 共享假 deps —— 三台机器的抽取器单测**共用一套口径**。
//
// 为什么要有它：`vision` / `rasterize` 的假实现如果各写各的，会长成三种口径
// （有人记录调用、有人不记；有人返回固定文字、有人返回拼接）。三份实现迟早对不上，
// 而这层"假实现的分歧"没有任何编译期信号。AMD 侧提议做这份夹具，我这边先落地最小版。
//
// ⚠️ **只被 `*.test.ts` import，不进生产代码路径**（`isolated.test.ts` 会扫这条）。
// ⚠️ 两个假实现都是**确定性**的（同输入同输出）—— 否则用它们的抽取器就测不出确定性。

import { rgbaToPng } from "../../pngEncode";
import type { ExtractDeps, RasterizedPage } from "../types";

export interface VisionCall {
  prompt: string;
  /** 只留长度与前 8 字节，避免把大图记进断言消息 */
  byteLength: number;
  mime: string;
}

export interface FakeVision {
  fn: NonNullable<ExtractDeps["vision"]>;
  calls: VisionCall[];
}

/** 假视觉模型：返回固定文字，并记录每次调用（可断言"每页只调一次"这类不变量）。 */
export function fakeVision(reply: string | ((prompt: string, mime: string) => string)): FakeVision {
  const calls: VisionCall[] = [];
  const fn: NonNullable<ExtractDeps["vision"]> = async (prompt, image, mime) => {
    calls.push({ prompt, byteLength: image.length, mime });
    return typeof reply === "function" ? reply(prompt, mime) : reply;
  };
  return { fn, calls };
}

export interface RasterizeCall {
  byteLength: number;
  pageIndex: number;
  scale: number;
}

export interface FakeRasterize {
  fn: NonNullable<ExtractDeps["rasterize"]>;
  calls: RasterizeCall[];
}

export interface FakeRasterizeOptions {
  /** 渲染多少页可用（pageIndex 超出即 reject，用来测"越界页"的处理）。默认 1。 */
  pages?: number;
  width?: number;
  height?: number;
  /** 这些页号（0 基）渲染时 reject —— 用来测 provider_error 的传播。 */
  rejectOn?: readonly number[];
}

/**
 * 假光栅化：返回**确定性的合法 PNG**（每页像素值 = 页号+1，便于反查"这一页到底渲染了没有"）。
 * `pageIndex` 越界或命中 `rejectOn` 时 reject（模拟原生渲染失败）。
 *
 * ⚠️ 它**用与生产同一份编码器**（`src/lib/pngEncode.ts`）—— 契约要求 `rasterize` 产出**编码图**
 * （`vision` 只接受编码图，见 §15.8 的裁定）。假实现若自己造一份 PNG 逻辑，
 * 就会和生产悄悄脱节，而那正是"共享假实现"要避免的事。
 */
export function fakeRasterize(opts: FakeRasterizeOptions = {}): FakeRasterize {
  const pages = opts.pages ?? 1;
  const width = opts.width ?? 2;
  const height = opts.height ?? 2;
  const rejectOn = new Set(opts.rejectOn ?? []);
  const calls: RasterizeCall[] = [];

  const fn: NonNullable<ExtractDeps["rasterize"]> = async (bytes, pageIndex, scale) => {
    calls.push({ byteLength: bytes.length, pageIndex, scale });
    if (rejectOn.has(pageIndex) || pageIndex < 0 || pageIndex >= pages) {
      throw new Error(`fakeRasterize: 第 ${pageIndex} 页渲染失败`);
    }
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = pageIndex + 1; // R 通道编码页号
      rgba[i * 4 + 3] = 255; // 不透明
    }
    const out: RasterizedPage = {
      bytes: rgbaToPng(rgba, width, height),
      mime: "image/png",
      width,
      height,
    };
    return out;
  };

  return { fn, calls };
}

/** 把若干假依赖合成一个 `ExtractDeps`（`undefined` 的项直接不传，保持"未注入"语义）。 */
export function depsOf(parts: {
  vision?: FakeVision;
  rasterize?: FakeRasterize;
}): ExtractDeps {
  const deps: ExtractDeps = {};
  if (parts.vision) deps.vision = parts.vision.fn;
  if (parts.rasterize) deps.rasterize = parts.rasterize.fn;
  return deps;
}
