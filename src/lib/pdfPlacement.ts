/**
 * PDF 阅读器放在哪里。
 *
 * 桌面端：它和 Markdown 阅读器一样，是**内容区里的一种视图**——左竖条、页面树、右栏都留着。
 * 窄屏：仍是全屏浮层（那时侧边栏本来就是抽屉，全屏读 PDF 才是对的）。
 *
 * 抽成纯函数是因为这条规则很容易在改动中被"顺手改回去"（它以前就是 `position: fixed;
 * inset: 0` 的全屏浮层，会把侧边栏一起盖住），而把它写成一行可测的判断，比在 JSX 里
 * 藏一个 `pdfOpen && !isMobile` 更难被误改。
 */
export type PdfPlacement = "inline" | "overlay" | "none";

export function pdfPlacement(open: boolean, isMobile: boolean): PdfPlacement {
  if (!open) return "none";
  return isMobile ? "overlay" : "inline";
}
