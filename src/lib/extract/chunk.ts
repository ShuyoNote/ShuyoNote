// 分块（P2 前半）—— 把"段"（`attachment_text`）/ 页面正文切成可检索的 `chunks`。
// 契约与取舍见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §8 P2 / §6.1。
//
// ## 为什么必须分块（这是 P2 存在的原因）
// 现有嵌入口径是 `embeddingText = 标题 + content.slice(0, EMBED_TEXT_CAP=500)`：
// **一份 50 页制度，只有前 500 字进得了向量 —— 等于只索引了封面**。
// 用户问"第 37 条怎么规定的"，语义检索永远答不上来，因为第 37 条从来没被索引过。
// 所以：**先把文本切成块，再逐块嵌入**，检索单位从"页"变成"块"。
//
// ## 分块口径（P2 的既定值：300–800 字、带重叠、保留 loc）
// - **目标 500 字、硬上限 800 字**：块太大则一块里混了多个主题（召回变糊），太小则丢上下文。
// - **重叠 80 字**：块边界会切断句子/论证，重叠让"跨边界的那句话"在两块里都完整存在。
// - **保留 `loc`**：每块取自哪一段/哪一页必须能带回去，否则 AI 说"依据是 X"时无法回链。
// - **重叠前缀不含在 `loc` 里**：`loc` 记的是本块**主体**的起点（重叠是从上一块借来的上下文）。
//
// ## ⚠️ §13 待拍板第 5 项（分块参数是否按语言区分）我**没有**擅自实现
// `lang` 字段**照实记录**（检测口径见 `detectLang`），但**策略目前不随语言变化**：
// 中英混排到底要不要两套参数，需要真实语料测过才有结论，凭感觉分两套只会更难解释。
// ⇒ 这里只留一个**单一策略**，等那一项拍板后再按 `lang` 分派。

import { fnv1a32 } from "../hash";

export interface Chunk {
  id: string;
  pageId: string | null;
  attId: string | null;
  /** 同一 owner 内的序号，从 0 递增。 */
  ord: number;
  /** 本块**主体**的起点定位（重叠前缀不计入）。 */
  loc: string;
  lang: string;
  text: string;
  hash: string;
}

export type ChunkOwner =
  | { kind: "attachment"; attId: string }
  | { kind: "page"; pageId: string };

export interface ChunkPolicy {
  /** 目标块大小（字）；小块会尽量往这个值上凑。 */
  target: number;
  /** **硬上限**：任何一块都不超过它。 */
  max: number;
  /** 低于它就在收尾时尝试与上一块合并（避免末尾碎片）。 */
  min: number;
  /** 相邻块之间的重叠字数。 */
  overlap: number;
}

/**
 * 默认策略。⚠️ **这是"待拍板期间的建议值"**，不是测出来的最优值：
 * `target/max` 取自方案 P2 写的"300–800 字"；`overlap = 80` 是我定的默认（约 target 的 16%），
 * `min = 300` 对应"300–800"的下界，且**只在收尾时软性生效**（短文档不可能被凑到 300）。
 */
export const DEFAULT_CHUNK_POLICY: ChunkPolicy = {
  target: 500,
  max: 800,
  min: 300,
  overlap: 80,
};

/** 句末/段末边界（中英混排都用得上）。 */
const BOUNDARY = /[。！？；!?;\n]/;

/**
 * 记录块的语言倾向。**只记录、目前不改变策略**（§13 第 5 项未拍板）。
 * 口径保守：认不出来就返回 `""`，**不猜**。
 */
export function detectLang(text: string): string {
  let cjk = 0;
  let latin = 0;
  let total = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    total++;
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x3040 && c <= 0x30ff)) {
      cjk++;
    } else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
      latin++;
    }
  }
  if (total === 0) return "";
  if (cjk / total >= 0.2) return "zh";
  if (latin / total >= 0.5) return "latin";
  return "";
}

/** 切成句子（保留边界字符与紧随的空白）。 */
function sentences(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    buf += text[i];
    if (BOUNDARY.test(text[i])) {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) buf += text[j++];
      i = j - 1;
      out.push(buf);
      buf = "";
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

/**
 * **主体预算** = `max − overlap`。
 *
 * ⚠️ 这是被测试逼出来的：我第一版让主体 ≤ `max`，然后加上重叠前缀 ——
 * 结果最终文本 **878 > 800**，硬上限直接被冲破。
 * 硬上限是对**最终文本（含重叠前缀）**说的（那才是被嵌入、被 AI 读到的字符串），
 * 所以主体的预算必须先把重叠的位置扣掉。
 */
function bodyCap(policy: ChunkPolicy): number {
  return Math.max(1, policy.max - Math.max(0, policy.overlap));
}

/** 单个超长文本 → 若干不超过**主体预算**的片段（优先在句边界切）。 */
export function splitLongText(text: string, policy: ChunkPolicy = DEFAULT_CHUNK_POLICY): string[] {
  const cap = bodyCap(policy);
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    const t = buf.trim();
    if (t.length > 0) out.push(t);
    buf = "";
  };
  for (const s of sentences(text)) {
    if (s.length > cap) {
      // 单句就超预算（例如一整个没有标点的长段/一张宽表）：**只能硬切**，
      // 没有更好的边界可用。硬切至少保证"不超上限"这条硬约束成立。
      flush();
      for (let i = 0; i < s.length; i += cap) {
        const piece = s.slice(i, i + cap).trim();
        if (piece.length > 0) out.push(piece);
      }
      continue;
    }
    if (buf.length + s.length > cap) flush();
    buf += s;
  }
  flush();
  return out;
}

