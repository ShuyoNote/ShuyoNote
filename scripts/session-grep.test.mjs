// `scripts/session-grep.mjs` 的测试 —— 钉住那个**静默失败**。
//
// 为什么这个测试值得存在：2026-09-12 我一度得出"百度 SEO 从没做过"的结论，因为搜会话得到
// **零命中**。真因是会话文件是**多帧 zstd 拼接**，而 `zstdDecompressSync(buf)` 只解第一帧、
// **且不抛错** —— 4.6 MB 的文件"成功"解出 196 字符，搜索在一个 0.004% 的内容上跑。
//
// `decompressMaybeMultiFrame` 的"按魔数切帧"就是修法。这个测试**先证明单帧 API 确实会漏**，
// 再证明我们的实现不漏 —— 前半条是重点：它让"为什么必须切帧"变成可执行的证据，
// 而不是一段注释里的说法。
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { collectSessionFiles, decompressMaybeMultiFrame } from "./session-grep.mjs";

/** 造一个"多帧拼接"的 zstd 缓冲：把几段文本各自压成一帧再拼起来（模拟 append-only 写入）。 */
function multiFrame(parts) {
  return Buffer.concat(parts.map((p) => zstdCompressSync(Buffer.from(p, "utf8"))));
}

describe("会话记录解压（多帧 zstd）", () => {
  it("单帧 API **确实**只解第一帧且不报错 —— 这就是当初零命中的根因", () => {
    const buf = multiFrame(["第一帧的内容\n", "第二帧的内容\n", "第三帧的内容\n"]);
    const naive = zstdDecompressSync(buf).toString("utf8");
    // 关键：不抛错，但只拿到第一帧 —— "成功"与"完整"不是一回事。
    expect(naive).toContain("第一帧");
    expect(naive).not.toContain("第二帧");
    expect(naive).not.toContain("第三帧");
  });

  it("我们的实现解出**所有帧**（关键词在后面的帧里也能搜到）", () => {
    const buf = multiFrame(["第一帧\n", "中间帧\n", "百度 SEO 在这最后一帧里\n"]);
    const { text, frames } = decompressMaybeMultiFrame(buf);
    expect(frames).toBe(3);
    expect(text).toContain("第一帧");
    expect(text).toContain("百度 SEO 在这最后一帧里");
    expect(text.includes("百度")).toBe(true);
  });

  it("**截断的帧**：老 node 安静返回半截、新 node 直接抛 —— 两种都实测过，靠 catch 都不可信", () => {
    // 这条是探针实测出来的、比"多帧只解第一帧"更阴的一层。
    //
    // ★ 2026-09-22 补记（**原判据写的"不抛错"在 node 24.20.0 上已经不成立**）：同一台机器上两份 node
    //   对同一个 31 字节的帧截到 16 字节，读数不同 ——
    //     · node **24.18.1**（DSH 会怀里那份）⇒ **不抛**，安静返回 `这一�`（7 字节，半个汉字）；
    //     · node **24.20.0**（`~/.local` 里那份真 node）⇒ 抛 `Z_BUF_ERROR unexpected end of file`。
    //   原来那条 `expect(...).not.toThrow()` 因此在真 node 上**必然红**（我本轮就是这么撞上的：
    //   同一个文件跑 5 次红 5 次，而全库那一次跑却绿 —— 差别就是 PATH 上哪个 node 在前）。
    // ⇒ 判据不再钉"某个 zlib 版本的实现细节"，只钉两个版本**共同**的那件事：
    //   **截断一定丢数据**（要么半截、要么报错），而"没报错"从来不等于"读全了"。
    const whole = zstdCompressSync(Buffer.from("这一帧会被截断\n", "utf8"));
    let partial = null;
    let err = null;
    try {
      partial = zstdDecompressSync(whole.subarray(0, 16)).toString("utf8");
    } catch (e) {
      err = e;
    }
    if (err) {
      // 新 node：能被 catch 看到，但**这一次是它，下一次未必** —— 所以判据不靠它。
      expect(err).toBeInstanceOf(Error);
      expect(partial).toBe(null);
    } else {
      expect(partial.length).toBeGreaterThan(0); // 有内容
      expect(partial).not.toBe("这一帧会被截断\n"); // 但不完整
    }

    // 我们的实现仍然要把"好帧"完整交给调用方；截断帧贡献的那点残片不影响前后帧。
    const good = zstdCompressSync(Buffer.from("好的一帧\n", "utf8"));
    const buf = Buffer.concat([good, whole.subarray(0, 16), zstdCompressSync(Buffer.from("收尾帧\n", "utf8"))]);
    const { text, frames, brokenFrames } = decompressMaybeMultiFrame(buf);
    expect(frames).toBe(3);
    expect(text).toContain("好的一帧");
    expect(text).toContain("收尾帧");
    // ⚠️ brokenFrames 也**是版本相关的**（老 node 0 / 新 node 1）⇒ 它同样不能当"读全了"的判据：
    //    老 node 上截断帧安静地贡献半个汉字，而这个计数器还是 0。
    //    所以脚本必须汇报"解出多少字符"（那是唯一可信的信号），而不是只报"有没有报错"。
    expect([0, 1]).toContain(brokenFrames);
  });

  it("不是 zstd 的输入按纯文本处理（兼容未压缩的 .jsonl）", () => {
    const { text, frames } = decompressMaybeMultiFrame(Buffer.from('{"a":1}\n', "utf8"));
    expect(frames).toBe(0);
    expect(text).toBe('{"a":1}\n');
  });

  it("零命中之所以危险：解出的字符数会**小得离谱**，那是工具坏了而不是内容为空", () => {
    // 这条把"怎么识别工具坏"固化成断言：单帧解出的字符数远小于真实内容。
    const big = "x".repeat(20000);
    const buf = multiFrame([big, "关键词在这", big]);
    const naiveLen = zstdDecompressSync(buf).toString("utf8").length;
    const realLen = decompressMaybeMultiFrame(buf).text.length;
    expect(realLen).toBeGreaterThan(naiveLen * 2);
    // 所以脚本会汇报"解出 N 字符"——它是判断工具是否可信的第一手信号。
    expect(naiveLen).toBeLessThan(realLen / 2);
  });
});

describe("会话文件收集", () => {
  it("递归收 .jsonl.zstd 与 .jsonl，忽略其它文件", () => {
    const d = mkdtempSync(join(tmpdir(), "sessions-"));
    writeFileSync(join(d, "a.jsonl.zstd"), "");
    writeFileSync(join(d, "b.jsonl"), "");
    writeFileSync(join(d, "c.txt"), "");
    const sub = join(d, "sub");
    // 会话目录结构是 sessions/<project>/<session-id>/session.jsonl.zstd
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "session.jsonl.zstd"), "");
    const found = collectSessionFiles(d).map((f) => f.split(/[\\/]/).pop()).sort();
    expect(found).toEqual(["a.jsonl.zstd", "b.jsonl", "session.jsonl.zstd"]);
  });
});
