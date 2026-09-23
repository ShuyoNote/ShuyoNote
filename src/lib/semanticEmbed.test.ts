import { describe, expect, it } from "vitest";
import {
  cosineSim,
  embedBody,
  embedHash,
  embedUrl,
  embeddingText,
  normalizeVector,
  vectorRank,
} from "./semanticEmbed";

describe("normalizeVector", () => {
  it("normalizes to unit length", () => {
    const n = normalizeVector([3, 4]);
    expect(n[0]).toBeCloseTo(0.6);
    expect(n[1]).toBeCloseTo(0.8);
  });

  it("returns empty for empty / non-array", () => {
    expect(normalizeVector([])).toEqual([]);
  });

  it("maps a zero vector to zeros", () => {
    expect(normalizeVector([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe("cosineSim", () => {
  it("identical vectors have similarity 1", () => {
    expect(cosineSim([1, 2], [1, 2])).toBeCloseTo(1);
  });

  it("orthogonal vectors have similarity 0", () => {
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for length mismatch / empty", () => {
    expect(cosineSim([1, 2], [1])).toBe(0);
    expect(cosineSim([], [])).toBe(0);
  });
});

describe("vectorRank", () => {
  it("ranks by similarity descending, dropping non-positive", () => {
    const q = [1, 0];
    const docs = [
      { id: "a", vector: [1, 0] }, // sim 1
      { id: "b", vector: [0, 1] }, // sim 0 → dropped
      { id: "c", vector: [0.5, 0.5] }, // sim ~0.707
    ];
    const ranked = vectorRank(q, docs);
    expect(ranked.map((r) => r.id)).toEqual(["a", "c"]);
    expect(ranked[0].score).toBeCloseTo(1);
  });

  it("returns empty for empty query or docs", () => {
    expect(vectorRank([], [{ id: "a", vector: [1] }])).toEqual([]);
    expect(vectorRank([1], [])).toEqual([]);
  });
});

describe("embedUrl / embedBody", () => {
  it("openai uses /v1/embeddings with an array input", () => {
    expect(embedUrl("https://api.example.com/", "openai")).toBe("https://api.example.com/v1/embeddings");
    expect(embedBody("m", "openai", "hi")).toEqual({ model: "m", input: ["hi"] });
  });

  it("ollama uses /api/embed with a bare string", () => {
    expect(embedUrl("http://localhost:11434", "ollama")).toBe("http://localhost:11434/api/embed");
    expect(embedBody("m", "ollama", "hi")).toEqual({ model: "m", input: "hi" });
  });

  it("★ baseUrl 已经带 /v1 时**不再加第二个**（两个真实预设就是这个形状，旧写法得到 …/v1/v1/embeddings ⇒ 404）", () => {
    // 本机 herdsman（owner 拍板"向量模型在本机跑"走它）与 openai 预设
    expect(embedUrl("http://localhost:8080/v1", "openai")).toBe("http://localhost:8080/v1/embeddings");
    expect(embedUrl("https://api.openai.com/v1", "openai")).toBe("https://api.openai.com/v1/embeddings");
    // 大小写/尾斜杠一起收：`/V1/` 也算带了
    expect(embedUrl("http://localhost:8080/V1/", "openai")).toBe("http://localhost:8080/V1/embeddings");
    // 没带 /v1 的老写法仍要正确（回归面不许缩小）
    expect(embedUrl("https://api.example.com", "openai")).toBe("https://api.example.com/v1/embeddings");
    // 空 base 仍然是空串（调用方据此跳过，而不是发一个相对路径出去）
    expect(embedUrl("", "openai")).toBe("");
  });
});

describe("embeddingText / embedHash", () => {
  it("joins title and content and caps content length", () => {
    expect(embeddingText("标题", "正文内容")).toBe("标题 正文内容");
    expect(embeddingText("", "x".repeat(1000)).length).toBeLessThanOrEqual(1 + 500);
  });

  it("embedHash is deterministic and content-sensitive", () => {
    expect(embedHash("abc")).toBe(embedHash("abc"));
    expect(embedHash("abc")).not.toBe(embedHash("abd"));
  });
});
