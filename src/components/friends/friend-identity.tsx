import type { Friend, FriendRequest } from "@/types/friends";

type Identity = Pick<
  Friend | FriendRequest,
  "gameName" | "tagLine" | "displayName" | "note"
>;

const matches = (text: string, search: string) =>
  text.toLowerCase().includes(search.trim().toLowerCase());

export const matchesFriendSearch = (
  friend: Pick<Friend, "displayName" | "note">,
  search: string,
) => matches(`${friend.displayName} ${friend.note}`, search);

export const matchesFriendRequestSearch = (
  request: Pick<FriendRequest, "displayName">,
  search: string,
) => matches(request.displayName, search);

export const FriendIdentity = ({
  person,
  showNote,
}: {
  person: Identity;
  showNote: boolean;
}) => {
  const note = showNote ? person.note.trim() : "";

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={`min-w-0 truncate ${note ? "max-w-[65%]" : "flex-1"}`}>
        {person.gameName ? (
          <>
            <span className="text-white">{person.gameName}</span>
            {person.tagLine && <span className="text-gray-600">#{person.tagLine}</span>}
          </>
        ) : (
          <span className="text-gray-300">{person.displayName}</span>
        )}
      </span>
      {note && (
        <span
          data-friend-note=""
          title={note}
          className="min-w-0 max-w-[35%] shrink truncate rounded-full border border-white/10 px-2 py-0.5 text-xs font-normal text-gray-400"
        >
          {note}
        </span>
      )}
    </span>
  );
};
