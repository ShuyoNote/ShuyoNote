import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zh from "./locales/zh";
import en from "./locales/en";

// 首次语言：localStorage 记住，否则跟随系统(en 开头的取 en，其余 zh)。
const saved = (() => {
  try {
    return localStorage.getItem("shuyonote:lang") || undefined;
  } catch {
    return undefined;
  }
})();
const systemLng = navigator.language?.toLowerCase().startsWith("en") ? "en" : "zh-CN";
const lng = saved || systemLng;

i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zh },
    en: { translation: en },
  },
  lng,
  fallbackLng: "zh-CN",
  interpolation: { escapeValue: false },
});

export default i18n;
