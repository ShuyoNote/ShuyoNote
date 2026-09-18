import { describe, expect, it } from "vitest";
import {
  DATETIME_STORE_RE,
  formatDateTimeDisplay,
  fromDatetimeLocalValue,
  isValidDateTime,
  parseDateTimeInput,
  toDatetimeLocalValue,
} from "./dateTimeValue";

describe("parseDateTimeInput（用户会怎么敲）", () => {
  it("中文格式 —— 用户给的样例必须过，且秒要保留", () => {
    expect(parseDateTimeInput("2008年5月9日 15:30:00")).toBe("2008-05-09 15:30:00");
  });

  it("中文格式的容错：不带秒 / 不带空格 / 只有日期", () => {
    expect(parseDateTimeInput("2008年5月9日 15:30")).toBe("2008-05-09 15:30:00");
    expect(parseDateTimeInput("2008年5月9日15:30")).toBe("2008-05-09 15:30:00");
    expect(parseDateTimeInput("2008年5月9日")).toBe("2008-05-09 00:00:00");
  });

  it("中文全角冒号也认（中文输入法下很容易打出来）", () => {
    expect(parseDateTimeInput("2008年5月9日 15：30：00")).toBe("2008-05-09 15:30:00");
  });

  it("数字分隔符三种都认，且月/日允许不补零", () => {
    expect(parseDateTimeInput("2008-5-9 15:30:00")).toBe("2008-05-09 15:30:00");
    expect(parseDateTimeInput("2008/05/09 15:30")).toBe("2008-05-09 15:30:00");
    expect(parseDateTimeInput("2008.5.9")).toBe("2008-05-09 00:00:00");
  });

  it("本来就是规范形式 ⇒ 原样返回（幂等）", () => {
    const v = "2008-05-09 15:30:00";
    expect(parseDateTimeInput(v)).toBe(v);
  });

  it("前后空格不算错（复制粘贴常见）", () => {
    expect(parseDateTimeInput("  2008年5月9日 15:30:00  ")).toBe("2008-05-09 15:30:00");
  });

  it("**不存在的时刻必须拒绝**，不能静默存坏值", () => {
    expect(parseDateTimeInput("2008年2月30日")).toBeNull(); // 2 月没有 30 号
    expect(parseDateTimeInput("2009年2月29日")).toBeNull(); // 2009 不是闰年
    expect(parseDateTimeInput("2008年13月1日")).toBeNull(); // 没有 13 月
    expect(parseDateTimeInput("2008年5月9日 24:00")).toBeNull(); // 24 点
    expect(parseDateTimeInput("2008年5月9日 15:60")).toBeNull(); // 60 分
    expect(parseDateTimeInput("2008年5月9日 15:30:60")).toBeNull(); // 60 秒
  });

  it("2008-02-29 是闰日 ⇒ 必须过（别把合法的当非法）", () => {
    expect(parseDateTimeInput("2008年2月29日")).toBe("2008-02-29 00:00:00");
  });

  it("空串 / 认不出的写法 ⇒ null", () => {
    expect(parseDateTimeInput("")).toBeNull();
    expect(parseDateTimeInput("   ")).toBeNull();
    expect(parseDateTimeInput("下周三")).toBeNull();
    expect(parseDateTimeInput("2008年5月")).toBeNull();
    expect(parseDateTimeInput("5/9/2008")).toBeNull(); // 不做美式月/日猜测
  });
});

describe("formatDateTimeDisplay（显示成用户给的形态）", () => {
  it("年月日不补零、时分秒补零", () => {
    expect(formatDateTimeDisplay("2008-05-09 15:30:00")).toBe("2008年5月9日 15:30:00");
    expect(formatDateTimeDisplay("2008-12-31 00:00:00")).toBe("2008年12月31日 00:00:00");
    expect(formatDateTimeDisplay("2008-01-02 09:05:07")).toBe("2008年1月2日 09:05:07");
  });

  it("非法/空输入原样返回 —— 不把坏数据装扮成正常显示", () => {
    expect(formatDateTimeDisplay("")).toBe("");
    expect(formatDateTimeDisplay("坏数据")).toBe("坏数据");
  });

  it("与解析互为反向：敲进去再显示出来 = 用户写的那串", () => {
    const typed = "2008年5月9日 15:30:00";
    const store = parseDateTimeInput(typed);
    expect(store).not.toBeNull();
    expect(formatDateTimeDisplay(store!)).toBe(typed);
  });
});

describe("选择器那条路径（<input type=&quot;datetime-local&quot;> 的值互转）", () => {
  it("规范串 ↔ datetime-local 的 value", () => {
    expect(toDatetimeLocalValue("2008-05-09 15:30:00")).toBe("2008-05-09T15:30:00");
    expect(fromDatetimeLocalValue("2008-05-09T15:30:00")).toBe("2008-05-09 15:30:00");
  });

  it("选择器清空（value = ''）⇒ null，不是空串", () => {
    expect(fromDatetimeLocalValue("")).toBeNull();
    expect(toDatetimeLocalValue("")).toBe("");
  });

  it("非法存储串不应该喂给选择器", () => {
    expect(toDatetimeLocalValue("2008-02-30 00:00:00")).toBe("");
  });
});

describe("isValidDateTime（读旧数据时的守门）", () => {
  it("规范且真实才为真", () => {
    expect(isValidDateTime("2008-05-09 15:30:00")).toBe(true);
    expect(isValidDateTime("2008-5-9 15:30:00")).toBe(false); // 没补零 ⇒ 不是规范形式
    expect(isValidDateTime("2008-02-30 00:00:00")).toBe(false); // 补零了但日期不存在
    expect(isValidDateTime("")).toBe(false);
  });

  it("规范形式的正则与实现对得上", () => {
    expect(DATETIME_STORE_RE.test("2008-05-09 15:30:00")).toBe(true);
    expect(DATETIME_STORE_RE.test("2008-05-09")).toBe(false);
  });
});
