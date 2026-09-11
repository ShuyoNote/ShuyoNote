import { describe, expect, it } from "vitest";
import { MAX_TEMPLATE_TEXT, parseTemplatePayload, templateManifest } from "./communityImport";

const tpl = {
  name: "周回顾",
  category: "我的模板",
  content_json: '{"root":{"children":[]}}',
  content_text: "本周要点\n下周计划",
};

describe("parseTemplatePayload — 只认我们自己导出的那种模板文件", () => {
  it("正常模板：字段各就各位", () => {
    expect(parseTemplatePayload(tpl)).toEqual({ ok: true, template: tpl });
  });

  it("缺 content_json → 报错，并说清该用什么代替（插件走索引、主题没格式）", () => {
    const r = parseTemplatePayload({ name: "x", content_text: "y" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("content_json");
      expect(r.reason).toContain("索引订阅");
    }
  });

  it("不是对象 / 是数组 / 是空 → 一律报「不是模板文件」，且给出两条替代路", () => {
    for (const raw of [null, [], "字符串", 42]) {
      const r = parseTemplatePayload(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain("不是模板文件");
        expect(r.reason).toContain("主题目前没有文件格式");
      }
    }
  });

  it("缺 name/category 用默认值（不因此拒绝：这两个只是给人看的标签）", () => {
    const r = parseTemplatePayload({ content_json: "{}" });
    expect(r).toEqual({
      ok: true,
      template: { name: "导入的模板", category: "我的模板", content_json: "{}", content_text: "" },
    });
  });

  it("正文过长 → 拒绝并说清原因（模板是骨架，搬运正文请用笔记导入）", () => {
    const r = parseTemplatePayload({ content_json: "{}", content_text: "字".repeat(MAX_TEMPLATE_TEXT + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("模板是骨架");
  });
});

describe("templateManifest — 预览要说清「会创建什么」，这正是 import 与 save 的区别", () => {
  it("清单四行：会创建什么 / 内容 / 来源 / 边界", () => {
    const m = templateManifest({ ...tpl, content_text: "" }, "https://community.shuyo.cn/tpl.json");
    expect(m[0]).toBe("将创建：一个模板「周回顾」（分类：我的模板）");
    expect(m[1]).toBe("内容：只有结构、没有正文文字");
    expect(m[2]).toBe("来源：community.shuyo.cn");
    // 边界必须写明：导入模板不该看起来像"装了个插件"或"建了页面"
    expect(m[3]).toContain("不会创建任何页面，也不会安装任何插件");
  });

  it("有正文时报字符数", () => {
    const m = templateManifest(tpl, "https://community.shuyo.cn/tpl.json");
    expect(m[1]).toBe(`内容：${tpl.content_text.length} 个字符的正文骨架`);
  });

  it("来源取不出来时原样显示（不抛异常）", () => {
    const m = templateManifest(tpl, "不是地址");
    expect(m[2]).toBe("来源：不是地址");
  });
});
