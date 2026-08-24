import { parseMarkdown, type MdBlock, type MdInline } from "../lib/markdown";

// Render an AI reply's Markdown into safe React elements (no dangerouslySetInnerHTML).
function Inline({ nodes }: { nodes: MdInline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.kind) {
          case "text":
            return <span key={i}>{n.text}</span>;
          case "bold":
            return (
              <strong key={i}>
                <Inline nodes={n.children} />
              </strong>
            );
          case "italic":
            return (
              <em key={i}>
                <Inline nodes={n.children} />
              </em>
            );
          case "code":
            return <code key={i}>{n.text}</code>;
          case "link":
            return (
              <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
                {n.label}
              </a>
            );
          default:
            return <span key={i}>{String((n as MdInline & { text?: string }).text ?? "")}</span>;
        }
      })}
    </>
  );
}

function Block({ block }: { block: MdBlock }) {
  switch (block.kind) {
    case "p":
      return (
        <p className="md-p">
          <Inline nodes={block.children} />
        </p>
      );
    case "h1":
    case "h2":
    case "h3":
    case "h4": {
      const Tag = block.kind;
      return (
        <Tag className="md-h">
          <Inline nodes={block.children} />
        </Tag>
      );
    }
    case "ul":
      return (
        <ul className="md-ul">
          {block.items.map((it, i) => (
            <li key={i}>
              <Inline nodes={it} />
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="md-ol">
          {block.items.map((it, i) => (
            <li key={i}>
              <Inline nodes={it} />
            </li>
          ))}
        </ol>
      );
    case "quote":
      return (
        <blockquote className="md-quote">
          {block.children.map((b, i) => (
            <Block key={i} block={b} />
          ))}
        </blockquote>
      );
    case "code":
      return (
        <pre className="md-pre">
          <code>{block.text}</code>
        </pre>
      );
    case "hr":
      return <hr className="md-hr" />;
    default:
      return null;
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="md">
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  );
}
