// Template-center data (UI skeleton). Templates are hardcoded for now; a later
// step will read bundled/user template JSON from the backend and fill page
// content on "create from template".

export interface TemplateItem {
  id: string;
  name: string;
  category: string;
  icon: string;
  cover: string; // CSS gradient (placeholder cover)
}

export const TEMPLATE_CATEGORIES = ["个人", "工作", "教育", "我的模板"] as const;

export const TEMPLATES: TemplateItem[] = [
  { id: "library", name: "我的个人图书馆", category: "个人", icon: "📚", cover: "linear-gradient(135deg, #f6d5b3 0%, #e8a87c 100%)" },
  { id: "daily", name: "每日小记", category: "个人", icon: "📝", cover: "linear-gradient(135deg, #c4e0f9 0%, #8ec5ff 100%)" },
  { id: "subscription", name: "会员订购管理", category: "工作", icon: "🗂", cover: "linear-gradient(135deg, #ffd3a5 0%, #fd9850 100%)" },
  { id: "movie", name: "我的观影记录", category: "个人", icon: "🎬", cover: "linear-gradient(135deg, #d6d9ff 0%, #a3a8ff 100%)" },
  { id: "mood", name: "情绪日记", category: "个人", icon: "🌙", cover: "linear-gradient(135deg, #c8e6c9 0%, #a5d6a7 100%)" },
  { id: "fitness", name: "减肥习惯计划", category: "健康", icon: "💪", cover: "linear-gradient(135deg, #ffe0b2 0%, #ffb74d 100%)" },
  { id: "resume", name: "芳崽的简历", category: "教育", icon: "🎓", cover: "linear-gradient(135deg, #f8bbd0 0%, #f48fb1 100%)" },
  { id: "calendar", name: "斜霸日历", category: "工作", icon: "📅", cover: "linear-gradient(135deg, #fff9c4 0%, #fff176 100%)" },
  { id: "about", name: "关于我自己", category: "个人", icon: "🙋", cover: "linear-gradient(135deg, #b3e5fc 0%, #4fc3f7 100%)" },
];
