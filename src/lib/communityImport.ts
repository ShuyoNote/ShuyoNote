// 深链 `import` 那一支：把社区托管的**模板文件**读回来，先给清单，再交给模板中心落库。
//
// 为什么单独一层，而不是复用"存笔记"那条：**动作不同、承诺不同**（社区方案第七节）——
//   · `save`：把一篇帖子存成笔记（有来源、有正文）；
//   · `import`：把一个产物**导入**应用（模板/主题/插件），预览里要能看清"装进来的是什么、
//     会创建什么、来自谁"。
// 之前我把这两支合并成同一条路了（`import` 被当成 `save` 执行）——那是个真错误：
// 用户点"导入模板"，应用却去存一篇笔记，而且**不报错**。这份模块就是把它分开。
//
// 当前应用**能导入什么**（如实写，别承诺做不到的）：
//   · **模板**：模板中心本来就有导出/导入（`TemplateCenterView` 的导出格式就是下面这个形状），
//     所以这条路是现成的载体，不是新造的；
//   · **主题**：没有文件格式（只是 localStorage 里两个偏好）→ 说清"还没做"，不要假装成功；
//   · **插件**：属于"分发"，走索引订阅那条路（它有签名、撤回、权限清单），不从深链直接装。

export interface ImportedTemplate {
  name: string;
  category: string;
  content_json: string;
  content_text: string;
}

export type TemplateParseResult =
  | { ok: true; template: ImportedTemplate }
  | { ok: false; reason: string };

/** 模板正文长度上限：模板是"骨架"，不是内容搬运（搬运走笔记导入）。 */
export const MAX_TEMPLATE_TEXT = 200_000;

/**
 * 解析一份模板文件（纯函数）。
 *
 * 判定标准就是我们**自己的导出格式**（`content_json` 必须是字符串）——这是唯一可靠的判据：
 * 一个"看起来像 JSON"的东西不该被当成模板导进来（导进来之后用户在模板中心看到一片空白，
 * 而没人知道为什么）。所以缺字段一律**报错并说清缺什么**。
 */
export function parseTemplatePayload(raw: unknown): TemplateParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      reason:
        "这个地址返回的不是模板文件（模板是应用「模板中心 → 导出」生成的那份 JSON）。" +
        "要装插件请用插件管理里的索引订阅；主题目前没有文件格式。",
    };
  }
  const o = raw as Record<string, unknown>;
  const contentJson = typeof o.content_json === "string" ? o.content_json : "";
  if (!contentJson.trim()) {
    return {
      ok: false,
      reason:
        "这份文件里没有 `content_json`（模板的正文骨架）——不是应用导出的模板文件。" +
        "要装插件请用插件管理里的索引订阅。",
    };
  }
  const contentText = typeof o.content_text === "string" ? o.content_text : "";
  if (contentText.length > MAX_TEMPLATE_TEXT) {
    return {
      ok: false,
      reason: `模板正文过长（${contentText.length} 字，上限 ${MAX_TEMPLATE_TEXT}）——模板是骨架，搬运正文请用笔记导入`,
    };
  }
  const name = (typeof o.name === "string" && o.name.trim()) || "导入的模板";
  const category = (typeof o.category === "string" && o.category.trim()) || "我的模板";
  return { ok: true, template: { name, category, content_json: contentJson, content_text: contentText } };
}

/** 预览用的一句话清单：**会创建什么**要写在最前面（这正是 `import` 与 `save` 的区别）。 */
export function templateManifest(t: ImportedTemplate, sourceUrl: string): string[] {
  const host = (() => {
    try {
      return new URL(sourceUrl).hostname;
    } catch {
      return sourceUrl;
    }
  })();
  const textLen = t.content_text.trim().length;
  return [
    `将创建：一个模板「${t.name}」（分类：${t.category}）`,
    textLen > 0 ? `内容：${textLen} 个字符的正文骨架` : "内容：只有结构、没有正文文字",
    `来源：${host}`,
    "导入后可在「模板中心」找到；不会创建任何页面，也不会安装任何插件。",
  ];
}
