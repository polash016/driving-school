import { defaultSchema, type Options as SanitizeOptions } from "rehype-sanitize";

/**
 * The one sanitise schema for Learn content (spec-23 C3/C6): the editor's preview and the
 * student reader import THIS and nothing else, so what an admin sees is what a student gets.
 *
 * Admin-authored, still sanitised: an image may only be one this app serves, a link only http(s)
 * or relative, and no raw HTML survives — `rehype-sanitize` strips script/style/iframe already,
 * and the defaults below narrow it further.
 */
export const IMAGE_SRC_PATTERN = /^\/api\/images\/[A-Za-z0-9]+$/;
const LINK_PATTERN = /^(https?:\/\/|\/(?!\/)|#)/;

const base = defaultSchema;

export const learnSanitizeSchema: SanitizeOptions = {
  ...base,
  tagNames: [
    "p", "br", "strong", "em", "del", "blockquote", "hr",
    "h2", "h3", "h4",
    "ul", "ol", "li",
    "table", "thead", "tbody", "tr", "th", "td",
    "a", "img", "code", "pre",
  ],
  attributes: {
    ...base.attributes,
    a: ["href", "title"],
    img: ["src", "alt", "title"],
    th: ["align"],
    td: ["align"],
    // Every element may carry the ids react-markdown adds for headings — nothing else.
    "*": ["id"],
  },
  protocols: { ...base.protocols, href: ["http", "https"], src: [] },
  clobberPrefix: "learn-",
  strip: ["script", "style", "iframe", "object", "embed", "form", "input", "button"],
};

/** Applied AFTER sanitising: a src or href the schema let through still has to match ours. */
export function allowedUrl(url: string, kind: "src" | "href"): boolean {
  return kind === "src" ? IMAGE_SRC_PATTERN.test(url) : LINK_PATTERN.test(url);
}
