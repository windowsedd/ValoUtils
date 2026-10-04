import { expect, test } from "bun:test";
import { runButtonAction } from "./button-action";

test("button actions report thrown and rejected errors and finish unsuccessfully", async () => {
  const messages: string[] = [];
  const report = (message: string) => messages.push(message);
  expect(await runButtonAction(() => { throw new Error("Invalid share code"); }, report, "Failed")).toBe(false);
  expect(await runButtonAction(() => Promise.reject("Duplicate names"), report, "Failed")).toBe(false);
  expect(await runButtonAction(() => Promise.reject({ response: { data: { message: "Server unavailable" } } }), report, "Failed")).toBe(false);
  expect(messages).toEqual(["Invalid share code", "Duplicate names", "Server unavailable"]);
});

test("successful actions and modal cancellation do not show errors", async () => {
  const messages: string[] = [];
  expect(await runButtonAction(async () => {}, message => messages.push(message), "Failed")).toBe(true);
  expect(await runButtonAction(() => Promise.reject(), message => messages.push(message), "Failed")).toBe(false);
  expect(messages).toEqual([]);
});

test("unknown errors get a readable fallback", async () => {
  const messages: string[] = [];
  expect(await runButtonAction(() => Promise.reject({}), message => messages.push(message), "Please try again")).toBe(false);
  expect(messages).toEqual(["Please try again"]);
});
