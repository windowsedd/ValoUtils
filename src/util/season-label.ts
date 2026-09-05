export const formatSeasonActLabel = (episode: string, act: number): string | null =>
  episode && act > 0 ? `${episode}A${act}` : null;
