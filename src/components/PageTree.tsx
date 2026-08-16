import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import type { PageMeta } from "../types";
import { SearchPanel } from "./SearchPanel";
import { SyncPanel } from "./SyncPanel";
import { TrashPanel } from "./TrashPanel";

interface TreeNode extends PageMeta {
  children: TreeNode[];
}

function buildTree(pages: PageMeta[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  for (const p of pages) map.set(p.id, { ...p, children: [] });
  const roots: TreeNode[] = [];
  for (const p of map.values()) {
    if (p.parent_id && map.has(p.parent_id)) {
      map.get(p.parent_id)!.children.push(p);
    } else {
      roots.push(p);
    }
  }
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at);
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

function TreeItem({
  node,
  depth,
}: {
  node: TreeNode;
  depth: number;
}) {
  const { currentId, openPage, createPage, createFolder, deletePage, movePage } = useNotes();
  const [expanded, setExpanded] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const isCurrent = currentId === node.id;
  const isFolder = node.kind === "folder";

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const id = e.dataTransfer.getData("text/plain");
    if (id && id !== node.id) {
      await movePage(id, node.id, Date.now());
    }
  };

  const handleClick = () => {
    if (isFolder) {
      setExpanded((v) => !v);
    } else {
      openPage(node.id);
    }
  };

  return (
    <div>
      <div
        className={`tree-row ${isCurrent ? "tree-row-active" : ""} ${dragOver ? "tree-row-over" : ""}`}
        style={{ paddingLeft: depth * 16 + 8 }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", node.id);
          setDragging(true);
        }}
        onDragEnd={() => setDragging(false)}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={handleClick}
      >
        <span
          className="tree-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {node.children.length > 0 ? (expanded ? "▾" : "▸") : "·"}
        </span>
        <span className="tree-icon">{isFolder ? "📁" : "📄"}</span>
        <span className="tree-title">{node.title || (isFolder ? "新建文件夹" : "未命名")}</span>
        <span className="tree-actions">
          <button
            title="新建子页面"
            onClick={(e) => {
              e.stopPropagation();
              createPage(node.id);
            }}
          >
            +
          </button>
          {isFolder && (
            <button
              title="新建子文件夹"
              onClick={(e) => {
                e.stopPropagation();
                createFolder(node.id);
              }}
            >
              📁
            </button>
          )}
          <button
            title="删除"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`删除「${node.title || "未命名"}」及其所有子节点？`)) {
                deletePage(node.id);
              }
            }}
          >
            ×
          </button>
        </span>
      </div>
      {expanded &&
        node.children.map((child) => (
          <TreeItem key={child.id} node={child} depth={depth + 1} />
        ))}
      {dragging && null}
    </div>
  );
}

export function PageTree() {
  const { pages, createPage, createFolder } = useNotes();
  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [taggedIds, setTaggedIds] = useState<Set<string> | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);

  useEffect(() => {
    api.listTags().then(setTags).catch(() => {});
  }, []);

  useEffect(() => {
    if (activeTag) {
      api.pagesByTag(activeTag).then((ps) => setTaggedIds(new Set(ps.map((p) => p.id))));
    } else {
      setTaggedIds(null);
    }
  }, [activeTag]);

  const visiblePages = useMemo(() => {
    if (!taggedIds) return pages;
    return pages.filter((p) => taggedIds.has(p.id));
  }, [pages, taggedIds]);

  const tree = useMemo(() => buildTree(visiblePages), [visiblePages]);

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">ShuyoNote</span>
        <div className="sidebar-header-actions">
          <TrashPanel />
          <SyncPanel />
          <div className="new-menu">
            <button className="btn-new" onClick={() => setNewMenuOpen((v) => !v)}>
              新建 ▾
            </button>
            {newMenuOpen && (
              <div className="new-menu-dropdown">
                <button
                  onClick={() => {
                    setNewMenuOpen(false);
                    createPage(null);
                  }}
                >
                  📄 新建页面
                </button>
                <button
                  onClick={() => {
                    setNewMenuOpen(false);
                    createFolder(null);
                  }}
                >
                  📁 新建文件夹
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="sidebar-search">
        <SearchPanel />
      </div>
      {tags.length > 0 && (
        <div className="sidebar-tags">
          <button
            className={`tag-filter ${activeTag === null ? "tag-filter-active" : ""}`}
            onClick={() => setActiveTag(null)}
          >
            全部
          </button>
          {tags.map((t) => (
            <button
              key={t.id}
              className={`tag-filter ${activeTag === t.id ? "tag-filter-active" : ""}`}
              onClick={() => setActiveTag(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}
      <div className="sidebar-tree">
        {tree.length === 0 ? (
          <div className="sidebar-empty">
            {activeTag ? "该标签下暂无页面" : "暂无页面，点击「新建页面」开始"}
          </div>
        ) : (
          tree.map((node) => <TreeItem key={node.id} node={node} depth={0} />)
        )}
      </div>
    </div>
  );
}
