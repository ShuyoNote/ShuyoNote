// M25 P2 — external help site. Reuses the M21 static-wiki export to turn the
// built-in「使用指南」into a hostable static HTML site (index.html + the guide
// page), so the About "文档" route can eventually point at it. Pure + dependency-
// light (imports only wikiExport) so the smoke harness can bundle and assert on
// the HTML output.
import { buildWikiExport, type WikiExportResult } from "./wikiExport";

export const HELP_INDEX_TITLE = "ShuyoNote 帮助";

/**
 * Build a hostable static help site from the guide's plain text.
 * Returns index.html + the guide page HTML (reusing M21's wiki export).
 */
export function buildHelpSite(guideText: string): WikiExportResult & { indexHtml: string } {
  const res = buildWikiExport(
    [
      {
        id: "guide-help",
        title: "ShuyoNote 使用指南",
        content_text: guideText,
        kind: "page",
        parent_id: null,
        sort_order: 0,
        space: HELP_INDEX_TITLE,
      },
    ],
    { space: HELP_INDEX_TITLE },
  );
  return { ...res, indexHtml: res.files.find((f) => f.name === "index.html")?.content ?? "" };
}