interface Atom {
  text: string;
  loc: string;
}

function atomize(
  segments: readonly { text: string; loc: string }[],
  policy: ChunkPolicy,
): Atom[] {
  const cap = bodyCap(policy);
  const out: Atom[] = [];
  for (const s of segments) {
    const t = String(s.text ?? "").trim();
    if (t.length === 0) continue;
    if (t.length <= cap) {
      out.push({ text: t, loc: s.loc ?? "" });
      continue;
    }
    // 切成多片时，**只有第一片继承原 loc**：后面几片没有更细的定位可用，
    // 给它们编一个"看起来像定位"的东西比留空更糟（契约 §15.3-4：loc 要能回链）。
    const pieces = splitLongText(t, policy);
    pieces.forEach((p, i) => out.push({ text: p, loc: i === 0 ? (s.loc ?? "") : "" }));
  }
  return out;
}

const joinAtoms = (atoms: readonly Atom[]): string => atoms.map((a) => a.text).join("\n");

/** 取上一块末尾若干字作为重叠前缀，尽量从**句子/空白边界**起，避免以半个词开头。 */
export function overlapTail(prev: string, n: number): string {
  if (n <= 0 || prev.length === 0) return "";
  const raw = prev.slice(-n);
  // 收集所有"边界之后"的位置（且不能是末尾本身，否则切完是空串）
  const ends: number[] = [];
  const re = /[。！？；!?;\n]\s*|\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const end = m.index + m[0].length;
    if (end < raw.length) ends.push(end);
  }
  if (ends.length === 0) return raw; // 整段没有任何边界（例如纯中文无标点）：只能原样
  // 选**第一个不丢太多内容**的边界：至少留下 30% 的长度，否则说明那个边界太靠前
  const floor = Math.max(4, Math.floor(n * 0.3));
  const pick = ends.find((e) => raw.length - e >= floor) ?? ends[ends.length - 1];
  return raw.slice(pick);
}

/** 把若干段切成块（附件路径）。 */
export function chunkSegments(
  owner: ChunkOwner,
  segments: readonly { text: string; loc: string }[],
  policy: ChunkPolicy = DEFAULT_CHUNK_POLICY,
): Chunk[] {
  return build(owner, atomize(segments, policy), policy);
}

/**
 * 把一段纯文本切成块（页面正文路径）。
 * `title` 只挂在**第一块**上：给每块都挂标题会让相同的标题在向量里反复出现，
 * 而且块数一多，标题的权重就会被摊薄到没有意义。
 */
export function chunkText(
  owner: ChunkOwner,
  text: string,
  title = "",
  policy: ChunkPolicy = DEFAULT_CHUNK_POLICY,
): Chunk[] {
  const head = String(title ?? "").trim();
  const body = String(text ?? "").trim();
  if (body.length === 0) return [];
  const segments: { text: string; loc: string }[] = [{ text: body, loc: "" }];
  const chunks = chunkSegments(owner, segments, policy);
  if (head.length > 0 && chunks.length > 0) {
    chunks[0].text = `${head}\n${chunks[0].text}`;
    chunks[0].hash = fnv1a32(chunks[0].text);
  }
  return chunks;
}

function build(owner: ChunkOwner, atoms: Atom[], policy: ChunkPolicy): Chunk[] {
  if (atoms.length === 0) return [];

  // ① 贪心装箱：加到再加就超过 target 为止（单块本身就超 target 的原子自成一箱）
  const boxes: Atom[][] = [];
  let cur: Atom[] = [];
  let len = 0;
  for (const a of atoms) {
    if (cur.length > 0 && len + 1 + a.text.length > policy.target) {
      boxes.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(a);
    len += (len > 0 ? 1 : 0) + a.text.length;
  }
  if (cur.length > 0) boxes.push(cur);

  // ② 收尾碎片并进上一块（只有在不超过**主体预算**时才并 —— 上限是对最终文本说的）
  if (boxes.length >= 2) {
    const lastText = joinAtoms(boxes[boxes.length - 1]);
    if (lastText.length < policy.min) {
      const prev = boxes[boxes.length - 2];
      const prevText = joinAtoms(prev);
      if (prevText.length + 1 + lastText.length <= bodyCap(policy)) {
        boxes.splice(boxes.length - 2, 2, [...prev, ...boxes[boxes.length - 1]]);
      }
    }
  }

  // ③ 加重叠前缀 + 生成行
  const ownerKey = owner.kind === "attachment" ? `att:${owner.attId}` : `page:${owner.pageId}`;
  const texts = boxes.map(joinAtoms);
  return boxes.map((box, i) => {
    const body = texts[i];
    const text = i > 0 ? overlapTail(texts[i - 1], policy.overlap) + body : body;
    return {
      id: `${ownerKey}#${String(i).padStart(4, "0")}`,
      pageId: owner.kind === "page" ? owner.pageId : null,
      attId: owner.kind === "attachment" ? owner.attId : null,
      ord: i,
      loc: box[0].loc,
      lang: detectLang(body),
      text,
      hash: fnv1a32(text),
    };
  });
}
