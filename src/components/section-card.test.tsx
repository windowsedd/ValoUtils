import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SectionCard } from "./section-card";

const markup = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe("SectionCard disclosure", () => {
  test("stays a plain header when not collapsible", () => {
    const html = markup(
      <SectionCard title="Rarity">
        <p>row</p>
      </SectionCard>,
    );
    expect(html).toContain("<header");
    expect(html).not.toContain("aria-expanded");
    expect(html).toContain("row");
  });

  test("renders a disclosure button and its body when open", () => {
    const html = markup(
      <SectionCard title="Vandal" collapsible>
        <p>skin row</p>
      </SectionCard>,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("skin row");
    // The header/body seam keeps its hairline only while the body is there.
    expect(html).toContain("border-b");
  });

  test("omits the body entirely when collapsed", () => {
    const html = markup(
      <SectionCard title="Vandal" collapsible defaultOpen={false}>
        <p>skin row</p>
      </SectionCard>,
    );
    expect(html).toContain('aria-expanded="false"');
    // Not merely hidden: a closed card must not mount its rows, because
    // Inventory stacks one card per weapon.
    expect(html).not.toContain("skin row");
    expect(html).not.toContain("border-b");
  });

  test("keeps the count visible while collapsed", () => {
    const html = markup(
      <SectionCard title="Sprays" collapsible defaultOpen={false} count={42}>
        <p>row</p>
      </SectionCard>,
    );
    expect(html).toContain("42");
    expect(html).not.toContain(">row<");
  });
});
