// **判据管道**（Office 导入第一期 · 2026-10-09）。
//
// ## 一条命令（这就是评估文档 §3-⑤ 要的"能机器判"）
//   npx vitest run src/lib/office/retention.test.ts --reporter=verbose
// 它打印：**每个样本的 标题/段落/列表项/图片/表格 保留率 ＋ 耗时**，以及每个坏样本的**可读失败原因** ✓。
//
// ## 分母有两把尺子（两把都量，才不会被自己骗）
//   ① 源 XML 数出来的（`docxToNoteBlocks().source`）⇒ 任何 docx 都能算，含**真实样本** ✓
//   ② 样本**声明的真值** ⇒ 只对合成样本成立，用来抓"分母自己算错"那类错 ✓
//
// ## ⚠️ 真样张那一条**没配就是没查过**（⛔ 不等于通过 ✗）
//   OFFICE_SAMPLES=<目录> npx vitest run src/lib/office/retention.test.ts --reporter=verbose
// 没配时它会**打印一句"本次没查过"**并跳过（与 `src/lib/extract/realSamples.test.ts` 同一纪律 ✓）。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { brokenSamples, officeSamples } from "./sampleDocx";
import { measureOne, measureSamples, renderRetentionReport } from "./retention";
import { importOfficeBytes } from "./importPipeline";

const SAMPLES_DIR = process.env.OFFICE_SAMPLES ?? "";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

