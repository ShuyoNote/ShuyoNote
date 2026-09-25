// 「社区帖子 → 笔记」的**落库那一半**：建页 → 真标签 → 属性。
//
// 分工：`communitySave.ts` 只做纯函数（正文怎么拼、来源地址怎么绝对化、幂等怎么认），
// 这里做有副作用的那几步。owner 2026-09-21 拍板的方案（A 混合）：
//   · **正文**：原帖正文照旧（格式已验证保得住），最前面保留一行**纯文本来源**
//     —— 幂等（"这篇存过没有"）与导出（Markdown 里带走）都靠它；
//   · **标签**：社区标签落成笔记的**真标签**（`add_tag`），不再往正文里塞一行 `标签：#a #b`；
//   · **属性**：来源 / 作者 / 发布于 / 存于 四个属性（首次保存时按需创建 `attr_defs`）。
//
// ⚠️ 为什么**不是**一条 Rust 命令原子写（原方案里写的是那样）：这条路 Web 版也要走，
// 而 Web 的三个写命令（`create_page` / `add_tag` / `set_page_prop`）都在 TS 侧自己实现
// —— 做成 Rust 专属命令，Web 就得再写一份，两边从此各有一半口径。所以这里选**一套顺序写**，
// 并把"哪一步没成"如实带回给用户：**笔记本身已经存下来了**（那是他要的东西），
// 标签/属性是补充；失败时明说"标签没写上：…"，而不是把整件事报成失败或干脆不说。
//
// 顺序有讲究：**先建页**（拿到 id 才能挂标签/属性），且建页失败就全停 ——
// 页面是这条路的产物，其余都是它的附属。
import type { AttrDef } from "../types";
import type { NoteState } from "../store/notes";
import type { CommunityPost } from "./communityPost";
import { noteForPost } from "./communitySave";
import { markdownToPageContent } from "./mdPreview";
import { useTagManagerStore } from "../store/tagManager";
import { usePropertyUiStore } from "../store/propertyUi";

/**
 * `create_page` 要的正文载荷：**从笔记 store 的 `createPage` 签名派生**，不在这里重写一遍字段名。
 *
 * 为什么（2026-09-21）：这里原本手写了一版 `{ title; 正文 JSON; 正文纯文本 }` ——
 * 与 `store/notes.ts` 的 `createPage` 参数形状**重复了一份**，于是
 * `node scripts/check-doc-content-access.mjs` 把本文件当成"新增的直接访问点"报红
 * （那条门禁数的是正文存储字段名这类令牌，要求这类访问只减不增；它**连注释一起数**，
 * 所以这里也刻意不写出那些字面量）。派生一份既让门禁回到绿，也少了个
 * "改了 store 的参数形状、忘了改这里"的地方。
 */
type CreatePageContent = Parameters<NoteState["createPage"]>[1];

/** 属性定义（名字与类型）：这是 owner 定的四个，改名就等于换了数据口径。 */
export const NOTE_ATTR_SPECS = [
  { name: "来源", attr_type: "text" },
  { name: "作者", attr_type: "text" },
  { name: "发布于", attr_type: "datetime" },
  { name: "存于", attr_type: "datetime" },
] as const;

/**
 * 社区的时间戳 → 应用的**属性时间**存储格式（`YYYY-MM-DD HH:MM:SS`，见 `lib/dateTimeValue`）。
 *
 * 社区那边存的就是这个形状（`created_at` 是 UTC，站点页面也**原样**显示）。
 * 这里**不做时区换算**：换算会让笔记里的时间和站点上对不上，而用户核对时看的是站点。
 * 认不出的形状返回 `""`（调用方就不写这个属性，而不是写一个坏值）。
 */
export function communityDateTime(raw: string): string {
  const s = (raw ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
  // 只到分的（`2026-09-20 11:29`）补上秒；ISO 的 `T`、毫秒、末尾的 `Z` 也认
  //（`Z` 只当记号：社区自己的 `created_at` 本来就是 UTC 且页面原样显示，这里**不换算时区**，
  // 否则笔记里的时间会和站点上对不上）。
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?Z?$/);
  if (m) return `${m[1]} ${m[2]}:${m[3] ?? "00"}`;
  return "";
}

