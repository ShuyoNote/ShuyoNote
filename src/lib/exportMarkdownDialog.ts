// C 弹窗（「导出当前页… / 导出本空间…」）的**执行层** —— 2026-10-18。
//
// 为什么单独一层：`exportMarkdownBundle.ts` 是"排版 ＋ 打包"（纯函数多、四条旧命令都在用）；
// 这一层只负责**编排**：读哪些页 → 弹哪个保存对话框 → 写 zip / 写 .md → 说人话。
// ⇒ 组件（`components/MarkdownExportDialog.tsx`）只画界面与勾选项，⛔ 不碰 api ✗。
//
// 三个勾选项的语义（界面只有一行字，所以**写死在这里** ✓）：
//   · ☑附件（打包 zip）：勾 ⇒ 产出 zip（`.md` ＋ `assets/` 附件）；不勾 ⇒ **只产出 .md**（不打包、不带附件）。
//   · ☐元数据 YAML：每份 `.md` 顶部换成 YAML front matter（见 `pageFileHeader` ✓）。
//   · ☐纯 .md 平铺：**不按页面树建目录**（zip 内 / 目录内都平铺在根 ✓）。
//     ⚠️ 不勾附件时多份 `.md` 落到一个目录里**强制平铺** —— 桌面 `write_text_file` **不建父目录**，
//        带子目录的路径会直接写失败 ✗；所以那条路只有平铺一种形态 ✓。
//
// ⚠️ 诚实面：不带附件时，正文里的 `attachment://<hash>` 引用**原样留着**（⛔ 不改成一个坏链接 ✗），
//    返回消息里会报"有 N 个附件引用保留原样" ✓。
import { api } from "./api";
import { platform } from "./platform";
import { docJsonOfPage } from "./docContent";
import { sanitizeName, type MarkdownPageInput } from "./exportMarkdown";
import {
  bundleMessage,
  bundleTooLargeMessage,
  collectWorkspaceBundlePages,
  defaultBundleZipName,
  ExportReportedError,
  planBundle,
  prepareBundle,
  preparePages,
  startExportProgress,
  type BundleProgress,
} from "./exportMarkdownBundle";

/** 这次导出的是"当前页"还是"本空间"（两个入口共用同一个弹窗 ✓）。 */
export type DialogExportTarget = "page" | "space";

/** 弹窗上三个勾选项 ＋ 目标（组件原样递进来 ✓）。 */
export interface DialogExportOptions {
  target: DialogExportTarget;
  /** `target === "page"` 时必给（入口那一下的当前页 id ✓）。 */
  pageId: string;
  /** ☑附件（打包 zip）；`false` ⇒ 只产出 .md ✓。 */
  withAttachments: boolean;
  /** ☐元数据 YAML ✓ */
  yaml: boolean;
  /** ☐纯 .md 平铺 ✓ */
  flat: boolean;
  /** 测试/别的壳注入进度；不传 ⇒ 入口自己弹持久 toast（见 `startExportProgress` ✓）。 */
  onProgress?: BundleProgress;
}

/** 一次导出的结果：给用户看的那句话 ＋ 该用哪种 toast（取消不是失败 ✓）。 */
interface Outcome {
  msg: string;
  kind: "success" | "info" | "error";
}

/**
 * 读一次导出范围（页 ＋ 排版要用的 `docJson`）。
 *
 * ⚠️ 单页读不出来 ⇒ **抛**（那一页就是全部内容，跳过等于导出一个空包 ✗）；
 *    空间里有页读不出来 ⇒ 跳过并**报数**（与旧的空间导出同口径 ✓）。
 */
async function collectPages(
  target: DialogExportTarget,
  pageId: string,
): Promise<{ pages: MarkdownPageInput[]; unreadable: number; title: string }> {
  if (target === "page") {
    const page = await api.getPage(pageId);
    return {
      pages: [
        {
          id: page.id,
          title: page.title,
          docJson: docJsonOfPage(page),
          parentId: page.parent_id ?? null,
          kind: page.kind,
        },
      ],
      unreadable: 0,
      title: page.title || "未命名",
    };
  }
  // ⭐⭐ 2026-10-18：空间这一档改走**同一个收集口** ✓ —— 文件夹节点不调 `getPage`
  //   （会被如实拒），但必须收下：子页目录层级 ＋ 挂在文件夹名下的附件都靠它 ✓
  //   （owner 报：空间导出漏掉「设计效果图」整个文件夹里的东西 ✗）。
  const { pages, unreadable } = await collectWorkspaceBundlePages();
  return { pages, unreadable, title: "本空间" };
}

