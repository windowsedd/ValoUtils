import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const command = readFileSync(join(root, "src-tauri/src/commands/chat.rs"), "utf8");
const types = readFileSync(join(root, "src/types/chat.ts"), "utf8");

describe("translation IPC language contract", () => {
  test("reads source config and passes source plus target to translation", () => {
    expect(command).toContain('.get("translatorSourceLanguage")');
    expect(command).toMatch(
      /translate::translate_text\([\s\S]*?&source_language,\s*&target_language,/,
    );
  });

  test("returns and types both selected languages", () => {
    expect(command).toContain('"sourceLanguage": result.source_language');
    expect(command).toContain('"targetLanguage": result.target_language');
    expect(types).toMatch(/sourceLanguage: string;\s*targetLanguage: string;/);
  });
});
