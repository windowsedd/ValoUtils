export const isMatchPlayerHighlighted = (
  player: { subject: string; isSelf: boolean },
  highlightPuuid?: string,
) =>
  highlightPuuid ? player.subject.toLowerCase() === highlightPuuid.toLowerCase() : player.isSelf;
