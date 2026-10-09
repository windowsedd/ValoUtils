const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" ? value : "";

export type Penalty = { id: string; reason: string; effects: string[]; expiry: string; gamesRemaining: number };
export type InterventionCategory = {
  category: string; rating: string;
  active: { name: string; expiry: string; issuedAt: string; reason: string }[];
  next: string[];
};

export const readPenalties = (data: unknown): Penalty[] | null => {
  const root = object(data);
  if (!Array.isArray(root?.Penalties)) return null;
  const infractions = Array.isArray(root.Infractions) ? root.Infractions.map(object) : [];
  const penalties: Penalty[] = [];
  for (const value of root.Penalties) {
    const item = object(value);
    if (!item || typeof item.ID !== "string") return null;
    const infraction = infractions.find(entry => entry && entry.ID === item.InfractionID);
    penalties.push({id: item.ID, reason: text(infraction?.Name) || text(infraction?.RatingName) || text(item.Origin),
      effects: Object.keys(item).filter(key => key.endsWith("Effect") && item[key] != null),
      expiry: text(item.Expiry), gamesRemaining: typeof item.GamesRemaining === "number" && Number.isFinite(item.GamesRemaining) ? Math.max(0, item.GamesRemaining) : 0});
  }
  return penalties;
};

export const readInterventions = (data: unknown): InterventionCategory[] | null => {
  const root = object(data);
  if (!Array.isArray(root?.InterventionsByCategory)) return null;
  const categories: InterventionCategory[] = [];
  for (const value of root.InterventionsByCategory) {
    const item = object(value);
    if (!item || typeof item.BehaviorCategory !== "string" || !Array.isArray(item.ActiveInterventions) || !Array.isArray(item.NextInterventionNames)) return null;
    const active: InterventionCategory["active"] = [];
    for (const value of item.ActiveInterventions) {
      const intervention = object(value);
      if (!intervention || typeof intervention.InterventionName !== "string") return null;
      const infraction = object(object(item.AppliedInfractions)?.[text(intervention.OriginInfraction)]);
      active.push({name: intervention.InterventionName, expiry: text(intervention.Expiry), issuedAt: text(intervention.IssuingTime),
        reason: text(infraction?.InfractionName) || text(intervention.OriginInfraction)});
    }
    if (!item.NextInterventionNames.every(name => typeof name === "string")) return null;
    categories.push({category: item.BehaviorCategory, rating: text(item.BehaviorRatingName), active, next: item.NextInterventionNames as string[]});
  }
  return categories;
};
