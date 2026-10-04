import type { ChatMessage } from "@/types/chat";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** One line of the Dummy Bot transcript (`fake_player_state` / `fake_player_send`). */
export type DummyBotLine = {
  id: string;
  body: string;
  isSelf: boolean;
  timestamp: string;
};

type DummyBotState = { success: true; puuid: string; messages: DummyBotLine[] } | { success: false; error?: string };
type DummyBotSend = { success: true; messages: DummyBotLine[] } | { success: false; error?: string };

export const DUMMY_BOT_CID = "valoutils-dummy-bot";
const POLL_MS = 3000;

export const dummyBotMessages = (lines: DummyBotLine[], botName: string): ChatMessage[] =>
  lines.map((line) => ({
    id: line.id,
    conversationId: DUMMY_BOT_CID,
    sender: line.isSelf ? "self" : "dummy-bot",
    senderName: line.isSelf ? "" : botName,
    body: line.body,
    timestamp: line.timestamp,
    type: "chat",
    scope: "friends",
    isSelf: line.isSelf,
  }));

/**
 * The Dummy Bot as a Chat conversation. Lines run in the app exactly as a
 * whisper would, so commands can be tried without launching the game, and the
 * transcript is the same one in-game whispers and the Dummy Bot page show.
 */
export const useDummyBotChat = (active: boolean, botName: string) => {
  const [lines, setLines] = useState<DummyBotLine[]>([]);
  const [puuid, setPuuid] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      invoke<DummyBotState>("fake_player_state")
        .then((reply) => {
          if (!alive || !reply?.success) return;
          setPuuid(reply.puuid);
          setLines(reply.messages ?? []);
        })
        .catch(() => {});
    load();
    // The id is needed even when closed, to hide the in-game bot thread.
    if (!active) return () => {
      alive = false;
    };
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [active]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    setDraft("");
    // Shown straight away; the backend records the same line before replying.
    setLines((current) => [
      ...current,
      { id: `pending-${Date.now()}`, body: text, isSelf: true, timestamp: new Date().toISOString() },
    ]);
    invoke<DummyBotSend>("fake_player_send", { args: [text] })
      .then((reply) => {
        if (!mounted.current) return;
        if (reply?.success) setLines(reply.messages);
        else setError(reply?.error || "Dummy Bot did not answer.");
      })
      .catch((reason) => {
        if (mounted.current) setError(String(reason));
      })
      .finally(() => {
        if (mounted.current) setSending(false);
      });
  }, [draft, sending]);

  const messages = useMemo(() => dummyBotMessages(lines, botName), [lines, botName]);
  return { puuid, messages, draft, setDraft, sending, error, send };
};
