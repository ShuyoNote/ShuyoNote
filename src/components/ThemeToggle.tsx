import { useTheme, type Theme } from "../store/theme";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons";

const CYCLE: Theme[] = ["system", "light", "dark"];

const LABEL: Record<Theme, string> = {
  system: "跟随系统",
  light: "亮色",
  dark: "暗色",
};

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === "dark") return <MoonIcon />;
  if (theme === "light") return <SunIcon />;
  return <MonitorIcon />;
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const next = () => {
    const idx = CYCLE.indexOf(theme);
    setTheme(CYCLE[(idx + 1) % CYCLE.length]);
  };

  return (
    <button className="btn-theme" onClick={next} title={`主题：${LABEL[theme]}（点击切换）`}>
      <ThemeIcon theme={theme} />
    </button>
  );
}
