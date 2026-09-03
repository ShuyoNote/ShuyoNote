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
  // ---- 免版权风景/花木/古画感 题头图（picsum.photos），本地打包 ----
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
    id: "tree",
    name: "树木",
    kind: "image",
    css: `url("covers/tree.jpg")`,
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