describe("Office 导入 · 保留率与耗时（判据管道）", () => {
  const goodRows = measureSamples(officeSamples());
  const broken = brokenSamples();
  const brokenRows = broken.map((b) => measureOne(b.name, b.note, b.bytes));

  it("打印保留率与耗时（一条命令的读数）", () => {
    const report = renderRetentionReport([...goodRows, ...brokenRows]);
    // eslint-disable-next-line no-console
    console.log(`\n${report}\n`);
    expect(report).toContain("保留率与耗时");
    expect(report).toContain("如实失败");
  });

  it("三个合成样本 ⇒ 五类保留率 100%，且与**声明真值**逐类一致", () => {
    for (const row of goodRows) {
      expect(row.ok, `${row.name} 应当转成功，却失败了：${row.code} ${row.message}`).toBe(true);
      expect(
        row.truthMatches,
        `${row.name} 与声明真值不一致：${row.truthDiff.join("；")}`,
      ).toBe(true);
      for (const c of row.categories) {
        if (c.source === 0) continue; // 源里没有这一类 ⇒ 保留率不适用（打印 `—`）
        expect(c.retention, `${row.name} · ${c.label}：${c.converted}/${c.source}`).toBe(1);
      }
    }
  });

  it("⭐ 坏样本必须**可读失败**（这就是「看过它红」：⛔ 不许静默出个空笔记）", () => {
    for (const [index, row] of brokenRows.entries()) {
      const spec = broken[index];
      expect(row.ok, `${spec.name} 竟然"转成功"了 ⇒ 这就是静默空笔记 ✗`).toBe(false);
      expect(row.code, `${spec.name} 缺失败码`).toBeTruthy();
      expect((row.message ?? "").length, `${spec.name} 的失败说明太短，读不出来`).toBeGreaterThan(8);
      if (spec.expectCode) expect(row.code, `${spec.name} 的失败码`).toBe(spec.expectCode);
    }
  });

  it("坏样本在报告里逐条露出名字与原因（不是「没这回事」）", () => {
    const report = renderRetentionReport(brokenRows);
    for (const spec of broken) expect(report).toContain(spec.name);
    expect(report).toContain("没有生成笔记");
    expect(report).toContain("不算通过");
  });

  it("编排层：转换失败 ⇒ **一个页都不建**（且把原因带出来）", async () => {
    let created = 0;
    const outcome = await importOfficeBytes(new Uint8Array(0), "空的.docx", null, {
      createPage: async () => {
        created += 1;
        return "不该被建出来的页";
      },
    });
    expect(outcome.ok).toBe(false);
    expect(created, "转换失败却建了页 ⇒ 静默空笔记").toBe(0);
    if (!outcome.ok) {
      expect(outcome.code).toBe("empty");
      expect(outcome.message).toContain("0 字节");
    }
  });

  it("编排层：图片落库失败 ⇒ 逐张计数 ＋ 说明（不静默丢图）", async () => {
    const full = officeSamples()[1];
    const outcome = await importOfficeBytes(full.bytes, full.name, null, {
      saveImage: async () => {
        throw new Error("附件库写失败（判据用的假通道）");
      },
      createPage: async () => "page-1",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.images.referenced).toBe(full.truth.images);
    expect(outcome.report.images.saved).toBe(0);
    expect(outcome.report.images.failed).toBeGreaterThan(0);
    expect(outcome.report.warnings.some((w) => w.includes("没能存进附件库"))).toBe(true);
  });

  it("编排层：图片落库成功 ⇒ 正文里是 `attachment://<hash>` 引用（内容寻址）", async () => {
    const full = officeSamples()[1];
    let payloadText = "";
    const savedHashes: string[] = [];
    const outcome = await importOfficeBytes(full.bytes, "五类齐全.docx", null, {
      saveImage: async (image) => {
        expect(image.bytes.length).toBeGreaterThan(0);
        expect(image.mime).toBe("image/png");
        savedHashes.push(`hash-${savedHashes.length + 1}`);
        return savedHashes[savedHashes.length - 1];
      },
      createPage: async ({ parentId, title, payload }) => {
        expect(parentId).toBe(null);
        expect(title).toBe("五类齐全");
        payloadText = JSON.stringify(payload);
        return "page-2";
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 五类真的进了 Lexical：标题/列表/表格/图片的文本都在
    expect(payloadText).toContain("2026 年第三季度总结");
    expect(payloadText).toContain("华东区");
    expect(payloadText).toContain("1,200");
    expect(payloadText).toContain("attachment://hash-1");
    expect(payloadText).toContain("heading");
    expect(outcome.report.images.saved).toBe(full.truth.images);
  });
});

describe("Office 真样张（OFFICE_SAMPLES）", () => {
  if (!SAMPLES_DIR) {
    it("未配置 OFFICE_SAMPLES ⇒ 本次**没查过**真样张（⛔ 不是通过）", () => {
      // eslint-disable-next-line no-console
      console.log(
        "  [跳过] 没设 OFFICE_SAMPLES ⇒ 真实 .docx 一个都没跑过。" +
          "跳过 ≠ 通过（要查就：OFFICE_SAMPLES=<目录> npx vitest run src/lib/office/retention.test.ts --reporter=verbose）",
      );
      expect(SAMPLES_DIR).toBe("");
    });
    return;
  }

  const files = SAMPLES_DIR ? walk(SAMPLES_DIR).filter((f) => /\.docx$/i.test(f)) : [];

  it("目录里至少有一个 .docx（否则是路径配错了，不是「没有样张」）", () => {
    expect(files.length, `OFFICE_SAMPLES=${SAMPLES_DIR} 下一个 .docx 都没有`).toBeGreaterThan(0);
  });

  it("逐个真样张打印保留率与耗时（不判内容对不对 —— 那由人看 ✓）", () => {
    const rows = files.map((file) => {
      const bytes = new Uint8Array(readFileSync(file));
      return measureOne(relative(SAMPLES_DIR, file), "真样张：只打印读数，不断言内容", bytes);
    });
    // eslint-disable-next-line no-console
    console.log(`\n${renderRetentionReport(rows)}\n`);
    const lost = rows.filter(
      (r) => r.ok && r.categories.some((c) => c.retention !== null && c.retention < 1),
    );
    // eslint-disable-next-line no-console
    console.log(
      `  [汇总] 真样张 ${rows.length} 个：转成功 ${rows.filter((r) => r.ok).length} 个，` +
        `有类别丢失 ${lost.length} 个，如实失败 ${rows.filter((r) => !r.ok).length} 个（失败也**不是**测试失败 —— 真样张里本来会有加密件/损坏件 ✓）`,
    );
    expect(rows.length).toBe(files.length);
  });
});
