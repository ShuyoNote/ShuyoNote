// ⭐ **第 0 片（2026-10-14）**：AI「还没上架」那四件的 ⭐ **可下发清单** ✗（＋ 兜底 ✓）。
//
// ## 这道题是什么
// ⚠️ 今天那份清单**写死在 TS 里**（`AbilitiesPane.tsx` 的 `ABILITIES` ✓，那条注释自己写着
//    「将来搬进 `src/lib/abilities/manifest.json`」✓）⇒ ⭐ 上架一件就得**发一次包** ✗。
// ⇒ 本片把它做成 ⭐ **可下发**：⭐ 从**同一个镜像仓**（`shuyo-mirror` ✓，与 ECDICT 同一个源 ✓）取
//    `manifest.json` ✓，⭐ 解析 ⇒ 用；⭐ **取不到／解析不过 ⇒ 回退到内置那份** ✓（⛔ 不许整屏空白 ✗）。
//
// ## ⭐ 两条不能破（本片最容易破的就是这两条 ✗）
// ① ⭐ **只认真实值** ✓：`path` ／ `sha256` **任缺 ⇒ 那一项不许是 `downloadable`** ✗
//    （⭐ 这一条在**两份**地方都得成立：⭐ 渲染层那颗按钮（`AbilitiesPane.tsx` 里 `if (!a.path || !a.sha256) return;`
//    ✓）＋ ⭐ **本片新加的归一化**（清单里写了 `downloadable` 但缺字段 ⇒ **降级成 `not-available`** ✓
//    —— ⛔ 不许信远端说了算 ✗））；
// ② ⭐ **四件仍须是 `not-available`** ✗ —— ⭐ 它们**没有真实 `path`／`sha256`** ✓ ⇒
//    ⛔ 本片**不许**因为"能下发了"就把它们放出来 ✗（⭐ 那是后续每一件自己的事 ✓）。
//
// ## ⚠️ 本片**不做**什么（⭐ 如实，⛔ 不假装 ✗）
// ⛔ **通用下载器**（contents→blobs 两步 ＋ ⭐ 两道 sha256 ＋ 落盘）**不在本片** ✗ ——
//    ⭐ 它是**下一片**（⭐ 本片只到"清单 ＋ 兜底 ＋ 归一化" ✓）。⇒ ⚠️ 所以本文件里
//    ⭐ **没有**「sha256 不符 ⇒ 拒绝落盘」那条判据 ✗（⭐ 那条属于下载器那一片 ✓）。
//
// ## ⚠️ 不联网
// ⭐ 判据全部用**本地夹具**当"远端" ✓（⭐ `fetchImpl` 由判据注入 ✓ ⇒ 一次网都不出 ✓）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadAbilitiesManifest, parseAbilitiesManifest, type Ability } from "../lib/abilities/manifest";

const PANE_SRC = readFileSync(resolve(__dirname, "AbilitiesPane.tsx"), "utf8");

/** 内置那份（判据自己写一小份 ⇒ ⛔ 不依赖屏里那份真清单 ✗，那条由判据④单独钉 ✓）。 */
const FALLBACK: Ability[] = [
  { id: "office-import", name: "Word 导入（.docx）", summary: "内置", state: "builtin" },
  { id: "layout", name: "版面分析", summary: "识别表格与分栏；模型较大", state: "not-available", note: "还没上架" },
];

/** 造一份"远端返回"（⭐ 形状照 `contents` 那条：base64 在 `content` 里 ✓，`AbilitiesPane.tsx:177` 同一形状 ✓）。 */
function contentsReply(payload: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  const content = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return { ok: true, status: 200, json: async () => ({ encoding: "base64", content }) };
}

const fakeFetch = (res: unknown): typeof fetch =>
  (async () => (typeof res === "function" ? (res as () => never)() : res)) as unknown as typeof fetch;

