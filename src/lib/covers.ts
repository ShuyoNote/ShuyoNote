// M25/页面封面 — built-in cover presets. The page `cover` field stores a CSS string;
// these presets cover two kinds of "题头图":
//   - gradient: a themed CSS gradient (offline, instant).
//   - image:    an inline SVG scene (landscape / tech / starry…) encoded as a data-URI
//               url(...), so real imagery ships offline with no extra asset paths on
//               web or desktop.
export type CoverKind = "gradient" | "image";
export interface CoverPreset {
  id: string;
  name: string;
  kind: CoverKind;
  css: string;
}

// The default raster cover — a real photo bundled in public/covers and served at
// /covers/... in both web and Tauri desktop. Used for the guide + the "秋山" preset.
// 用相对路径：Web 版若部署到子路径（如 /app/），绝对路径 /covers/… 会 404 导致题头图空白；
// 相对路径按当前页面目录解析，桌面（base /）与子路径部署都正确（ShuyoNote 无 URL 路由）。
export const DEFAULT_COVER = `url("covers/default-cover.jpg")`;

export const COVER_PRESETS: CoverPreset[] = [
  // ---- themed gradients（科技感 / 空灵 / 素雅）----
  { id: "aurora", name: "量子", kind: "gradient", css: "linear-gradient(135deg, #0f2027 0%, #1b2f5e 50%, #38bdf8 100%)" },
  { id: "ocean", name: "星海", kind: "gradient", css: "linear-gradient(135deg, #0b1026 0%, #1b2f5e 50%, #6ea8fe 100%)" },
  { id: "forest", name: "极光", kind: "gradient", css: "linear-gradient(135deg, #0e1e2b 0%, #1e4f5e 50%, #24d3c4 100%)" },
  { id: "sunset", name: "亚麻", kind: "gradient", css: "linear-gradient(135deg, #e2dccd 0%, #f4f1e9 100%)" },
  { id: "candy", name: "云霭", kind: "gradient", css: "linear-gradient(135deg, #dce7f0 0%, #eef4f9 100%)" },
  { id: "lavender", name: "月华", kind: "gradient", css: "linear-gradient(135deg, #e5ebf2 0%, #aebfd0 100%)" },
  { id: "mint", name: "鼠尾草", kind: "gradient", css: "linear-gradient(135deg, #cbd8cd 0%, #eef3ef 100%)" },
  { id: "night", name: "夜幕", kind: "gradient", css: "linear-gradient(135deg, #0a0f1e 0%, #23395b 50%, #4f9cf9 100%)" },
  { id: "solar", name: "晨雾", kind: "gradient", css: "linear-gradient(135deg, #e8eef4 0%, #c9d6e2 100%)" },
  { id: "coral", name: "雾霭", kind: "gradient", css: "linear-gradient(135deg, #dfe9f2 0%, #cfe0ee 100%)" },
  { id: "slate", name: "水墨", kind: "gradient", css: "linear-gradient(135deg, #c9ccd6 0%, #edf0f4 100%)" },
  { id: "rose", name: "青瓷", kind: "gradient", css: "linear-gradient(135deg, #bad6d8 0%, #e8f2f1 100%)" },

  // ---- 免版权风景题头图（picsum.photos），本地打包 ----
  {
    id: "fjord",
    name: "峡湾",
    kind: "image",
    css: `url("covers/fjord.jpg")`,
  },
  {
    id: "peak",
    name: "雪峰",
    kind: "image",
    css: `url("covers/peak.jpg")`,
  },
  {
    id: "coast",
    name: "海岸",
    kind: "image",
    css: `url("covers/coast.jpg")`,
  },
  {
    id: "mist",
    name: "绿雾",
    kind: "image",
    css: `url("covers/mist.jpg")`,
  },
  {
    id: "fall",
    name: "瀑布",
    kind: "image",
    css: `url("covers/fall.jpg")`,
  },
  {
    // Default raster cover — a real photo referenced from public/covers (bundled
    // into dist and served at /covers/... in both web and Tauri desktop).
    id: "autumn",
    name: "秋山",
    kind: "image",
    css: DEFAULT_COVER,
  },
];

/** The default cover used for the built-in「使用指南」page (the default photo). */
export const GUIDE_COVER = DEFAULT_COVER;
