// 「从社区链接存一篇笔记」——两步 UI：**先预览，再落库**。
//
// 这是社区方案的 P0：`save` 的语义永远不是"点一下就写进去"，而是
// 「读回来 → 摆给人看 → 人确认 → 才落库」。三条硬约束在这里落地：
//   · 一律先确认（预览里能看到标题、作者、来源、正文前几行、以及**存到哪**）；
//   · 取消零痕迹（对话框取消 = 不抓取之后写任何东西；这也是 `templateImport.test.ts`
//     已经在别处钉过的那条不变式）；
//   · 失败要有话说（链接不对 / 抓不到 / 不是 JSON / 已经存过——分别是四句不同的话）。
//
// 幂等：**同一篇帖子只存一篇**。判断方式是"搜索捞出候选 → 正文里逐字核对来源地址"
// （见 `communitySave.ts` 的 `findStoredPost`，那里写清了为什么不信分词）。
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { markdownToPageContent } from "../lib/mdPreview";
import { fetchCommunityPost, type CommunityPost } from "../lib/communityPost";
import { findStoredPost, linkIntentOf, noteForPost, previewOf, searchKeyOf } from "../lib/communitySave";
import { platform } from "../lib/platform";
import { useCommunitySave } from "../store/communitySave";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import { sanitizeExternalUrl } from "../lib/links";

type Phase = "input" | "loading" | "preview" | "stored";

export function CommunitySaveDialog() {
  const open = useCommunitySave((s) => s.open);
  const close = useCommunitySave((s) => s.close);

  const [link, setLink] = useState("");
  const [phase, setPhase] = useState<Phase>("input");
  const [reason, setReason] = useState("");
  const [post, setPost] = useState<CommunityPost | null>(null);
  /** 已经存过时命中的那一页（标题给人看，id 用来"打开那篇"）。 */
  const [existing, setExisting] = useState<{ id: string; title: string } | null>(null);

  // 每次打开都从干净状态开始：上一次的链接与预览不该"粘"到这一次。
  useEffect(() => {
    if (!open) return;
    setLink("");
    setPhase("input");
    setReason("");
    setPost(null);
    setExisting(null);
  }, [open]);

  if (!open) return null;

  const reset = () => {
    setPhase("input");
    setReason("");
    setPost(null);
    setExisting(null);
  };

  /** 第一步：认链接 → 抓回来 → 查是不是已经存过 → 摆出预览。 */
  const load = async () => {
    const intent = linkIntentOf(link);
    if (!intent.ok) {
      setReason(intent.reason);
      setPhase("input");
      return;
    }
    setPhase("loading");
    setReason("");
    const fetched = await fetchCommunityPost(intent.url);
    if (!fetched.ok) {
      setReason(fetched.reason);
      setPhase("input");
      return;
    }
    // 幂等查询：搜索只负责捞候选，**准确性由逐字核对兜底**。
    try {
      const hits = await api.search(searchKeyOf(intent.url), 20, true);
      const match = findStoredPost(
        hits.map((h) => ({ id: h.id, title: h.title, text: h.snippet ?? "" })),
        intent.url,
      );
      if (match) {
        setPost(fetched.post);
        setExisting({ id: match.id, title: match.title });
        setPhase("stored");
        return;
      }
    } catch {
      // 搜索失败不该挡住"存进笔记"：只是少了一次幂等提示，不是错误。
    }
    setPost(fetched.post);
    setExisting(null);
    setPhase("preview");
  };

  /** 第二步：只在人点「存进笔记」之后才写。 */
  const save = async () => {
    if (!post) return;
    const note = noteForPost(post);
    const payload = markdownToPageContent(note.markdown);
    if (!payload) {
      setReason("这篇帖子没有可写入的正文");
      return;
    }
    const id = await useNotes.getState().createPage(null, {
      title: note.title,
      content_json: payload.content_json,
      content_text: payload.content_text,
    });
    if (!id) {
      setReason("创建页面失败");
      return;
    }
    toast(`已存进笔记：${note.title}`, "success");
    close();
  };

  const openExisting = async () => {
    if (!existing) return;
    close();
    await useNotes.getState().openPage(existing.id);
  };

  const openSource = async () => {
    const safe = post ? sanitizeExternalUrl(post.url) : "";
    if (!safe) return;
    try {
      await platform.opener.openUrl(safe);
    } catch {
      /* 浏览器被拦时安静失败：这只是一次"去看看原帖" */
    }
  };

  const preview = post ? previewOf(noteForPost(post).markdown) : null;

  return (
    <div className="community-save-overlay" onClick={close}>
      <div className="community-save-box" onClick={(e) => e.stopPropagation()}>
        <div className="community-save-head">
          <span>从社区链接存一篇笔记</span>
          <button className="community-save-close" onClick={close} title="关闭">
            ×
          </button>
        </div>

        <div className="community-save-body">
          <label className="community-save-label" htmlFor="community-save-url">
            粘贴社区链接（`shuyonote://save?url=…` 或帖子网址）
          </label>
          <div className="community-save-row">
            <input
              id="community-save-url"
              className="community-save-input"
              value={link}
              placeholder="https://community.shuyo.cn/post/…"
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && phase === "input") void load();
              }}
            />
            <button className="community-save-btn" disabled={phase === "loading"} onClick={() => void load()}>
              {phase === "loading" ? "读取中…" : "读取"}
            </button>
          </div>

          {reason && <div className="community-save-error">{reason}</div>}

          {post && preview && (
            <div className="community-save-preview">
              <div className="community-save-preview-title">{post.title}</div>
              <div className="community-save-preview-meta">
                {[post.author, post.updatedAt || post.createdAt].filter(Boolean).join(" · ")}
                {post.tags.length > 0 && ` · ${post.tags.map((t) => `#${t}`).join(" ")}`}
              </div>
              <button className="community-save-source" onClick={() => void openSource()} title="在浏览器里打开原帖">
                来源：{post.url}
              </button>
              <div className="community-save-preview-body">
                {preview.lines.map((line, i) => (
                  <div key={i}>{line || "\u00a0"}</div>
                ))}
                {preview.hiddenLines > 0 && (
                  <div className="community-save-more">…后面还有 {preview.hiddenLines} 行（存进笔记后会完整写入）</div>
                )}
              </div>
              {/* 落点必须写出来：静默决定"存到哪"是最容易被冒犯的地方。 */}
              <div className="community-save-target">将存到：工作区根目录（可在左侧页面树里拖动归档）</div>
            </div>
          )}

          {phase === "stored" && existing && (
            <div className="community-save-stored">
              这篇帖子**已经存过**了：「{existing.title || "未命名"}」
              <div className="community-save-stored-actions">
                <button className="community-save-btn" onClick={() => void openExisting()}>
                  打开那篇
                </button>
                <button className="community-save-btn ghost" onClick={reset}>
                  换一条链接
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="community-save-foot">
          {phase === "preview" && (
            <button className="community-save-btn primary" onClick={() => void save()}>
              存进笔记
            </button>
          )}
          <button className="community-save-btn" onClick={close}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