describe("第 0 片：可下发清单（⛔ 不联网 ✗）", () => {
  it("① ⭐ 清单**能取到并解析** ⇒ 项数与字段正确（今天【红】：没有这个模块 ✓）", async () => {
    const remote = {
      abilities: [
        {
          id: "pdf-engine-win-x64",
          name: "PDF 引擎",
          summary: "按需下载的引擎包",
          bytes: 1234,
          path: "mirror/pdf/pdf-engine-win-x64.zip",
          sha256: "a".repeat(64),
          state: "downloadable",
        },
        { id: "embeddings", name: "本地向量", summary: "离线语义检索", state: "not-available", note: "还没上架" },
      ],
    };
    const got = await loadAbilitiesManifest({ fallback: FALLBACK, fetchImpl: fakeFetch(contentsReply(remote)) });
    expect(got.source, "⭐ 取到并解析成功 ⇒ 用**远端**那份 ✓").toBe("remote");
    // ⭐⭐ **「内置是底」要一起钉住** ✗：⭐ 远端那两条**并上来**、⭐ 内置那两条**一条不许少** ✓
    //   （⚠️ 这条正是 "ECDICT 行为未变" 的机械判据 ✓ —— 上游清单里没有它 ⇒ 它必须还在 ✓）。
    expect(got.abilities.length, "⭐ 内置 2 条 ＋ 远端 2 条 = 4 条 ✓（⛔ 不是整份替换成 2 条 ✗）").toBe(4);
    expect(
      got.abilities.map((a) => a.id),
      "⭐ 内置那两条必须还在（⭐ 顺序也照内置那份 ✓）",
    ).toEqual(["office-import", "layout", "pdf-engine-win-x64", "embeddings"]);
    expect(
      got.abilities.find((a) => a.id === "office-import")?.state,
      "⛔ 远端清单**不许**把内置那条（`office-import`）抹掉 ✗",
    ).toBe("builtin");
    expect(got.abilities.find((a) => a.id === "pdf-engine-win-x64")).toMatchObject({
      id: "pdf-engine-win-x64",
      name: "PDF 引擎",
      bytes: 1234,
      path: "mirror/pdf/pdf-engine-win-x64.zip",
      sha256: "a".repeat(64),
      state: "downloadable",
    });
    expect(
      got.abilities.find((a) => a.id === "embeddings")?.state,
      "⭐ 远端把 `embeddings` 报成 `not-available` ⇒ 照它 ✓（⛔ 本片不放它出来 ✗）",
    ).toBe("not-available");
  });

  it("② 锁（今天已绿 ✓，⛔ 不是本片的修 ✗）：⭐ `path`／`sha256` 任缺 ⇒ ⭐ **不许出现下载按钮**", () => {
    // ⭐ 这一条改前就成立（渲染层那道守卫 ✓）⇒ ⭐ 如实标**锁** ✗。
    expect(
      PANE_SRC,
      "⛔ 渲染层那道守卫不许被拆 ✗（⭐ 缺字段就什么也不做 ✓ —— ⛔ 不许「尽力一试」✗）",
    ).toContain("if (!a.path || !a.sha256) return;");
  });

  it("③ ⭐ **归一化**：清单里自称 `downloadable` 但缺 `path`／`sha256` ⇒ ⭐ 降级成 `not-available`", () => {
    const parsed = parseAbilitiesManifest({
      abilities: [
        { id: "sneaky", name: "自称能下", summary: "缺字段", state: "downloadable" },
        { id: "ok-one", name: "真能下", summary: "字段齐", path: "mirror/x.zip", sha256: "b".repeat(64), state: "downloadable" },
      ],
    });
    expect(parsed, "夹具前提：这份清单本身形状是合法的 ✓").not.toBeNull();
    const byId = new Map(parsed!.map((a) => [a.id, a]));
    expect(
      byId.get("sneaky")?.state,
      "⛔ 远端说 `downloadable` 不算 ✗ —— ⭐ 缺 `path`／`sha256` ⇒ 必须降级成 `not-available` ✓",
    ).toBe("not-available");
    expect(byId.get("ok-one")?.state, "⭐ 字段齐的那条照旧 `downloadable` ✓").toBe("downloadable");
  });

  it("④ 锁（今天已绿 ✓）：那四件的 `state` ⭐ **仍是 `not-available`**（⛔ 本片不许把它们放出来 ✗）", () => {
    for (const id of ["layout", "vlm-ocr", "embeddings", "transcription"]) {
      const at = PANE_SRC.indexOf(`id: "${id}"`);
      expect(at, `⭐ 屏里那一条（\`${id}\`）要在 ✓`).toBeGreaterThan(-1);
      const line = PANE_SRC.slice(at, PANE_SRC.indexOf("\n", at));
      expect(
        line,
        `⛔ \`${id}\` 没有真实 \`path\`／\`sha256\` ⇒ ⭐ 必须还是 \`not-available\` ✗（⛔ 不许"顺手"放出来 ✗）`,
      ).toContain('state: "not-available"');
      expect(line, `⭐ 而且它不该带 \`path\`／\`sha256\` ✓（带了就是假装上架 ✗）`).not.toContain("sha256");
    }
  });

  it("⑤ ⭐ 清单**取不到**（网络错／HTTP 非 200／解析不过）⇒ ⭐ 回退到内置那份（今天【红】✓）", async () => {
    // ⭐ 三种失败**都要**回退（⛔ 不许整屏空白 ✗）
    const boom = fakeFetch(() => {
      throw new Error("network down");
    });
    const got = await loadAbilitiesManifest({ fallback: FALLBACK, fetchImpl: boom });
    expect(got.source, "⭐ 网络错 ⇒ 回退 ✓").toBe("fallback");
    expect(got.abilities, "⭐ 回退的必须是**内置那一份本身** ✓").toEqual(FALLBACK);
    expect(String(got.reason ?? "").trim().length, "⭐ 回退要给一个**人话原因** ✓（⛔ 静默回退 ✗）").toBeGreaterThan(0);

    const http500 = await loadAbilitiesManifest({
      fallback: FALLBACK,
      fetchImpl: fakeFetch({ ok: false, status: 500, json: async () => ({}) }),
    });
    expect(http500.source, "⭐ HTTP 非 200 ⇒ 回退 ✓").toBe("fallback");

    const garbage = await loadAbilitiesManifest({
      fallback: FALLBACK,
      fetchImpl: fakeFetch(contentsReply({ not: "a manifest" })),
    });
    expect(garbage.source, "⭐ 形状不认识 ⇒ 回退 ✓").toBe("fallback");
    expect(garbage.abilities).toEqual(FALLBACK);
  });
});
