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
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { type CommunityPost } from "../lib/communityPost";
import { findStoredPost, linkIntentOf, noteForPost, previewOf, searchKeyOf } from "../lib/communitySave";
import { NOTE_ATTR_SPECS, savePostAsNote } from "../lib/communitySaveNote";
import { parseTemplatePayload, templateManifest, type ImportedTemplate } from "../lib/communityImport";
import { markdownPreviewHtml } from "../lib/mdPreviewHtml";
import { useTemplates } from "../store/templates";
import { platform } from "../lib/platform";
import { useCommunitySave } from "../store/communitySave";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import { openExternalUrl } from "../lib/openExternal";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { useOverlayLayer } from "../hooks/useOverlayLayer";

type Phase = "input" | "loading" | "preview" | "stored";

export function CommunitySaveDialog() {
  const open = useCommunitySave((s) => s.open);
  useOverlayScrollLock(open);
  // Android 返回键：优先关掉最上层浮层（见 lib/overlayStack.ts）。
  useOverlayLayer("communitySave", open, () => useCommunitySave.getState().close());
  const pendingLink = useCommunitySave((s) => s.pendingLink);
  const close = useCommunitySave((s) => s.close);

  const [link, setLink] = useState("");
  const [phase, setPhase] = useState<Phase>("input");
  const [reason, setReason] = useState("");
  const [post, setPost] = useState<CommunityPost | null>(null);
  /** 已经存过时命中的那一页（标题给人看，id 用来"打开那篇"）。 */
  const [existing, setExisting] = useState<{ id: string; title: string } | null>(null);
  /** 这条链接要做什么：`save` 存笔记 / `import` 导入产物。**动作不同，承诺不同**。 */
  const [action, setAction] = useState<"save" | "import">("save");
  /** 导入预览：模板 + 逐行清单（"会创建什么"要摆在最前面）。 */
  const [imported, setImported] = useState<{ template: ImportedTemplate; manifest: string[] } | null>(null);
  /** 正文预览看哪一档：默认**渲染**，切一下看逐字 Markdown 源码。 */
  const [showSource, setShowSource] = useState(false);

  // 每次打开都从干净状态开始：上一次的链接与预览不该"粘"到这一次。
  // 深链那一路会带 `pendingLink` 进来：**预填并直接读一次**（读=抓取+预览），
  // 但绝不自动保存——"网页发出的链接"不该比"用户自己粘贴"多出任何权限。
  useEffect(() => {
    if (!open) return;
    setReason("");
    setPost(null);
    setExisting(null);
    setImported(null);
    setAction("save");
    if (pendingLink) {
      setLink(pendingLink);
      void load(pendingLink);
    } else {
      setLink("");
      setPhase("input");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pendingLink]);

  // 正文预览：**默认渲染**（owner 2026-09-21：「内容区显示为 MD 格式不太友好吧？」），
  // 另给一个开关看逐字源码 —— 与「发布到社区」那份清单同一个口径（同一套
  // `markdownPreviewHtml`，免得两处 Markdown 语义各走一路）。
  // ⚠️ 这几个 hook 必须在下面那句 `if (!open) return null` **之前**：放在后面会让
  // "关着的时候少跑几个 hook"，React 当场报 `Rendered fewer hooks than expected`
  // （这次就是这么被测试抓出来的）。
  const noteMarkdown = post ? noteForPost(post).markdown : "";
  const preview = post ? previewOf(noteMarkdown) : null;
  const previewHtml = useMemo(() => (post ? markdownPreviewHtml(noteMarkdown) : ""), [post, noteMarkdown]);
  // 换一条链接重新读过之后，回到"渲染"这一档（否则上一条的源码档会漏过来）。
  useEffect(() => {
    setShowSource(false);
  }, [post?.url]);

  if (!open) return null;

  const reset = () => {
    setPhase("input");
    setReason("");
    setPost(null);
    setExisting(null);
    setImported(null);
    setAction("save");
  };

  /** 第一步：认链接 → 抓回来 → 查是不是已经存过 → 摆出预览。 */
  const load = async (raw?: string) => {
    const intent = linkIntentOf(raw ?? link);
    if (!intent.ok) {
      setReason(intent.reason);
      setPhase("input");
      return;
    }
    setAction(intent.action);
    setPhase("loading");
    setReason("");

    // **`import` 走另一条路**：它要的是"把产物导进来"，不是"存一篇笔记"。
    // 之前这两支被合并成一条（点导入模板会去存笔记，且不报错），现在分开。
    if (intent.action === "import") {
      let text: string;
      try {
        text = await platform.community.fetchDocument(intent.url);
      } catch (e) {
        setReason(e instanceof Error ? e.message : String(e));
        setPhase("input");
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        setReason(`这份文件不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`);
        setPhase("input");
        return;
      }
      const parsed = parseTemplatePayload(raw);
      if (!parsed.ok) {
        setReason(parsed.reason);
        setPhase("input");
        return;
      }
      setImported({ template: parsed.template, manifest: templateManifest(parsed.template, intent.url) });
      setPhase("preview");
      return;
    }

    // 走平台驱动：**桌面端是原生命令**（没有 CORS，401/404 能如实上报），
    // Web 版是浏览器 fetch（受 CORS 约束——社区侧要给 Access-Control-Allow-Origin）。
    let fetchedPost: CommunityPost;
    try {
      fetchedPost = await platform.community.fetchPost(intent.url);
    } catch (e) {
      setReason(e instanceof Error ? e.message : String(e));
      setPhase("input");
      return;
    }
    const fetched = { ok: true as const, post: fetchedPost };
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

  /** 第二步：只在人点了确认之后才写（存笔记 / 导入模板各一条路）。 */
  const save = async () => {
    if (action === "import") {
      if (!imported) return;
      const ok = await useTemplates.getState().saveAs({
        name: imported.template.name,
        category: imported.template.category,
        content_json: imported.template.content_json,
        content_text: imported.template.content_text,
      });
      if (!ok) {
        setReason("导入模板失败（模板中心没有接受这份内容）");
        return;
      }
      toast(`已导入模板：${imported.template.name}`, "success");
      close();
      return;
    }
    if (!post) return;
    // 落库走 `savePostAsNote`（建页 → 真标签 → 属性）。**三层结果分开说**：
    // 什么都没成 ⇒ 留在对话框里报错；笔记成了 ⇒ 关掉并说清"哪几样没写上"（别报成失败，
    // 也别把"标签没写上"咽下去 —— 用户下次会发现标签栏里没有它）。
    try {
      const r = await savePostAsNote(post, {
        createPage: useNotes.getState().createPage,
        invoke: platform.executor.invoke,
      });
      if (!r.pageId) {
        setReason(r.error || "创建页面失败");
        return;
      }
      if (r.warnings.length > 0) {
        toast(`已存进笔记，但${r.warnings.join("；")}`, "info");
      } else {
        toast(`已存进笔记：${post.title}`, "success");
      }
    } catch (e) {
      // 抛出来的（平台命令炸了、注入的依赖不对…）必须落成**看得见**的一句话：
      // 静默的 rejection 只会让人以为"点了没反应"（这条 try/catch 就是被一次测试抓出来的）。
      setReason(`存进笔记失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    close();
  };

  const openExisting = async () => {
    if (!existing) return;
    close();
    await useNotes.getState().openPage(existing.id);
  };

  const openSource = () => {
    // 走全应用唯一的外链出口（总闸 + 白名单 + 拦下时说明）——不在这里自己判开关，
    // 那正是这个开关以前只盖住 1/6 个外链面的原因（见 `src/lib/openExternal.ts`）。
    if (post) void openExternalUrl(post.url);
  };

  return (
    <div className="community-save-overlay" onClick={close}>
      <div className="community-save-box" onClick={(e) => e.stopPropagation()}>
        <div className="community-save-head">
          <span>{action === "import" ? "从社区链接导入模板" : "从社区链接存一篇笔记"}</span>
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

          {imported && (
            <div className="community-save-preview">
              {imported.manifest.map((line, i) => (
                <div key={i} className={i === 0 ? "community-save-preview-title" : "community-save-preview-meta"}>
                  {line}
                </div>
              ))}
            </div>
          )}

          {post && preview && (
            <div className="community-save-preview">
              <div className="community-save-preview-title">{post.title}</div>
              <div className="community-save-preview-meta">
                {[post.author, post.updatedAt || post.createdAt].filter(Boolean).join(" · ")}
                {post.tags.length > 0 && ` · ${post.tags.map((t) => `#${t}`).join(" ")}`}
              </div>
              {/* 元信息落到哪儿要**在写之前**说清（owner 2026-09-21 拍板的口径）：
                  标签 → 笔记的真标签；来源/作者/发布于/存于 → 笔记属性；来源那一行同时留在正文里
                  （幂等与导出都靠它，删了就查不出"这篇存过没有"）。 */}
              <div className="community-save-preview-meta">
                {post.tags.length > 0
                  ? `标签会成为笔记的真标签：${post.tags.map((t) => `#${t}`).join(" ")}`
                  : "这篇帖子没有标签"}
                {` · ${NOTE_ATTR_SPECS.map((a) => a.name).join(" / ")} 会成为笔记属性`}
              </div>
              <button className="community-save-source" onClick={() => void openSource()} title="在浏览器里打开原帖">
                来源：{post.url}
              </button>
              {/* 正文默认**渲染**成"存进笔记后的样子"，要看逐字 Markdown 源码就切一下
                  （owner 2026-09-21：「内容区显示为 MD 格式不太友好吧？」）。
                  存进去的**仍然是这份 Markdown 原文**，一个字没改。 */}
              <div className="community-save-preview-row">
                <span className="community-save-preview-meta">正文预览</span>
                <button
                  className="community-save-preview-toggle"
                  onClick={() => setShowSource((v) => !v)}
                  title={
                    showSource
                      ? "切回渲染效果（存进笔记后看到的样子）"
                      : "看逐字的 Markdown 源码（存进笔记的就是它）"
                  }
                >
                  {showSource ? "看渲染效果" : "看 Markdown 源码"}
                </button>
              </div>
              {showSource || previewHtml === "" ? (
                <div className="community-save-preview-body">
                  {preview.lines.map((line, i) => (
                    <div key={i}>{line || "\u00a0"}</div>
                  ))}
                  {preview.hiddenLines > 0 && (
                    <div className="community-save-more">…后面还有 {preview.hiddenLines} 行（存进笔记后会完整写入）</div>
                  )}
                </div>
              ) : (
                <div
                  className="community-save-preview-body is-rendered"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              )}
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
              {action === "import" ? "导入模板" : "存进笔记"}
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
