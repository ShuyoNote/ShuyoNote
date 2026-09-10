// 侧栏开合的持久化语义。
//
// 背景：移动端进入时会把侧栏自动收起（布局需要），如果这个状态也写进
// localStorage，就会污染桌面端——在手机上开过一次应用，桌面端下次启动侧栏
// 就是收起的（而用户从没在桌面收过它）。所以「显式操作」才写偏好，
// 「布局驱动」只改当前状态。
import { beforeEach, describe, expect, it } from "vitest";
import { useActivity } from "./activity";

const KEY = "shuyonote:sidebarOpen";

describe("activity store · 侧栏开合的持久化", () => {
  beforeEach(() => {
    localStorage.clear();
    useActivity.setState({ sidebarOpen: true });
  });

  it("显式设置会写入 localStorage（这才是用户偏好）", () => {
    useActivity.getState().setSidebarOpen(false);
    expect(localStorage.getItem(KEY)).toBe("0");

    useActivity.getState().setSidebarOpen(true);
    expect(localStorage.getItem(KEY)).toBe("1");
  });

  it("persist:false 只改当前状态，不动桌面端偏好", () => {
    localStorage.setItem(KEY, "1");

    useActivity.getState().setSidebarOpen(false, { persist: false });

    expect(useActivity.getState().sidebarOpen).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("1");
  });

  it("toggleSidebar 仍是显式操作，照常持久化", () => {
    useActivity.setState({ sidebarOpen: true });

    useActivity.getState().toggleSidebar();

    expect(useActivity.getState().sidebarOpen).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("0");
  });
});
