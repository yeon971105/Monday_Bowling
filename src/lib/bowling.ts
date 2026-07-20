import type { AverageMode, LeagueSettings } from "./types";

export const DEFAULT_SETTINGS: LeagueSettings = {
  handicapBase: 220,
  handicapPercentage: 0.9,
  handicapRounding: "floor",
  targetTeamSize: 3,
  repeatWindow: 4,
};

export function validateAverage(
  value: unknown,
  nullable = true,
): number | null {
  if (value === null || value === undefined || value === "") {
    if (nullable) return null;
    throw new Error("Average is required");
  }
  const average = Number(value);
  if (!Number.isFinite(average) || average < 0 || average > 300) {
    throw new Error("Average must be between 0 and 300");
  }
  return Math.round(average);
}

export function calculateHandicap(
  average: number,
  settings: Pick<
    LeagueSettings,
    "handicapBase" | "handicapPercentage" | "handicapRounding"
  >,
): number {
  const raw = Math.max(
    0,
    (settings.handicapBase - average) * settings.handicapPercentage,
  );
  if (settings.handicapRounding === "ceil") return Math.ceil(raw);
  if (settings.handicapRounding === "round") return Math.round(raw);
  return Math.floor(raw);
}

export function resolveUsedAverage(input: {
  averageMode: AverageMode;
  leagueAverage: number | null;
  manualAverage: number | null;
  fixedAverage: number | null;
}): number | null {
  if (input.averageMode === "AUTO") return input.leagueAverage;
  if (input.averageMode === "MANUAL") return input.manualAverage;
  return input.fixedAverage;
}

export function normalizeName(name: string): string {
  return name
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function assertSettings(value: Partial<LeagueSettings>): LeagueSettings {
  const settings = { ...DEFAULT_SETTINGS, ...value };
  if (settings.handicapBase < 0 || settings.handicapBase > 300)
    throw new Error("Handicap base must be between 0 and 300");
  if (settings.handicapPercentage < 0 || settings.handicapPercentage > 1.5)
    throw new Error("Handicap percentage must be between 0% and 150%");
  if (settings.targetTeamSize < 2 || settings.targetTeamSize > 8)
    throw new Error("Target team size must be between 2 and 8");
  if (settings.repeatWindow < 0 || settings.repeatWindow > 52)
    throw new Error("Repeat window must be between 0 and 52");
  return settings;
}
