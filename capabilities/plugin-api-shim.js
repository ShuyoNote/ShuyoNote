// 本文件由 scripts/gen-capabilities.mjs 生成（源：capabilities/capabilities.json）——请勿手改。
// 插件代码里能看到的唯一 ABI 面。宿主只认 `__cap(method, argsJson)` 这一个原语，
// 所以换引擎/加传输都不破坏插件（见方案 §3.3）。

function __capCall(method, args) {
  // 宿主统一返回 JSON 字符串：能解析就解析，不能就原样返回（保持宽容）。
  var raw = __cap(method, JSON.stringify(args || {}));
  try { return JSON.parse(raw); } catch (e) { return raw; }
}

var api = {
  page: {
    current: function() { return __capCall("page.current", {}); }
  },
  pages: {
    count: function() { return __capCall("pages.count", {}); }
  },
  editor: {
    insertText: function(text) { return __capCall("editor.insertText", { text: String(text) }); }
  },
  notify: function(message) { return __capCall("user.notify", { message: String(message) }); },
  log: function(message, level) { return __capCall("log.write", { message: String(message), level: level === undefined ? "info" : String(level) }); }
};
