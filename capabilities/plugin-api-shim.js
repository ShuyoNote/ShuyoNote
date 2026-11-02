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
    current: function(includeAnchors) { return __capCall("page.current", { includeAnchors: includeAnchors === undefined ? true : String(includeAnchors) }); }
  },
  pages: {
    count: function(spaceId) { return __capCall("pages.count", { spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    list: function(limit, spaceId) { return __capCall("pages.list", { limit: limit === undefined ? 50 : Number(limit), spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    changesSince: function(since, spaceId, limit) { return __capCall("pages.changes_since", { since: since === undefined ? undefined : Number(since), spaceId: spaceId === undefined ? undefined : String(spaceId), limit: limit === undefined ? undefined : Number(limit) }); },
    get: function(id, offset, limit, includeAnchors, spaceId) { return __capCall("pages.get", { id: id === undefined ? undefined : String(id), offset: offset === undefined ? 0 : Number(offset), limit: limit === undefined ? 6000 : Number(limit), includeAnchors: includeAnchors === undefined ? true : String(includeAnchors), spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    search: function(q, spaceId, limit) { return __capCall("pages.search", { q: q === undefined ? undefined : String(q), spaceId: spaceId === undefined ? undefined : String(spaceId), limit: limit === undefined ? 8 : Number(limit) }); },
    tree: function(spaceId, limit) { return __capCall("pages.tree", { spaceId: spaceId === undefined ? undefined : String(spaceId), limit: limit === undefined ? 2000 : Number(limit) }); },
    create: function(title, content, parentId, fence, dryRun, clientRequestId, spaceId) { return __capCall("pages.create", { title: title === undefined ? undefined : String(title), content: content === undefined ? undefined : String(content), parentId: parentId === undefined ? undefined : String(parentId), fence: fence === undefined ? undefined : String(fence), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId), spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    revert: function(pageId, versionId, expectedRev, spaceId, dryRun, clientRequestId) { return __capCall("pages.revert", { pageId: pageId === undefined ? undefined : String(pageId), versionId: versionId === undefined ? undefined : String(versionId), expectedRev: expectedRev === undefined ? undefined : String(expectedRev), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); },
    importMarkdown: function(title, markdown, parentId, dryRun, clientRequestId) { return __capCall("pages.importMarkdown", { title: title === undefined ? undefined : String(title), markdown: markdown === undefined ? undefined : String(markdown), parentId: parentId === undefined ? undefined : String(parentId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); },
    import_markdown: function(title, markdown, parentId, dryRun, clientRequestId) { return __capCall("pages.import_markdown", { title: title === undefined ? undefined : String(title), markdown: markdown === undefined ? undefined : String(markdown), parentId: parentId === undefined ? undefined : String(parentId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); },
    update: function(id, markdown, content, title, expectedRev, dryRun, clientRequestId, spaceId) { return __capCall("pages.update", { id: id === undefined ? undefined : String(id), markdown: markdown === undefined ? undefined : String(markdown), content: content === undefined ? undefined : String(content), title: title === undefined ? undefined : String(title), expectedRev: expectedRev === undefined ? undefined : String(expectedRev), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId), spaceId: spaceId === undefined ? undefined : String(spaceId) }); }
  },
  db: {
    schema: function(pageId, spaceId) { return __capCall("db.schema", { pageId: pageId === undefined ? undefined : String(pageId), spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    rows: function(pageId, viewId, where, limit, offset, spaceId) { return __capCall("db.rows", { pageId: pageId === undefined ? undefined : String(pageId), viewId: viewId === undefined ? undefined : String(viewId), where: where === undefined ? undefined : where, limit: limit === undefined ? 100 : Number(limit), offset: offset === undefined ? 0 : Number(offset), spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    rows_write: function(pageId, rows, expectedRev, spaceId, dryRun, clientRequestId) { return __capCall("db.rows_write", { pageId: pageId === undefined ? undefined : String(pageId), rows: rows === undefined ? undefined : rows, expectedRev: expectedRev === undefined ? undefined : String(expectedRev), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); },
    rows_delete: function(pageId, rowIds, expectedRev, spaceId, dryRun, clientRequestId) { return __capCall("db.rows_delete", { pageId: pageId === undefined ? undefined : String(pageId), rowIds: rowIds === undefined ? undefined : rowIds, expectedRev: expectedRev === undefined ? undefined : String(expectedRev), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); }
  },
  versions: {
    list: function(pageId, limit, spaceId) { return __capCall("versions.list", { pageId: pageId === undefined ? undefined : String(pageId), limit: limit === undefined ? 50 : Number(limit), spaceId: spaceId === undefined ? undefined : String(spaceId) }); }
  },
  version: {
    get: function(pageId, versionId, offset, limit, includeAnchors, spaceId) { return __capCall("version.get", { pageId: pageId === undefined ? undefined : String(pageId), versionId: versionId === undefined ? undefined : String(versionId), offset: offset === undefined ? 0 : Number(offset), limit: limit === undefined ? 6000 : Number(limit), includeAnchors: includeAnchors === undefined ? true : String(includeAnchors), spaceId: spaceId === undefined ? undefined : String(spaceId) }); }
  },
  trash: {
    list: function(spaceId, limit) { return __capCall("trash.list", { spaceId: spaceId === undefined ? undefined : String(spaceId), limit: limit === undefined ? 50 : Number(limit) }); },
    restore: function(id, spaceId, dryRun, clientRequestId) { return __capCall("trash.restore", { id: id === undefined ? undefined : String(id), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); }
  },
  drafts: {
    status: function(draftId) { return __capCall("drafts.status", { draftId: draftId === undefined ? undefined : String(draftId) }); }
  },
  audit: {
    tail: function(limit, onlyWrites) { return __capCall("audit.tail", { limit: limit === undefined ? undefined : Number(limit), onlyWrites: onlyWrites === undefined ? undefined : String(onlyWrites) }); }
  },
  tags: {
    list: function(spaceId) { return __capCall("tags.list", { spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    add: function(name, pageId, expectedRev, spaceId, dryRun, clientRequestId) { return __capCall("tags.add", { name: name === undefined ? undefined : String(name), pageId: pageId === undefined ? undefined : String(pageId), expectedRev: expectedRev === undefined ? undefined : String(expectedRev), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); },
    remove: function(name, pageId, expectedRev, spaceId, dryRun, clientRequestId) { return __capCall("tags.remove", { name: name === undefined ? undefined : String(name), pageId: pageId === undefined ? undefined : String(pageId), expectedRev: expectedRev === undefined ? undefined : String(expectedRev), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); }
  },
  blocks: {
    list: function(pageId, limit, spaceId) { return __capCall("blocks.list", { pageId: pageId === undefined ? undefined : String(pageId), limit: limit === undefined ? 100 : Number(limit), spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    append: function(text, pageId, fence, expectedRev, dryRun, clientRequestId, spaceId) { return __capCall("blocks.append", { text: text === undefined ? undefined : String(text), pageId: pageId === undefined ? undefined : String(pageId), fence: fence === undefined ? undefined : String(fence), expectedRev: expectedRev === undefined ? undefined : String(expectedRev), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId), spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    patch: function(blockId, markdown, text, expectedRev, spaceId, dryRun, clientRequestId) { return __capCall("blocks.patch", { blockId: blockId === undefined ? undefined : String(blockId), markdown: markdown === undefined ? undefined : String(markdown), text: text === undefined ? undefined : String(text), expectedRev: expectedRev === undefined ? undefined : String(expectedRev), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); },
    insert: function(pageId, afterBlockId, markdown, text, expectedRev, spaceId, dryRun, clientRequestId) { return __capCall("blocks.insert", { pageId: pageId === undefined ? undefined : String(pageId), afterBlockId: afterBlockId === undefined ? undefined : String(afterBlockId), markdown: markdown === undefined ? undefined : String(markdown), text: text === undefined ? undefined : String(text), expectedRev: expectedRev === undefined ? undefined : String(expectedRev), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); },
    delete: function(blockId, expectedRev, spaceId, dryRun, clientRequestId) { return __capCall("blocks.delete", { blockId: blockId === undefined ? undefined : String(blockId), expectedRev: expectedRev === undefined ? undefined : String(expectedRev), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); }
  },
  backlinks: {
    list: function(pageId) { return __capCall("backlinks.list", { pageId: pageId === undefined ? undefined : String(pageId) }); }
  },
  files: {
    list: function(pageId, spaceId) { return __capCall("files.list", { pageId: pageId === undefined ? undefined : String(pageId), spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    search: function(query, limit, spaceId) { return __capCall("files.search", { query: query === undefined ? undefined : String(query), limit: limit === undefined ? 10 : Number(limit), spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    read: function(id, offset, limit, spaceId) { return __capCall("files.read", { id: id === undefined ? undefined : String(id), offset: offset === undefined ? 0 : Number(offset), limit: limit === undefined ? 200 : Number(limit), spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    stat: function(attId, spaceId) { return __capCall("files.stat", { attId: attId === undefined ? undefined : String(attId), spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    extract_status: function(attId, spaceId) { return __capCall("files.extract_status", { attId: attId === undefined ? undefined : String(attId), spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    list_orphan: function(limit, offset, spaceId) { return __capCall("files.list_orphan", { limit: limit === undefined ? 50 : Number(limit), offset: offset === undefined ? 0 : Number(offset), spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    export: function(fileName, content) { return __capCall("files.export", { fileName: fileName === undefined ? undefined : String(fileName), content: content === undefined ? undefined : String(content) }); },
    move: function(attId, toPageId, expectedSha, spaceId, dryRun, clientRequestId) { return __capCall("files.move", { attId: attId === undefined ? undefined : String(attId), toPageId: toPageId === undefined ? undefined : String(toPageId), expectedSha: expectedSha === undefined ? undefined : String(expectedSha), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); },
    rename: function(attId, name, expectedSha, spaceId, dryRun, clientRequestId) { return __capCall("files.rename", { attId: attId === undefined ? undefined : String(attId), name: name === undefined ? undefined : String(name), expectedSha: expectedSha === undefined ? undefined : String(expectedSha), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); },
    delete: function(attId, expectedSha, spaceId, dryRun, clientRequestId) { return __capCall("files.delete", { attId: attId === undefined ? undefined : String(attId), expectedSha: expectedSha === undefined ? undefined : String(expectedSha), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); },
    upload_to_page: function(pageId, name, spaceId, dryRun, clientRequestId) { return __capCall("files.upload_to_page", { pageId: pageId === undefined ? undefined : String(pageId), name: name === undefined ? undefined : String(name), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); },
    detach: function(attId, spaceId, dryRun, clientRequestId) { return __capCall("files.detach", { attId: attId === undefined ? undefined : String(attId), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); },
    download: function(attId, spaceId) { return __capCall("files.download", { attId: attId === undefined ? undefined : String(attId), spaceId: spaceId === undefined ? undefined : String(spaceId) }); }
  },
  coverage: {
    report: function(spaceId) { return __capCall("coverage.report", { spaceId: spaceId === undefined ? undefined : String(spaceId) }); }
  },
  editor: {
    insertText: function(text) { return __capCall("editor.insertText", { text: text === undefined ? undefined : String(text) }); }
  },
  notify: function(message) { return __capCall("user.notify", { message: message === undefined ? undefined : String(message) }); },
  kv: {
    get: function(key, scope) { return __capCall("kv.get", { key: key === undefined ? undefined : String(key), scope: scope === undefined ? "space" : String(scope) }); },
    set: function(key, value, scope) { return __capCall("kv.set", { key: key === undefined ? undefined : String(key), value: value === undefined ? undefined : String(value), scope: scope === undefined ? "space" : String(scope) }); },
    remove: function(key, scope) { return __capCall("kv.remove", { key: key === undefined ? undefined : String(key), scope: scope === undefined ? "space" : String(scope) }); }
  },
  settings: {
    get: function(key) { return __capCall("settings.get", { key: key === undefined ? undefined : String(key) }); }
  },
  properties: {
    list: function(spaceId) { return __capCall("properties.list", { spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    set: function(attrId, value, pageId, expectedRev, spaceId, dryRun, clientRequestId) { return __capCall("properties.set", { attrId: attrId === undefined ? undefined : String(attrId), value: value === undefined ? undefined : String(value), pageId: pageId === undefined ? undefined : String(pageId), expectedRev: expectedRev === undefined ? undefined : String(expectedRev), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); },
    unset: function(attrId, pageId, expectedRev, spaceId, dryRun, clientRequestId) { return __capCall("properties.unset", { attrId: attrId === undefined ? undefined : String(attrId), pageId: pageId === undefined ? undefined : String(pageId), expectedRev: expectedRev === undefined ? undefined : String(expectedRev), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); }
  },
  log: function(message, level) { return __capCall("log.write", { message: message === undefined ? undefined : String(message), level: level === undefined ? "info" : String(level) }); },
  templates: {
    list: function() { return __capCall("templates.list", {}); },
    apply: function(templateId, parentId, spaceId, dryRun, clientRequestId) { return __capCall("templates.apply", { templateId: templateId === undefined ? undefined : String(templateId), parentId: parentId === undefined ? undefined : String(parentId), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); }
  },
  import: {
    docpackage: function(parentId, spaceId, dryRun, clientRequestId) { return __capCall("import.docpackage", { parentId: parentId === undefined ? undefined : String(parentId), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); }
  },
  folders: {
    create: function(title, parentId, spaceId, dryRun, clientRequestId) { return __capCall("folders.create", { title: title === undefined ? undefined : String(title), parentId: parentId === undefined ? undefined : String(parentId), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); }
  },
  nodes: {
    move: function(id, newParentId, sortOrder, expectedRev, spaceId, dryRun, clientRequestId) { return __capCall("nodes.move", { id: id === undefined ? undefined : String(id), newParentId: newParentId === undefined ? undefined : String(newParentId), sortOrder: sortOrder === undefined ? undefined : Number(sortOrder), expectedRev: expectedRev === undefined ? undefined : String(expectedRev), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); },
    rename: function(id, title, expectedRev, spaceId, dryRun, clientRequestId) { return __capCall("nodes.rename", { id: id === undefined ? undefined : String(id), title: title === undefined ? undefined : String(title), expectedRev: expectedRev === undefined ? undefined : String(expectedRev), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); },
    delete: function(id, expectedRev, spaceId, dryRun, clientRequestId) { return __capCall("nodes.delete", { id: id === undefined ? undefined : String(id), expectedRev: expectedRev === undefined ? undefined : String(expectedRev), spaceId: spaceId === undefined ? undefined : String(spaceId), dryRun: dryRun === undefined ? undefined : String(dryRun), clientRequestId: clientRequestId === undefined ? undefined : String(clientRequestId) }); }
  },
  blobs: {
    fetch: function(handle) { return __capCall("blobs.fetch", { handle: handle === undefined ? undefined : String(handle) }); }
  },
  export: {
    markdown: function(pageId, spaceId) { return __capCall("export.markdown", { pageId: pageId === undefined ? undefined : String(pageId), spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    pageMarkdown: function(pageId, spaceId) { return __capCall("export.page_markdown", { pageId: pageId === undefined ? undefined : String(pageId), spaceId: spaceId === undefined ? undefined : String(spaceId) }); },
    spaceMarkdown: function(spaceId, pageId) { return __capCall("export.space_markdown", { spaceId: spaceId === undefined ? undefined : String(spaceId), pageId: pageId === undefined ? undefined : String(pageId) }); },
    docpackage: function(pageId, spaceId) { return __capCall("export.docpackage", { pageId: pageId === undefined ? undefined : String(pageId), spaceId: spaceId === undefined ? undefined : String(spaceId) }); }
  },
  spaces: {
    list: function() { return __capCall("spaces.list", {}); },
    switch: function(id, name) { return __capCall("spaces.switch", { id: id === undefined ? undefined : String(id), name: name === undefined ? undefined : String(name) }); }
  },
  space: {
    current: function() { return __capCall("space.current", {}); }
  }
};
