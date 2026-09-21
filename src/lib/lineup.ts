import { recalculateTeams, teamMetrics } from "./generator";
import { MAX_TEAMS, MIN_TEAMS } from "./scoring";
import type { GeneratedTeam, GeneratorPlayer, Player } from "./types";

const finite = (value: unknown, label: string): number => {
  const number = Number(value);
  if (value === null || value === "" || !Number.isFinite(number))
    throw new Error(`Invalid ${label}`);
  return number;
};

/** Validate a lineup posted by the client and keep only known fields. */
export function parseLineupInput(body: unknown): GeneratedTeam[] {
  const input = (body ?? {}) as { teams?: unknown };
  if (
    !Array.isArray(input.teams) ||
    input.teams.length < MIN_TEAMS ||
    input.teams.length > MAX_TEAMS
  )
    throw new Error(`A lineup needs ${MIN_TEAMS}–${MAX_TEAMS} teams`);

  const seen = new Set<string>();
  const teams = input.teams.map((raw, index): GeneratedTeam => {
    const team = (raw ?? {}) as { name?: unknown; players?: unknown };
    const name = String(team.name ?? "").trim() || `Team ${index + 1}`;
    if (!Array.isArray(team.players)) throw new Error(`Invalid ${name}`);
    const players = team.players.map((entry): GeneratorPlayer => {
      const player = (entry ?? {}) as Record<string, unknown>;
      const id = String(player.id ?? "").trim();
      if (!id) throw new Error(`Invalid player in ${name}`);
      if (seen.has(id)) throw new Error("A player is on more than one team");
      seen.add(id);
      return {
        id,
        name: String(player.name ?? "").trim(),
        usedAverage: finite(player.usedAverage, "average"),
        averageMode: player.averageMode as GeneratorPlayer["averageMode"],
        handicap: finite(player.handicap, "handicap"),
        projectedScore: finite(player.projectedScore, "projected score"),
        ...(player.guest ? { guest: true } : {}),
        ...(player.tier
          ? { tier: player.tier as GeneratorPlayer["tier"] }
          : {}),
      };
    });
    return { name, players, metrics: teamMetrics([]) };
  });
  if (seen.size === 0) throw new Error("A lineup needs at least one player");
  return recalculateTeams(teams).teams;
}

/**
 * Bring a saved lineup up to date with the roster: averages and handicaps may
 * have changed since it was saved. Players missing from the roster keep the
 * numbers they were saved with.
 */
export function refreshLineupTeams(
  teams: GeneratedTeam[],
  roster: Player[],
): GeneratedTeam[] {
  const byId = new Map(roster.map((player) => [String(player.id), player]));
  return recalculateTeams(
    teams.map((team) => ({
      ...team,
      players: team.players.map((member) => {
        const current = byId.get(member.id);
        if (!current || current.usedAverage == null) return member;
        return {
          ...member,
          name: current.displayName,
          usedAverage: current.usedAverage,
          averageMode: current.averageMode,
          handicap: current.handicap ?? 0,
          projectedScore: current.projectedHandicapScore ?? current.usedAverage,
        };
      }),
    })),
  ).teams;
}