/** ☑附件 ⇒ 打包 zip（`.md` ＋ `assets/`，正文引用换成相对路径 ✓）。 */
async function exportAsZip(
  pages: readonly MarkdownPageInput[],
  opts: DialogExportOptions,
  title: string,
  unreadable: number,
  progress: ReturnType<typeof startExportProgress>,
): Promise<Outcome> {
  const isPage = opts.target === "page";
  const path = await platform.dialog.save({
    title: isPage ? "导出当前页为 Markdown ＋ 附件（zip）" : "导出本空间为 Markdown ＋ 附件（zip）",
    // 与旧入口同一条命名规则：`<空间名>-<原名>.zip` ✓（多空间各导一份时分得清 ✓）
    defaultPath: await defaultBundleZipName(
      isPage ? `${sanitizeName(pages[0]?.title || pages[0]?.id || "未命名")}.zip` : "空间导出.zip",
    ),
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  if (!path) return { msg: "已取消导出", kind: "info" };

  const result = await prepareBundle(pages, {
    onProgress: progress.onProgress,
    allAttachments: !isPage,
    flat: opts.flat,
    yaml: opts.yaml,
  });
  if (result.tooLarge) {
    return { msg: bundleTooLargeMessage(result.tooLarge) ?? "导出体积超过上限", kind: "error" };
  }
  await api.writeBinaryFile(path, Array.from(result.bytes));
  const msg = bundleMessage(title, path, result);
  return unreadable
    ? { msg: `${msg}；另有 ${unreadable} 页读不出来已跳过`, kind: "success" }
    : { msg, kind: "success" };
}

/**
 * ☐附件 ⇒ **只产出 `.md`**（不打包、不带附件）。
 *
 * · 当前页 ⇒ 一个 `.md` 文件（保存对话框 ✓）；
 * · 本空间 ⇒ 选一个目录，多份 `.md` **平铺**写进去（理由见文件头 ⚠️）✓。
 */
async function exportAsMarkdown(
  pages: readonly MarkdownPageInput[],
  opts: DialogExportOptions,
  title: string,
  unreadable: number,
): Promise<Outcome> {
  const prepared = preparePages(pages);
  // `available` 给空集 ⇒ 一个附件都不装，正文里的 `attachment://` 引用原样留着（如实报数 ✓）
  const plan = planBundle(prepared, () => undefined, new Set(), { flat: true, yaml: opts.yaml });
  const files = plan.files;
  if (files.length === 0) return { msg: "没有导出：没有可导出的页面", kind: "error" };
  const leftRefs = plan.unresolved.length
    ? `；有 ${plan.unresolved.length} 个附件引用保留 attachment:// 原样（这次没带附件）`
    : "";

  if (opts.target === "page") {
    const only = files[0];
    const path = await platform.dialog.save({
      title: "导出当前页为 .md",
      defaultPath: `${sanitizeName(pages[0]?.title || pages[0]?.id || "未命名")}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return { msg: "已取消导出", kind: "info" };
    await api.writeTextFile(path, only.text);
    return { msg: `已导出「${title}」到 ${path}${leftRefs}`, kind: "success" };
  }

  const dir = await platform.dialog.open({ directory: true, title: "选择导出目录（纯 .md 平铺）" });
  if (!dir || Array.isArray(dir)) return { msg: "已取消导出", kind: "info" };
  let n = 0;
  for (const f of files) {
    await api.writeTextFile(`${dir}/${f.path}`, f.text);
    n += 1;
  }
  const skipped = unreadable ? `；另有 ${unreadable} 页读不出来已跳过` : "";
  return { msg: `已导出 ${n} 个页面（纯 .md 平铺）到「${dir}」${skipped}${leftRefs}`, kind: "success" };
}

/**
 * 跑一次弹窗导出（组件只调这一条 ✓）。
 *
 * @returns 给用户看的一句话（取消 ⇒ "已取消导出"；失败 ⇒ 抛 [`ExportReportedError`]，
 *          进度 toast 已经如实变成失败，调用方别再弹一遍 ✓）
 */
export async function runDialogExport(opts: DialogExportOptions): Promise<string> {
  const { pages, unreadable, title } = await collectPages(opts.target, opts.pageId);
  const progress = startExportProgress(
    opts.target === "page" ? "正在导出" : "正在导出本空间",
    opts.onProgress,
  );
  try {
    const outcome = opts.withAttachments
      ? await exportAsZip(pages, opts, title, unreadable, progress)
      : await exportAsMarkdown(pages, opts, title, unreadable);
    progress.finish(outcome.msg, outcome.kind);
    return outcome.msg;
  } catch (e) {
    const text = `导出失败：${e instanceof Error ? e.message : String(e)}`;
    progress.finish(text, "error");
    throw new ExportReportedError(text);
  }
}
