import { describe, expect, it } from "vitest";

import { imageFileExtension, imageFileName } from "./ImageHover";

describe("笔记图片 · 保存文件名", () => {
  it("① 优先用 alt 里的扩展名；没有就从 mime / src 推", () => {
    expect(imageFileExtension(undefined, "架构图.png")).toBe("png");
    expect(imageFileExtension("image/jpeg", "无扩展名")).toBe("jpg");
    expect(imageFileExtension(undefined, "", "https://x/y.webp?raw=1")).toBe("webp");
    expect(imageFileExtension("image/svg+xml")).toBe("svg");
  });

  it("② 文件名干净：去掉路径分隔符 / 控制字符，空名字回退到 hash", () => {
    expect(imageFileName("a/b:c?.png", "image/png")).toBe("a_b_c_.png");
    expect(imageFileName("", "image/png", "x", "abcdef123456")).toBe("image-abcdef12.png");
    expect(imageFileName(undefined, "image/jpeg")).toBe("image.jpg");
  });
});
