import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { allowedUrl, learnSanitizeSchema } from "@/lib/markdown/sanitize-schema";

/**
 * The Learn renderer (spec-23). Works in a server component (the reader) and a client component
 * (the editor preview) alike — react-markdown renders synchronously and carries no state.
 *
 * `urlTransform` runs on every src/href: an image that is not `/api/images/<id>` and a link that
 * is not http(s)/relative is dropped, so a document can never pull a picture from elsewhere.
 * Tables get a scroll wrapper because a 390 px screen cannot hold a wide one, and headings get ids
 * so a chapter's table of contents can point at them.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function headingText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(headingText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return headingText((children as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}

const components: Components = {
  h1: ({ children }) => <h2 id={slugify(headingText(children))}>{children}</h2>,
  h2: ({ children }) => <h2 id={slugify(headingText(children))}>{children}</h2>,
  h3: ({ children }) => <h3 id={slugify(headingText(children))}>{children}</h3>,
  img: ({ src, alt, title }) => {
    const source = typeof src === "string" ? src : "";
    if (!allowedUrl(source, "src")) return null;
    return (
      <figure>
        {/* eslint-disable-next-line @next/next/no-img-element -- app-served, private image route */}
        <img src={source} alt={alt ?? ""} title={title} loading="lazy" decoding="async" />
        {title ? <figcaption>{title}</figcaption> : null}
      </figure>
    );
  },
  a: ({ href, children }) => {
    const target = typeof href === "string" ? href : "";
    if (!allowedUrl(target, "href")) return <span>{children}</span>;
    const external = /^https?:\/\//.test(target);
    return (
      <a
        href={target}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {children}
      </a>
    );
  },
  table: ({ children }) => (
    <div className="learn-table" role="region" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

export function Markdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={className ? `learn-prose ${className}` : "learn-prose"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, learnSanitizeSchema]]}
        components={components}
        urlTransform={(url, key) => (allowedUrl(url, key === "src" ? "src" : "href") ? url : "")}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
