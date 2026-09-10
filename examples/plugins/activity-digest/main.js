// 活动摘要 —— 订阅两个**后台事件**：同步完成、附件导入完成。
//
// 为什么这两个事件值得单独做示例：它们和 `page.saved` 那种"用户做了个动作"不同——
// 同步是后台按 5 分钟一轮在跑的（useAutoSync），附件导入也可能由别的界面发起，
// 用户**看不到**它们有没有发生。事件是插件唯一能知道"刚才真的动过"的途径。
//
// 用到的东西都在这儿了：
//   on(...)        订阅事件（manifest 里也要声明，两处都在才算数——用户启用前看得到）
//   api.log(...)   写插件自己的日志（不需要权限）
//   api.notify(...) 提示用户（不需要权限）
//   api.kv         插件自己的小数据区（要 kv:own 权限）
//   register(...)  命令（用户在命令面板里点）

var KEY_SYNC_PUSH = "syncPushed";
var KEY_SYNC_PULL = "syncPulled";
var KEY_IMPORTED = "importedFiles";

/** @param {string} key @param {number} n */
function bump(key, n) {
  var cur = Number(api.kv.get(key) || 0);
  var next = cur + n;
  api.kv.set(key, String(next)); // kv 存的是字符串（按需自己转）
  return next;
}

on("sync.completed", function (payload) { // payload: { pushed, pulled }
  var pushed = Number(payload.pushed || 0);
  var pulled = Number(payload.pulled || 0);
  var totalPush = bump(KEY_SYNC_PUSH, pushed);
  var totalPull = bump(KEY_SYNC_PULL, pulled);

  api.log("同步完成：本次推 " + pushed + " / 拉 " + pulled + "；累计推 " + totalPush + " / 拉 " + totalPull);

  // 只在**真的动了**的时候提示：每 5 分钟一次的自动同步如果每次都弹一下，那是在打扰人。
  if (pushed + pulled > 0) {
    api.notify("同步完成：推 " + pushed + " / 拉 " + pulled);
  }
});

on("import.finished", function (payload) { // payload: { count, pageId }
  var count = Number(payload.count || 0);
  var pageId = payload.pageId ? String(payload.pageId) : "(不属于页面：封面/画布)";
  var total = bump(KEY_IMPORTED, count);
  api.log("导入完成：本次 " + count + " 份 → " + pageId + "；累计导入 " + total + " 份");
});

register({
  id: "digest.show",
  title: "看活动摘要",
  run: function () {
    var pushed = Number(api.kv.get(KEY_SYNC_PUSH) || 0);
    var pulled = Number(api.kv.get(KEY_SYNC_PULL) || 0);
    var imported = Number(api.kv.get(KEY_IMPORTED) || 0);
    if (pushed + pulled + imported === 0) {
      return "还没有记录：同步或导入附件之后再看（日志里也有每一条明细）";
    }
    return "累计：推送 " + pushed + " 条、拉取 " + pulled + " 条、导入附件 " + imported + " 份";
  }
});

register({
  id: "digest.reset",
  title: "清空活动摘要",
  run: function () {
    api.kv.remove(KEY_SYNC_PUSH);
    api.kv.remove(KEY_SYNC_PULL);
    api.kv.remove(KEY_IMPORTED);
    return "已清空累计计数（插件日志里的历史明细不受影响）";
  }
});
