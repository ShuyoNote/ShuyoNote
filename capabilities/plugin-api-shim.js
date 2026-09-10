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
    count: function() { return __capCall("pages.count", {}); },
    list: function(limit) { return __capCall("pages.list", { limit: limit === undefined ? 50 : Number(limit) }); },
    get: function(id) { return __capCall("pages.get", { id: String(id) }); },
    search: function(q, limit) { return __capCall("pages.search", { q: String(q), limit: limit === undefined ? 20 : Number(limit) }); }
  },
  tags: {
    list: function() { return __capCall("tags.list", {}); }
  },
  backlinks: {
    list: function(pageId) { return __capCall("backlinks.list", { pageId: String(pageId) }); }
  },
  files: {
    list: function(pageId) { return __capCall("files.list", { pageId: String(pageId) }); }
  },
  editor: {
    insertText: function(text) { return __capCall("editor.insertText", { text: String(text) }); }
  },
  notify: function(message) { return __capCall("user.notify", { message: String(message) }); },
  kv: {
    get: function(key, scope) { return __capCall("kv.get", { key: String(key), scope: scope === undefined ? "space" : String(scope) }); },
    set: function(key, value, scope) { return __capCall("kv.set", { key: String(key), value: String(value), scope: scope === undefined ? "space" : String(scope) }); },
    remove: function(key, scope) { return __capCall("kv.remove", { key: String(key), scope: scope === undefined ? "space" : String(scope) }); }
  },
  log: function(message, level) { return __capCall("log.write", { message: String(message), level: level === undefined ? "info" : String(level) }); }
};
