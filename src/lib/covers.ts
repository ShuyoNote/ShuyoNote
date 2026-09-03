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

/** Wrap an inline SVG in a data-URI url(...) usable as a CSS background. */
function svgCover(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const V = 'xmlns="http://www.w3.org/2000/svg"';
const B = `viewBox="0 0 600 200" ${V} preserveAspectRatio="xMidYMid slice"`;

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

  // ---- themed images (inline SVG scenes) ----
  {
    id: "mountain",
    name: "山峦",
    kind: "image",
    css: svgCover(
      `<svg ${B}><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9a76"/><stop offset="1" stop-color="#ff5e62"/></linearGradient></defs><rect width="600" height="200" fill="url(#s)"/><circle cx="300" cy="86" r="30" fill="#fff" opacity="0.92"/><path d="M0 200 L120 74 L240 200 Z" fill="#7f2e4f"/><path d="M120 200 L300 46 L480 200 Z" fill="#5a2140"/><path d="M300 200 L470 84 L600 200 Z" fill="#7f2e4f"/><path d="M0 200 L70 130 L150 200 Z" fill="#4a1a35"/><path d="M470 200 L540 132 L600 200 Z" fill="#4a1a35"/></svg>`,
    ),
  },
  {
    id: "tech",
    name: "科技",
    kind: "image",
    css: svgCover(
      `<svg ${B}><defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f2027"/><stop offset="1" stop-color="#2c5364"/></linearGradient></defs><rect width="600" height="200" fill="url(#t)"/><g stroke="#38bdf8" stroke-width="1" fill="none" opacity="0.55"><path d="M40 160 H160 V90 H320"/><path d="M60 60 H200 V140 H360"/><path d="M260 30 H440 V100 H560"/><path d="M180 180 H360 V120 H480"/></g><g fill="#7dd3fc"><circle cx="160" cy="90" r="3"/><circle cx="320" cy="90" r="4"/><circle cx="200" cy="140" r="3"/><circle cx="360" cy="140" r="3"/><circle cx="440" cy="100" r="4"/><circle cx="560" cy="100" r="3"/><circle cx="480" cy="120" r="3"/></g><circle cx="320" cy="90" r="14" fill="none" stroke="#38bdf8" stroke-width="1" opacity="0.8"/></svg>`,
    ),
  },
  {
    id: "starry",
    name: "星空",
    kind: "image",
    css: svgCover(
      `<svg ${B}><defs><linearGradient id="n" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1026"/><stop offset="1" stop-color="#1b2f5e"/></linearGradient></defs><rect width="600" height="200" fill="url(#n)"/><circle cx="488" cy="48" r="22" fill="#fef3c7" opacity="0.96"/><circle cx="482" cy="44" r="5" fill="#1b2f5e"/><g fill="#fff"><circle cx="120" cy="40" r="1.6" opacity="0.9"/><circle cx="220" cy="90" r="1.2" opacity="0.7"/><circle cx="320" cy="30" r="1.8" opacity="0.95"/><circle cx="400" cy="120" r="1.3" opacity="0.7"/><circle cx="80" cy="120" r="1.4" opacity="0.8"/><circle cx="520" cy="130" r="1.2" opacity="0.7"/><circle cx="260" cy="150" r="1.6" opacity="0.85"/><circle cx="560" cy="70" r="1.4" opacity="0.8"/></g></svg>`,
    ),
  },
  {
    id: "wave",
    name: "海浪",
    kind: "image",
    css: svgCover(
      `<svg ${B}><defs><linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2193b0"/><stop offset="1" stop-color="#6dd5ed"/></linearGradient></defs><rect width="600" height="200" fill="url(#w)"/><path d="M0 120 Q75 96 150 120 T300 120 T450 120 T600 120 V200 H0 Z" fill="#e7fbff" opacity="0.5"/><path d="M0 150 Q75 128 150 150 T300 150 T450 150 T600 150 V200 H0 Z" fill="#cdeef7" opacity="0.6"/></svg>`,
    ),
  },
  {
    id: "city",
    name: "城市",
    kind: "image",
    css: svgCover(
      `<svg ${B}><defs><linearGradient id="c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#29323c"/><stop offset="1" stop-color="#485563"/></linearGradient></defs><rect width="600" height="200" fill="url(#c)"/><g fill="#1a222b"><rect x="30" y="90" width="50" height="110"/><rect x="100" y="60" width="60" height="140"/><rect x="180" y="100" width="46" height="100"/><rect x="250" y="70" width="64" height="130"/><rect x="340" y="40" width="54" height="160"/><rect x="420" y="90" width="60" height="110"/><rect x="500" y="65" width="50" height="135"/></g><g fill="#ffe28a" opacity="0.9"><rect x="110" y="70" width="6" height="6"/><rect x="130" y="90" width="6" height="6"/><rect x="112" y="120" width="6" height="6"/><rect x="360" y="52" width="6" height="6"/><rect x="380" y="80" width="6" height="6"/><rect x="262" y="82" width="6" height="6"/><rect x="288" y="110" width="6" height="6"/></g></svg>`,
    ),
  },
  {
    // 免版权风景题头图（picsum.photos），本地打包。
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
