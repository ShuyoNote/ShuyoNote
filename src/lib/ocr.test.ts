import { describe, expect, it, vi, beforeEach } from "vitest";

// 该测试锁定「OCR 失败要能区分阶段」，因为历史上 error 被一律说成
// 「无法加载离线识别模型/语言数据」，把「取图失败」误判为「模型缺失」，
// 排查方向被带偏了好几轮。同时锁定：传 Blob 时不应走 fetch()。

const createWorkerMock = vi.fn();

vi.mock("tesseract.js", () => ({
  createWorker: (...args: unknown[]) => createWorkerMock(...args),
}));

async function loadModule() {
  vi.resetModules();
  return await import("./ocr");
}

beforeEach(() => {
  createWorkerMock.mockReset();
});

describe("ocrRecognize 失败阶段区分", () => {
  it("worker/模型加载失败 → stage=load，并带真实原因", async () => {
    createWorkerMock.mockImplementation((_langs: unknown, _oem: unknown, opts: { errorHandler?: (m: string) => void }) => {
      // 模拟 tesseract 内部：加载 reject 走 errorHandler，且自身 promise 悬挂（静默吞掉）
      opts.errorHandler?.("Failed loading language chi_sim");
      return new Promise(() => {});
    });
    const { createOcrWorker } = await loadModule();
    await expect(createOcrWorker("chi_sim+eng", 60)).rejects.toThrow(/Failed loading language chi_sim/);
  });

  it("识别阶段抛错 → error=error 且 stage=recognize（不是模型问题）", async () => {
    createWorkerMock.mockResolvedValue({
      recognize: vi.fn().mockRejectedValue(new Error("Refused to connect to 'blob:...'")),
      terminate: vi.fn().mockResolvedValue(undefined),
    });
    const { ocrRecognize } = await loadModule();
    const res = await ocrRecognize(new Blob([new Uint8Array([1, 2, 3])]));
    expect(res.error).toBe("error");
    expect(res.stage).toBe("recognize");
    expect(res.detail).toContain("Refused to connect");
  });

  it("成功识别 → error=none 且返回文本", async () => {
    createWorkerMock.mockResolvedValue({
      recognize: vi.fn().mockResolvedValue({ data: { text: "  你好世界  " } }),
      terminate: vi.fn().mockResolvedValue(undefined),
    });
    const { ocrRecognize } = await loadModule();
    const res = await ocrRecognize(new Blob([new Uint8Array([1])]));
    expect(res.error).toBe("none");
    expect(res.text).toBe("你好世界");
  });

  it("传 Blob 时不调用 fetch（避免 CSP connect-src 拦 blob: URL）", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("fetch 不应被调用");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const recognize = vi.fn().mockResolvedValue({ data: { text: "ok" } });
    createWorkerMock.mockResolvedValue({ recognize, terminate: vi.fn().mockResolvedValue(undefined) });

    const { ocrRecognize } = await loadModule();
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const res = await ocrRecognize(blob);

    expect(res.text).toBe("ok");
    expect(fetchSpy).not.toHaveBeenCalled();
    // Blob 原样交给 tesseract（由其内部 FileReader 读取）
    expect(recognize.mock.calls[0][0]).toBe(blob);
    vi.unstubAllGlobals();
  });

  it("空图直接返回 none，不创建 worker", async () => {
    const { ocrRecognize } = await loadModule();
    const res = await ocrRecognize("" as unknown as string);
    expect(res).toEqual({ text: null, error: "none" });
    expect(createWorkerMock).not.toHaveBeenCalled();
  });
});

// 语言包自 2026-09-13 起不随包分发，改成运行时按需下载 + 缓存。这两件事是**耦合的**：
// 一旦来源变成远端而 cacheMethod 还是 "none"（本地模型时代的值），
// 每次 OCR 都会重新下载约 30 MB —— 功能看起来正常，只是慢得莫名其妙。
// 所以这里把"远端来源"与"必须缓存"一起钉住（另一道构建期门禁在 scripts/check-ocr-assets.mjs）。
describe("语言包来源与缓存策略的耦合", () => {
  async function capturedOptions(): Promise<Record<string, unknown>> {
    createWorkerMock.mockResolvedValue({
      recognize: vi.fn().mockResolvedValue({ data: { text: "ok" } }),
      terminate: vi.fn().mockResolvedValue(undefined),
    });
    const { ocrRecognize } = await loadModule();
    await ocrRecognize(new Blob([new Uint8Array([1])]));
    expect(createWorkerMock).toHaveBeenCalled();
    return createWorkerMock.mock.calls[0][2] as Record<string, unknown>;
  }

  it("默认语言包来源是远端 https，且路径**带 tessdata 版本号**（服务端据此长缓存）", async () => {
    const opts = await capturedOptions();
    const p = String(opts.langPath);
    expect(p).toMatch(/^https:\/\//);
    // 路径必须以 /tessdata/<版本> 结尾：没有版本号就不能给 immutable 缓存，
    // 否则换模型时用户会一直跑着旧模型，而且看不出来。
    expect(p).toMatch(/\/tessdata\/\d+\.\d+\.\d+$/);
  });

  it("远端来源必须开缓存（cacheMethod=write）——否则每次 OCR 重下约 30 MB", async () => {
    const opts = await capturedOptions();
    expect(opts.cacheMethod).toBe("write");
  });

  it("gzip 仍为 true（远端给的是 .traineddata.gz，由 tesseract 自己解压）", async () => {
    const opts = await capturedOptions();
    expect(opts.gzip).toBe(true);
  });
});
