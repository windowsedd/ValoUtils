import { expect, test } from "bun:test";
import { listenEvent } from "./ipc";

test("cleanup before asynchronous registration removes the late listener and suppresses delivery", async () => {
  let ready!: (unlisten: () => void) => void;
  let deliver!: (event: { payload: number }) => void;
  let removed = 0;
  const received: number[] = [];
  const register = (_event: string, callback: typeof deliver) => {
    deliver = callback;
    return new Promise<() => void>(resolve => { ready = resolve; });
  };
  const cleanup = listenEvent("test", value => received.push(value), register);
  cleanup();
  deliver({ payload: 12 });
  ready(() => { removed++; });
  await Promise.resolve();
  expect(received).toEqual([]);
  expect(removed).toBe(1);
});
