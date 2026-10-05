import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { singleLine } from "@/pages/bot-command-message-editor";
import { placeSelectMenu, SelectMenu } from "./select-menu";

describe("placeSelectMenu", () => {
  test("opens below the trigger when there is room", () => {
    const placement = placeSelectMenu({ top: 100, bottom: 128, left: 20, width: 200 }, 800);
    expect(placement.top).toBe(132);
    expect(placement.bottom).toBeUndefined();
    expect(placement.width).toBe(200);
    expect(placement.maxHeight).toBe(280);
  });

  test("flips above a trigger near the bottom of the window", () => {
    const placement = placeSelectMenu({ top: 700, bottom: 728, left: 20, width: 200 }, 760);
    expect(placement.top).toBeUndefined();
    expect(placement.bottom).toBe(64);
    expect(placement.maxHeight).toBe(280);
  });

  test("never collapses below a usable height", () => {
    expect(placeSelectMenu({ top: 10, bottom: 38, left: 0, width: 100 }, 60).maxHeight).toBe(96);
  });
});

describe("SelectMenu", () => {
  test("renders a themed trigger showing the selected label, with the list closed", () => {
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
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(">team<");
    expect(markup).not.toContain("<select");
    expect(markup).not.toContain('role="listbox"');
  });
});

describe("singleLine", () => {
  test("turns pasted line breaks into spaces", () => {
    expect(singleLine("gl\nhf\r\n{{map}}")).toBe("gl hf {{map}}");
  });
});
