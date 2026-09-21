import {
  $applyNodeReplacement,
  $getNodeByKey,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { platform } from "../../lib/platform";
import { api } from "../../lib/api";
import { inputDialog } from "../../store/input";
import { EXPORT_HASH_ATTR, EXPORT_MIME_ATTR } from "../../lib/exportInline";
import { blockIdOf, blockRevOf, withBlockId, withBlockRev } from "./blockIdHelpers";

export type SerializedWebBookmarkNode = Spread<
  { url: string; title: string; description: string; siteName: string; imageHash: string; imageMime: string; blockId?: string; blockRev?: number },
  SerializedLexicalNode
>;

// Block-level decorator for a webpage bookmark: a card showing the fetched
// Open Graph title/description/domain + a content-addressed preview image.
export class WebBookmarkNode extends DecoratorNode<JSX.Element> {
  __url: string;
  __title: string;
  __description: string;
  __siteName: string;
  __imageHash: string;
  __imageMime: string;
  /** 块身份（只有**顶层块**才有）。 */
  __blockId: string;
  /** 声明式块版本（Lamport）；`null` = 没有/不认识这个字段。 */
  __blockRev: number | null;

  static getType(): string {
    return "webbookmark";
  }

  static clone(node: WebBookmarkNode): WebBookmarkNode {
    return new WebBookmarkNode(
      node.__url,
      node.__title,
      node.__description,
      node.__siteName,
      node.__imageHash,
      node.__imageMime,
      node.__blockId,
      node.__key,
      node.__blockRev,
    );
  }

  constructor(
    url: string,
    title: string,
    description: string,
    siteName: string,
    imageHash: string,
    imageMime: string,
    blockId = "",
    key?: NodeKey,
    blockRev: number | null = null,
  ) {
    super(key);
    this.__url = url;
    this.__title = title;
    this.__description = description;
    this.__siteName = siteName;
    this.__imageHash = imageHash;
    this.__imageMime = imageMime;
    this.__blockId = blockId;
    this.__blockRev = blockRev;
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__blockId = (prevNode as WebBookmarkNode).__blockId;
    this.__blockRev = (prevNode as WebBookmarkNode).__blockRev;
  }

  getBlockId(): string {
    return this.__blockId;
  }

  setBlockId(blockId: string): void {
    const writable = this.getWritable();
    writable.__blockId = blockId;
  }

  getBlockRev(): number | null {
    return this.__blockRev;
  }

  setBlockRev(blockRev: number | null): void {
    const writable = this.getWritable();
    writable.__blockRev = blockRev;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const div = document.createElement("div");
    div.className = "editor-webbookmark";
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  decorate(): JSX.Element {
    return (
      <WebBookmarkCard
        nodeKey={this.getKey()}
        url={this.__url}
        title={this.__title}
        description={this.__description}
        siteName={this.__siteName}
        imageHash={this.__imageHash}
        imageMime={this.__imageMime}
      />
    );
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    // 导出的是**卡片本身**，不是一个裸链接。
    //
    // 原来这里只输出 `<div data-webbookmark="url">url</div>`，于是导出件（HTML 与 PDF）
    // 里标题、摘要、站点名、缩略图**全部丢失** —— 用户看到的就是"空的网页标签"。
    // 这里按编辑器里那套 class 产出同样的结构，样式由 `lib/print.ts` 的 BASE_CSS 提供
    // （导出件是独立文档，拿不到应用 CSS）。
    const card = document.createElement("div");
    card.className = "webbookmark-card";
    card.setAttribute("data-webbookmark", this.__url);

    if (this.__imageHash) {
      const thumb = document.createElement("div");
      thumb.className = "webbookmark-thumb";
      const img = document.createElement("img");
      img.setAttribute("alt", "");
      // 缩略图同样是内容寻址附件（编辑期靠 api.attachmentPath + convertFileSrc 解析），
      // 导出时留线索交给 lib/exportInline 内联。
      img.setAttribute(EXPORT_HASH_ATTR, this.__imageHash);
      if (this.__imageMime) img.setAttribute(EXPORT_MIME_ATTR, this.__imageMime);
      thumb.appendChild(img);
      card.appendChild(thumb);
    }

    const body = document.createElement("div");
    body.className = "webbookmark-body";

    const title = document.createElement("div");
    title.className = "webbookmark-title";
    const link = document.createElement("a");
    link.setAttribute("href", this.__url);
    link.textContent = this.__title || this.__url;
    title.appendChild(link);
    body.appendChild(title);

    if (this.__description) {
      const desc = document.createElement("div");
      desc.className = "webbookmark-desc";
      desc.textContent = this.__description;
      body.appendChild(desc);
    }

    const site = document.createElement("div");
    site.className = "webbookmark-site";
    const domain = document.createElement("span");
    domain.className = "webbookmark-domain";
    domain.textContent = this.__siteName || this.__url;
    site.appendChild(domain);
    body.appendChild(site);

    card.appendChild(body);
    return { element: card };
  }

  exportJSON(): SerializedWebBookmarkNode {
    return withBlockRev(
      withBlockId(
        {
          ...super.exportJSON(),
          type: "webbookmark",
          url: this.__url,
          title: this.__title,
          description: this.__description,
          siteName: this.__siteName,
          imageHash: this.__imageHash,
          imageMime: this.__imageMime,
          version: 1,
        },
        this.__blockId,
      ),
      this.__blockRev,
    );
  }

  static importJSON(serializedNode: SerializedWebBookmarkNode): WebBookmarkNode {
    return $createWebBookmarkNode(
      serializedNode.url,
      serializedNode.title,
      serializedNode.description,
      serializedNode.siteName,
      serializedNode.imageHash,
      serializedNode.imageMime,
      blockIdOf(serializedNode),
      blockRevOf(serializedNode),
    );
  }

  isInline(): false {
    return false;
  }
}

export function $createWebBookmarkNode(
  url: string,
  title = "",
  description = "",
  siteName = "",
  imageHash = "",
  imageMime = "",
  blockId?: string,
  blockRev: number | null = null,
): WebBookmarkNode {
  return $applyNodeReplacement(
    new WebBookmarkNode(url, title, description, siteName, imageHash, imageMime, blockId ?? "", undefined, blockRev),
  );
}

export function $isWebBookmarkNode(
  node: LexicalNode | null | undefined,
): node is WebBookmarkNode {
  return node instanceof WebBookmarkNode;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function WebBookmarkCard(props: {
  nodeKey: NodeKey;
  url: string;
  title: string;
  description: string;
  siteName: string;
  imageHash: string;
  imageMime: string;
}) {
  const [editor] = useLexicalComposerContext();
  const [meta, setMeta] = useState({
    title: props.title,
    description: props.description,
    siteName: props.siteName || hostOf(props.url),
    imageHash: props.imageHash,
  });
  const [imageSrc, setImageSrc] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch metadata lazily ONLY if the node has no persisted metadata yet.
  // On success, write it back into the node so a reload/remount never re-fetches
  // (this is what caused the "获取网页信息…" flash).
  useEffect(() => {
    if (props.title || props.imageHash) {
      setMeta({
        title: props.title,
        description: props.description,
        siteName: props.siteName || hostOf(props.url),
        imageHash: props.imageHash,
      });
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .fetchBookmarkMetadata(props.url)
      .then((m) => {
        if (!alive) return;
        const title = m.title || hostOf(props.url);
        const siteName = m.site_name || hostOf(props.url);
        setMeta({
          title,
          description: m.description,
          siteName,
          imageHash: m.image_hash,
        });
        // Replace the node with a fresh one carrying the fetched metadata, so it
        // persists and the card never re-fetches. (Writing fields on the frozen
        // node is read-only; replacing with a new node is the safe lexical way.)
        editor.update(() => {
          const cur = $getNodeByKey<WebBookmarkNode>(props.nodeKey);
          if (cur) {
            cur.replace(
              $createWebBookmarkNode(
                props.url,
                title,
                m.description,
                siteName,
                m.image_hash,
                m.image_mime,
              ),
            );
          }
        });
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.url]);

  // Resolve the content-addressed preview image to a local asset URL.
  useEffect(() => {
    if (!meta.imageHash) {
      setImageSrc("");
      return;
    }
    api
      .attachmentPath(meta.imageHash)
      .then((p) => setImageSrc(platform.asset.convertFileSrc(p)))
      .catch(() => setImageSrc(""));
  }, [meta.imageHash]);

  // Open the URL via the host's opener (system default browser). `window.open`
  // is blocked in the WebView, so the opener driver is the reliable way.
  const open = () => {
    platform.opener.openUrl(props.url).catch(() => {});
  };

  // Edit URL via the in-app dialog (immune to Lexical decorator re-renders).
  // Replaces the node with a fresh one carrying the new URL.
  const openEditorDialog = () => {
    inputDialog({
      title: "编辑网址",
      placeholder: "输入网址（URL）",
      defaultValue: props.url,
      okLabel: "保存",
      onSubmit: (raw) => {
        let u = raw.trim();
        if (!u || u === props.url) return;
        if (!u.includes("://")) u = `https://${u}`;
        editor.update(() => {
          const cur = $getNodeByKey<WebBookmarkNode>(props.nodeKey);
          if (cur) {
            cur.replace($createWebBookmarkNode(u));
          }
        });
      },
    });
  };

  return (
    <div
      className="webbookmark-card"
      onClick={open}
      onMouseDown={(e) => {
        // Prevent Lexical from intercepting mousedown inside the decorator,
        // otherwise it re-selects/re-renders the node (and could swallow clicks).
        e.preventDefault();
      }}
      title={props.url}
    >
      {imageSrc && (
        <div className="webbookmark-thumb">
          <img src={imageSrc} alt="" loading="lazy" />
        </div>
      )}
      <div className="webbookmark-body">
        <div className="webbookmark-title">
          {loading ? "获取网页信息…" : meta.title || hostOf(props.url)}
        </div>
        {meta.description && !loading && (
          <div className="webbookmark-desc">{meta.description}</div>
        )}
        <div className="webbookmark-site">
          {error ? <span className="webbookmark-err">无法获取摘要</span> : null}
          <span className="webbookmark-domain">{meta.siteName}</span>
        </div>
        <button
          className="webbookmark-edit-trigger"
          title="编辑网址"
          onClick={(e) => {
            e.stopPropagation();
            openEditorDialog();
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          ✎
        </button>
      </div>
    </div>
  );
}
