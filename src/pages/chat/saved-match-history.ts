import type { ChatChannel, SavedChatMatch } from "@/types/chat";
import { channelForCid, mergeChatMessages } from "./chat-model";

export const savedMatchMessages = (match: SavedChatMatch | undefined, channel: ChatChannel) => {
  if (!match || (channel !== "team" && channel !== "all")) return [];
  return mergeChatMessages(match.messages.filter(message =>
    channelForCid(message.conversationId) === channel &&
    message.conversationId.toLowerCase().startsWith(`${match.matchUuid.toLowerCase()}-`),
  ));
};
