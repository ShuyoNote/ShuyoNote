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
  // ---- themed gradients ----
  { id: "aurora", name: "极光", kind: "gradient", css: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)" },
  { id: "ocean", name: "深海", kind: "gradient", css: "linear-gradient(135deg, #2b5876 0%, #4e4376 100%)" },
  { id: "forest", name: "森林", kind: "gradient", css: "linear-gradient(135deg, #134e5e 0%, #71b280 100%)" },
  { id: "sunset", name: "落日", kind: "gradient", css: "linear-gradient(135deg, #fa709a 0%, #fee140 100%)" },
  { id: "candy", name: "糖果", kind: "gradient", css: "linear-gradient(135deg, #ee9ca7 0%, #ffdde1 100%)" },
  { id: "lavender", name: "薰衣草", kind: "gradient", css: "linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)" },
  { id: "mint", name: "薄荷", kind: "gradient", css: "linear-gradient(135deg, #96e6a1 0%, #d4fc79 100%)" },
  { id: "night", name: "夜幕", kind: "gradient", css: "linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)" },
  { id: "solar", name: "晨光", kind: "gradient", css: "linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)" },
  { id: "coral", name: "珊瑚", kind: "gradient", css: "linear-gradient(135deg, #ff9a9e 0%, #fad0c4 100%)" },
  { id: "slate", name: "雾蓝", kind: "gradient", css: "linear-gradient(135deg, #6a85b6 0%, #bac8e0 100%)" },
  { id: "rose", name: "玫瑰", kind: "gradient", css: "linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)" },

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
