import { useRef, useState } from "react";
import { rankRelevantPages, type PdfPageText } from "../lib/searchSemantic";
import { runInlineDraft } from "../lib/ai/inlineDraft";
import { tryConsume } from "../lib/ai/gate";
import type { ProviderConfig } from "../lib/ai/llm";
import type { PdfRenderEngineApi } from "../lib/pdfRender";
import { useAiStore } from "../store/ai";
import { useNotes } from "../store/notes";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import { pageToBlock } from "../lib/pdfAnnotation";

// M24 阶段 3 延伸——「对整篇 PDF 提问」。提问时段提取各页纯文本，用 char-bigram
// Jaccard 挑出最相关若干页（省 token、更准），再把问题+相关页喂给模型流式回答；
// 问答可一键存成带 pdf:// 回链的笔记块。

interface Props {
  attachmentId: string;
  pageCount: number;
  getEngine: () => PdfRenderEngineApi | null;
  onDone?: () => void;
}

export function PdfAskBar({ attachmentId, pageCount, getEngine, onDone }: Props) {
  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState("");
  const [usedPages, setUsedPages] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pageTextCache, setPageTextCache] = useState<PdfPageText[] | null>(null);
  const runSeq = useRef(0);

  // 提取整篇文本（仅字符串，无坐标/光栅化），并缓存供后续多次提问复用。
  const extractAllPages = async (force = false): Promise<PdfPageText[]> => {
    if (!force && pageTextCache) return pageTextCache;
    const eng = getEngine();
    if (!eng || !eng.getPageText) return [];
    const pages: PdfPageText[] = [];
    for (let i = 0; i < pageCount; i++) {
      const text = await eng.getPageText(i);
      if (text) pages.push({ pageIndex: i, text });
    }
    setPageTextCache(pages);
    return pages;
  };

  const ask = async () => {
    const q = question.trim();
    if (!q || running) return;
    const g = tryConsume("pdf");
    if (!g.ok) {
      toast(g.message, "error");
      return;
    }
    setRunning(true);
    setAnswer("");
    setError(null);
    const seq = ++runSeq.current;
    try {
      const pages = await extractAllPages();
      const relevant = rankRelevantPages(q, pages, 5);
      const used = relevant.length ? relevant.map((p) => p.pageIndex) : pages.slice(0, 3).map((p) => p.pageIndex);
      setUsedPages(used);
      if (relevant.length === 0) setError("未找到明显相关页，将按前几页回答。");
      // 组装上下文：只喂相关页。
      const ctxText = pages
        .filter((p) => used.includes(p.pageIndex))
        .map((p) => `[第 ${p.pageIndex + 1} 页]\n${p.text.slice(0, 1800)}`)
        .join("\n\n");
      const config = useAiStore.getState().config as unknown as ProviderConfig;
      const notes = useNotes.getState();
      const allPages = (notes.pages ?? []).map((p: any) => ({ id: p.id, title: p.title, parent_id: p.parent_id ?? null }));
      const res = await runInlineDraft(
        config,
        `请针对下面这篇 PDF 的相关页面回答用户的问题。若文档中找不到答案，请如实说明。不要复述原文，直接给出简洁结论。\n\n【文档相关页】\n${ctxText.slice(0, 6000)}\n\n【问题】\n${q}`,
        allPages.map((p: any) => ({ id: p.id, title: p.title })),
        { currentPageId: notes.currentId, allPages },
        { onDelta: (t) => { if (seq === runSeq.current) setAnswer((prev) => prev + t); } },
      );
      if (seq !== runSeq.current) return;
      setAnswer(res.reply);
      if (res.error) setError(res.error);
    } catch (e) {
      if (seq === runSeq.current) setError(`提问失败：${(e as Error)?.message ?? e}`);
    }
    setRunning(false);
  };

  // 把问答存成带 pdf:// 回链的笔记块（当前页优先，无则新页）。
  const saveAsBlock = async () => {
    if (!answer.trim()) return;
    const q = question.trim();
    const block = pageToBlock({ text: [q, answer].filter(Boolean).join("\n") }, attachmentId, usedPages[0] ?? 0);
    const notes = useNotes.getState();
    if (notes.current && notes.current.id) {
      try {
        const { contentTextOf } = await import("../lib/ai/lexical");
        const blockNode = JSON.parse(block.content_json).root.children[0];
        const doc = JSON.parse(notes.current.content_json || '{"root":{"children":[],"type":"root","version":1}}');
        doc.root.children.push(blockNode);
        const newJson = JSON.stringify(doc);
        await api.savePage({ id: notes.current.id, content_json: newJson, content_text: contentTextOf(newJson) });
        await notes.openPage(notes.current.id);
        toast("问答已存到当前页", "success");
      } catch {
        await notes.createPage(null, { title: "PDF 问答", content_json: block.content_json, content_text: block.content_text });
        toast("问答已存到新页面", "success");
      }
    } else {
      await notes.createPage(null, { title: "PDF 问答", content_json: block.content_json, content_text: block.content_text });
      toast("问答已存到新页面", "success");
    }
    if (onDone) onDone();
  };

  return (
    <div className="pdf-askbar">
      <div className="pdf-askbar-input-row">
        <input
          className="pdf-askbar-input"
          placeholder="对这篇 PDF 提问（自动定位相关页）…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(); } }}
          disabled={running}
        />
        <button className="pdf-askbar-btn" onClick={ask} disabled={running || !question.trim()} title="提问">
          {running ? "回答中…" : "提问"}
        </button>
      </div>

      {(answer || error) && (
        <div className="pdf-askbar-answer">
          <div className="pdf-askbar-answer-head">
            <span className="pdf-askbar-src">{usedPages.length ? `依据 ${usedPages.map((n) => n + 1).join("、")} 页` : ""}</span>
            {answer.trim() && !running && (
              <button className="pdf-askbar-save" onClick={saveAsBlock}>存成块</button>
            )}
          </div>
          {error && <div className="pdf-askbar-error">{error}</div>}
          {answer && <div className="pdf-askbar-answer-text">{answer}</div>}
        </div>
      )}
    </div>
  );
}
