// M25/页面封面 — built-in curated cover presets (offline CSS gradients). The page
// cover field stores the CSS string; these presets give users a "gallery" of
// beautiful, theme-consistent covers of several moods instead of typing a gradient.
export interface CoverPreset {
  id: string;
  name: string;
  css: string;
}

export const COVER_PRESETS: CoverPreset[] = [
  { id: "aurora", name: "极光", css: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)" },
  { id: "ocean", name: "深海", css: "linear-gradient(135deg, #2b5876 0%, #4e4376 100%)" },
  { id: "forest", name: "森林", css: "linear-gradient(135deg, #134e5e 0%, #71b280 100%)" },
  { id: "sunset", name: "落日", css: "linear-gradient(135deg, #fa709a 0%, #fee140 100%)" },
  { id: "candy", name: "糖果", css: "linear-gradient(135deg, #ee9ca7 0%, #ffdde1 100%)" },
  { id: "lavender", name: "薰衣草", css: "linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)" },
  { id: "mint", name: "薄荷", css: "linear-gradient(135deg, #96e6a1 0%, #d4fc79 100%)" },
  { id: "night", name: "夜幕", css: "linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)" },
  { id: "solar", name: "晨光", css: "linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)" },
  { id: "coral", name: "珊瑚", css: "linear-gradient(135deg, #ff9a9e 0%, #fad0c4 100%)" },
  { id: "slate", name: "雾蓝", css: "linear-gradient(135deg, #6a85b6 0%, #bac8e0 100%)" },
  { id: "rose", name: "玫瑰", css: "linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)" },
];

/** The default cover used for the built-in「使用指南」page. */
export const GUIDE_COVER = COVER_PRESETS[0].css;