/** 本地"现在"，同样用应用的存储格式（存于 = **你**把这篇收进来的时间，所以用本地时钟）。 */
export function localNow(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

export interface SavePostDeps {
  /** 建页（走 `useNotes.createPage`：它顺带刷新左侧页面树并切到"笔记"视图）。返回 null = 没建成。 */
  createPage: (
    parentId: string | null,
    content: CreatePageContent,
  ) => Promise<string | null>;
  /** 平台执行器（标签与属性那几条命令）。参数形状与 `platform.executor.invoke` 同。 */
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  /** 注入时钟只为判据（默认 `new Date()`）。 */
  now?: Date;
}

export interface SavePostResult {
  /** 建成的那一页（null = 彻底没成，见 `error`）。 */
  pageId: string | null;
  /** 人话的失败原因（只在整个都没成时有值）。 */
  error: string;
  /** 笔记存下来了，但这几样没写上（如实带回，别谎报"全好了"）。 */
  warnings: string[];
}

/**
 * 把一篇社区帖子存成笔记。**只有人点了确认之后**才该调它。
 *
 * 返回值分三层：`error`（什么都没成）/ `pageId`（笔记成了）/ `warnings`（笔记成了，但某几样没写上）。
 * 调用方按这三层说话 —— 把"标签没写上"报成"保存失败"是错的，把"没写上"咽下去也是错的。
 */
export async function savePostAsNote(post: CommunityPost, deps: SavePostDeps): Promise<SavePostResult> {
  const note = noteForPost(post);
  const payload = markdownToPageContent(note.markdown);
  if (!payload) {
    return { pageId: null, error: "这篇帖子没有可写入的正文", warnings: [] };
  }
  const pageId = await deps.createPage(null, { title: note.title, ...payload });
  if (!pageId) {
    return { pageId: null, error: "创建页面失败", warnings: [] };
  }

  const warnings: string[] = [];
  // ① 真标签：社区的标签名直接建成笔记标签（`add_tag` 认已有词，不会重复建）。
  let tagsAdded = 0;
  for (const name of note.tags) {
    try {
      await deps.invoke("add_tag", { pageId, name });
      tagsAdded += 1;
    } catch (e) {
      warnings.push(`标签「${name}」没写上（${msg(e)}）`);
    }
  }
  // 左侧标签栏是按 `useTagManagerStore.revision` 重新拉列表的；这里直接打的是命令（没走界面那条路），
  // 所以加完要**手动 bump 一次**，否则新标签要等下次改名/删除才出现。
  if (tagsAdded > 0) useTagManagerStore.getState().bump();

  // ② 属性：来源 / 作者 / 发布于 / 存于。定义**按需创建**（第一次保存时建，之后复用）。
  const values: Record<string, string> = {
    来源: post.url,
    作者: post.author,
    发布于: communityDateTime(post.createdAt),
    存于: localNow(deps.now),
  };
  let propsWritten = 0;
  try {
    const defs = await deps.invoke<AttrDef[]>("list_attr_defs");
    for (const spec of NOTE_ATTR_SPECS) {
      const value = (values[spec.name] ?? "").trim();
      if (!value) continue; // 社区没给（比如时间是空/坏值）⇒ 这个属性就不写，别写空值
      let def = defs.find((d) => d.name === spec.name && d.attr_type === spec.attr_type);
      if (!def) {
        def = await deps.invoke<AttrDef>("create_attr", {
          args: { name: spec.name, attr_type: spec.attr_type },
        });
      }
      await deps.invoke("set_page_prop", { args: { page_id: pageId, attr_id: def.id, value } });
      propsWritten += 1;
    }
  } catch (e) {
    warnings.push(`属性没写上（${msg(e)}）`);
  }
  // 属性区是**自己拉** `getPageProps` 的（本地 state），而这些属性是绕过它那条写路径打的命令
  // ⇒ 不通知它，就得**重新打开这一页**才看得到（2026-09-23 用户实测）。
  // 标签那边同理，靠的是 `useTagManagerStore.bump()`；属性这边是 `usePropertyUiStore.bumpProps()`。
  // 只在**真写了**的时候 bump：CREATE 都没写就别让它白重拉一次。
  if (propsWritten > 0) usePropertyUiStore.getState().bumpProps();

  return { pageId, error: "", warnings };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
