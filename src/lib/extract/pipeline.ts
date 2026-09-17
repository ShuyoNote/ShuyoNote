// 抽取调度：候选 → 抽取 → 落库，并把结果归成一个确定的状态。
// 契约见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15.4 / §15.5。
//
// 两条刻意的策略（都不是随手定的）：
//
// 1. **什么时候换下一个候选**：只在 `unsupported` 与 `empty` 时换。
//    `unsupported` 是"这个抽取器不认这种字节"，`empty` 是"认，但抽不出东西"（扫描件走这条路，
//    于是 `pdf.text` 空了会自然落到 `pdf.ocr`）。其余失败（`encrypted`/`corrupt`/`provider_error`）
//    **换一个抽取器也不会变好**，直接报告，省掉无意义的尝试。
//
// 2. **失败时不动库里已有的行**。看起来保守，但这是对的：`attachment_text` 的 `src_hash` 会
//    让旧行自己暴露成"过期"，下次 `needsExtract` 仍然为真、仍会重试；而如果失败就删，
//    一次**瞬时**的 `provider_error` 会把之前辛苦抽好的文本毁掉。

import { normalizeForStore } from "./normalize";
import { candidates, REGISTRY } from "./registry";
import type { AttachmentTextStore } from "./store";
import type {
  ExtractCoverage,
  ExtractDeps,
  ExtractErrorCode,
  ExtractedSegment,
  Extractor,
  SegmentKind,
} from "./types";

export type ExtractOutcome =
  /** 库里的派生文本已经是当前 hash 的 ⇒ 什么都没做。 */
  | { status: "cached"; extractor: string }
  /** 抽好并落库。 */
  | { status: "stored"; extractor: string; segments: number; kinds: SegmentKind[] }
  /** 没有抽取器认这个格式。 */
  | { status: "no_extractor" }
  /** 认，但抽不出来/抽失败；`tried` 是依次试过的抽取器 id。 */
  | {
      status: "failed";
      code: ExtractErrorCode;
      message: string;
      tried: readonly string[];
    };

export interface ExtractAndStoreOptions {
  attId: string;
  bytes: Uint8Array;
  filename: string;
  mime: string;
  /** 附件内容寻址哈希。 */
  hash: string;
  deps?: ExtractDeps;
  registry?: readonly Extractor[];
  store: AttachmentTextStore;
  /** 注入时钟，便于断言（默认 Date.now()）。 */
  now?: number;
}

/** 抽不出来时值得换下一个候选的两个错误码（见文件头第 1 条）。 */
const RETRYABLE: ReadonlySet<ExtractErrorCode> = new Set(["unsupported", "empty"]);

export async function extractAndStore(
  opts: ExtractAndStoreOptions,
): Promise<ExtractOutcome> {
  const registry = opts.registry ?? REGISTRY;
  const deps = opts.deps ?? {};
  const now = opts.now ?? Date.now();

  const list = candidates(opts.mime, opts.filename, registry);
  if (list.length === 0) return { status: "no_extractor" };

  const ids = list.map((e) => e.id);
  // 缓存判定按**整组候选**：只要有一个还没抽（或 hash 过期）就继续，避免"换了个抽取器但没抽"。
  if (!opts.store.needsExtract(opts.attId, opts.hash, ids)) {
    return { status: "cached", extractor: ids[0] };
  }

  const tried: string[] = [];
  let last: { code: ExtractErrorCode; message: string } | null = null;
  /** 已经成功的**不完整**结果（见下"覆盖不完整 ⇒ 换下一个再试"）。 */
  let partial: { extractor: string; segments: ExtractedSegment[]; coverage: ExtractCoverage } | null = null;

  for (const ex of list) {
    tried.push(ex.id);
    const r = await ex.extract({
      bytes: opts.bytes,
      filename: opts.filename,
      mime: opts.mime,
      hash: opts.hash,
      deps,
    });
    if (r.ok) {
      const cov = r.coverage;
      // **覆盖不完整 ⇒ 先别收工**（Mac 侧实测的"静默丢页"）：
      // 混合文档（正文是文字、中间夹扫描页）会让 `pdf.text` 返回 ok 却**跳过了空页**，
      // 于是后面的 `pdf.ocr` 永远不会被调度，那几页**静默没有内容**。
      // 规则：**继续试下一个候选；谁更完整用谁** —— 是**整体替换**而不是"合并两段"
      // （合并要定义"谁赢"，而替换的语义已经现成且无歧义）。
      if (cov && cov.complete === false && !partial) {
        partial = { extractor: ex.id, segments: r.segments, coverage: cov };
        continue; // 给下一个候选一次机会（没有下一个时，循环结束会用 partial）
      }
      if (cov && cov.complete === false && partial) {
        // 两个都不完整：留**缺口更少**的那个（相等时留先到的，保持"顺序即优先级"）
        const better =
          (cov.gapIndexes?.length ?? Number.POSITIVE_INFINITY) <
          (partial.coverage.gapIndexes?.length ?? Number.POSITIVE_INFINITY);
        if (!better) continue;
        partial = { extractor: ex.id, segments: r.segments, coverage: cov };
        continue;
      }
      // 完整覆盖 ⇒ 立即收工（顺序即优先级：第一个完整的就是它）
      return store_(opts, ex.id, r.segments, now);
    }
    last = { code: r.code, message: r.message };
    if (!RETRYABLE.has(r.code)) break; // 换了也不会好，别浪费
  }

  // 没有完整覆盖的结果，但有不完整的 ⇒ **落它**，并把"不完整"如实带到库里
  //（宁可少而**标注清楚**，也不要整体失败什么都没留下；下游能据此知道"这不是全文"）。
  if (partial) return store_(opts, partial.extractor, partial.segments, now);

  return {
    status: "failed",
    code: last?.code ?? "internal",
    message: last?.message ?? "没有候选抽取器产出结果",
    tried,
  };
}

/** 归一化 + 落库（**归一化只在这一处施加**，见 §15.3-10）。 */
function store_(
  opts: ExtractAndStoreOptions,
  extractorId: string,
  segments: ExtractedSegment[],
  now: number,
): ExtractOutcome {
  const normalized = segments.map((s) =>
    s.text === normalizeForStore(s.text) ? s : { ...s, text: normalizeForStore(s.text) },
  );
  opts.store.replace(opts.attId, extractorId, opts.hash, normalized, now);
  return {
    status: "stored",
    extractor: extractorId,
    segments: normalized.length,
    kinds: normalized.map((s) => s.kind),
  };
}
