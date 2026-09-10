// @ts-check
// 一方参考插件：**参数（下拉）+ 属性写入 + 优雅降级**。
//
// 值得抄的：
//   1. `properties.set` 要的是**属性 id**，不是名字——所以先 `properties.list()` 找到它；
//   2. **没有那个属性时不要失败，也不要偷偷建**：插件没有"新建属性定义"的能力，
//      所以这里退回标签（并在结果里说清走的是哪条路），用户永远知道发生了什么；
//   3. 写操作全是草稿：属性和标签都不会在你点确认之前落库。
register({
  id: "page-status.set",
  title: "设置当前页状态",
  description: "把当前打开的页面标成某个状态（属性优先，没有属性就用标签兜底）",
  params: [
    {
      name: "status",
      label: "状态",
      type: "select",
      options: ["待办", "进行中", "已完成"],
      required: true,
      default: "进行中"
    }
  ],
  run: function (args) {
    var status = String(args.status || "").trim();
    if (!status) return "没有选择状态";

    // 1) 先看有没有「状态」属性（按名字找；找不到就走标签）
    var attrs = api.properties.list();
    var target = null;
    for (var i = 0; i < attrs.length; i++) {
      if (attrs[i].name === "状态") { target = attrs[i]; break; }
    }

    if (target) {
      api.properties.set(target.id, status);
      return "已把当前页的「状态」设为 " + status + "（确认草稿后落库）";
    }

    // 2) 没有属性定义：用同名标签兜底（标签不需要预先定义）
    api.tags.add(status);
    return "这个空间还没有「状态」属性（插件不能新建属性定义），已改用 #" + status + " 标签兜底（确认草稿后落库）";
  }
});
