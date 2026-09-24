import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

const render = (source: string) => renderToStaticMarkup(<Markdown source={source} />);

describe("Learn markdown renderer", () => {
  it("renders headings with ids, lists, tables and app images", () => {
    const html = render("## Right of way\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n![Sign 206](/api/images/abc123 \"Priority road\")");
    expect(html).toContain('<h2 id="right-of-way">Right of way</h2>');
    expect(html).toContain("<li>a</li>");
    expect(html).toContain('class="learn-table"');
    expect(html).toContain('src="/api/images/abc123"');
    expect(html).toContain("<figcaption>Priority road</figcaption>");
  });

  it("drops scripts, raw html, foreign images and javascript links", () => {
    const html = render(
      "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n![x](https://evil.example/x.png)\n\n[click](javascript:alert(1))\n\n<iframe src=\"https://evil\"></iframe>\n\nplain **bold**",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<iframe");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("opens external links in a new tab with noopener and keeps relative ones plain", () => {
    const html = render("[law](https://lovdata.no) and [home](/learn)");
    expect(html).toContain('href="https://lovdata.no" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('<a href="/learn">home</a>');
  });
});
