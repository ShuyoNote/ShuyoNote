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
    get: function(id) { return __capCall("pages.get", { id: id === undefined ? undefined : String(id) }); },
    search: function(q, limit) { return __capCall("pages.search", { q: q === undefined ? undefined : String(q), limit: limit === undefined ? 20 : Number(limit) }); },
    create: function(title, content, parentId) { return __capCall("pages.create", { title: title === undefined ? undefined : String(title), content: content === undefined ? undefined : String(content), parentId: parentId === undefined ? undefined : String(parentId) }); }
  },
  tags: {
    list: function() { return __capCall("tags.list", {}); },
    add: function(name, pageId) { return __capCall("tags.add", { name: name === undefined ? undefined : String(name), pageId: pageId === undefined ? undefined : String(pageId) }); }
  },
  backlinks: {
    list: function(pageId) { return __capCall("backlinks.list", { pageId: pageId === undefined ? undefined : String(pageId) }); }
  },
  files: {
    list: function(pageId) { return __capCall("files.list", { pageId: pageId === undefined ? undefined : String(pageId) }); }
  },
  editor: {
    insertText: function(text) { return __capCall("editor.insertText", { text: text === undefined ? undefined : String(text) }); }
  },
  blocks: {
    append: function(text, pageId) { return __capCall("blocks.append", { text: text === undefined ? undefined : String(text), pageId: pageId === undefined ? undefined : String(pageId) }); }
  },
  notify: function(message) { return __capCall("user.notify", { message: message === undefined ? undefined : String(message) }); },
  kv: {
    get: function(key, scope) { return __capCall("kv.get", { key: key === undefined ? undefined : String(key), scope: scope === undefined ? "space" : String(scope) }); },
    set: function(key, value, scope) { return __capCall("kv.set", { key: key === undefined ? undefined : String(key), value: value === undefined ? undefined : String(value), scope: scope === undefined ? "space" : String(scope) }); },
    remove: function(key, scope) { return __capCall("kv.remove", { key: key === undefined ? undefined : String(key), scope: scope === undefined ? "space" : String(scope) }); }
  },
  properties: {
    list: function() { return __capCall("properties.list", {}); },
    set: function(attrId, value, pageId) { return __capCall("properties.set", { attrId: attrId === undefined ? undefined : String(attrId), value: value === undefined ? undefined : String(value), pageId: pageId === undefined ? undefined : String(pageId) }); }
  },
  log: function(message, level) { return __capCall("log.write", { message: message === undefined ? undefined : String(message), level: level === undefined ? "info" : String(level) }); }
};
