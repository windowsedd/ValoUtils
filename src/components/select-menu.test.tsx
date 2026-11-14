import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { singleLine } from "@/pages/bot-command-message-editor";
import { SelectMenu } from "./select-menu";

describe("SelectMenu", () => {
  test("renders a themed shadcn trigger showing the selected label, with the list closed", () => {
    const markup = renderToStaticMarkup(
      <SelectMenu
        value="team"
        onChange={() => {}}
        ariaLabel="Target"
        options={[
          { value: "party", label: "party" },
          { value: "team", label: "team" },
        ]}
      />,
    );
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Target"');
    expect(markup).toContain('data-slot="select-trigger"');
    expect(markup).toContain(">team<");
    // Radix keeps a hidden native <select> for forms; none may be visible.
    expect(markup).not.toMatch(/<select(?![^>]*aria-hidden="true")/);
    expect(markup).not.toContain('role="listbox"');
  });

  test("an empty value still renders its option label", () => {
    const markup = renderToStaticMarkup(
      <SelectMenu value="" onChange={() => {}} options={[{ value: "", label: "Any" }, { value: "a", label: "A" }]} />,
    );
    expect(markup).toContain(">Any<");
  });
});

describe("singleLine", () => {
  test("turns pasted line breaks into spaces", () => {
    expect(singleLine("gl\nhf\r\n{{map}}")).toBe("gl hf {{map}}");
  });
});
