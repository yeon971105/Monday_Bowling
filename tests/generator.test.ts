import { describe, expect, it } from "vitest";
import { calculateHandicap } from "@/lib/bowling";
import { generateTeams, recalculateTeams } from "@/lib/generator";
import type { GeneratorPlayer } from "@/lib/types";

const settings = {
  handicapBase: 220,
  handicapPercentage: 0.9,
  handicapRounding: "floor" as const,
};
const group = (count: number): GeneratorPlayer[] =>
  Array.from({ length: count }, (_, i) => {
    const average = 220 - i * 7;
    const handicap = calculateHandicap(average, settings);
    return {
      id: String(i + 1),
      name: `Player ${i + 1}`,
      usedAverage: average,
      averageMode: "AUTO",
      handicap,
      projectedScore: average + handicap,
    };
  });
const ids = (result: ReturnType<typeof generateTeams>) =>
  result.teams.flatMap((t) => t.players.map((p) => p.id));

describe("team generator", () => {
  it.each([10, 11, 12, 13, 14, 15])(
    "assigns each of %i selected players exactly once with legal team sizes",
    (count) => {
      const selected = group(count);
      const result = generateTeams({
        players: selected,
        targetTeamSize: 3,
        mode: "BALANCED",
        seed: `size-${count}`,
      });
      expect(ids(result).sort()).toEqual(selected.map((p) => p.id).sort());
      expect(new Set(ids(result)).size).toBe(count);
      const sizes = result.teams.map((t) => t.players.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    },
  );
  it("includes no unselected or archived player when caller supplies the eligible attendance set", () => {
    const roster = group(12).map((p, i) => ({ ...p, archived: i === 11 }));
    const selected = roster.filter((p) => !p.archived && Number(p.id) !== 10);
    const result = generateTeams({
      players: selected,
      targetTeamSize: 3,
      seed: "eligible",
    });
    expect(ids(result)).not.toContain("10");
    expect(ids(result)).not.toContain("12");
  });
  it("distributes top and lower tiers across teams when possible", () => {
    const result = generateTeams({
      players: group(12),
      teamCount: 4,
      seed: "tiers",
    });
    for (const tier of ["A", "D"] as const) {
      const counts = result.teams.map(
        (team) => team.players.filter((player) => player.tier === tier).length,
      );
      // Twelve attendees create three people per quartile, so four teams cannot
      // each receive one; the required invariant is a spread of at most one.
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      expect(Math.max(...counts)).toBe(1);
    }
  });
  it("reproduces the same teams from the same seed", () => {
    const options = {
      players: group(15),
      teamCount: 5,
      mode: "BALANCED" as const,
      seed: "repeatable-seed",
    };
    expect(generateTeams(options).teams).toEqual(generateTeams(options).teams);
  });
  it("different seeds produce different valid near-balanced reshuffles", () => {
    const a = generateTeams({ players: group(15), teamCount: 5, seed: "one" });
    const b = generateTeams({ players: group(15), teamCount: 5, seed: "two" });
    expect(a.teams.map((t) => t.players.map((p) => p.id))).not.toEqual(
      b.teams.map((t) => t.players.map((p) => p.id)),
    );
    expect(a.fairness.scratchSpread).toBeLessThan(12);
    expect(b.fairness.scratchSpread).toBeLessThan(12);
  });
  it("materially outperforms naive random assignment on average", () => {
    const players = group(15);
    let balanced = 0,
      random = 0;
    for (let i = 0; i < 12; i++) {
      balanced += generateTeams({
        players,
        teamCount: 5,
        mode: "BALANCED",
        seed: `b-${i}`,
      }).fairness.score;
      random += generateTeams({
        players,
        teamCount: 5,
        mode: "RANDOM",
        seed: `r-${i}`,
      }).fairness.score;
    }
    expect(balanced / 12).toBeLessThan((random / 12) * 0.65);
  });
  it("repeat avoidance reduces recent pairings without breaking tier fairness", () => {
    const players = group(12);
    const baseline = generateTeams({
      players,
      teamCount: 4,
      mode: "BALANCED",
      seed: "pairs",
    });
    const repeatPairs: Record<string, number> = {};
    for (const team of baseline.teams)
      for (let i = 0; i < team.players.length; i++)
        for (let j = i + 1; j < team.players.length; j++) {
          const a = team.players[i].id,
            b = team.players[j].id;
          repeatPairs[a < b ? `${a}|${b}` : `${b}|${a}`] = 4;
        }
    const avoided = generateTeams({
      players,
      teamCount: 4,
      mode: "BALANCED_REPEATS",
      seed: "pairs",
      repeatPairs,
    });
    expect(avoided.fairness.repeatedPairs).toBeLessThan(
      baseline.teams.length * 3 * 4,
    );
    for (const tier of ["A", "D"] as const) {
      const counts = avoided.teams.map(
        (t) => t.players.filter((p) => p.tier === tier).length,
      );
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    }
  });
  it("manual player movement recalculates fairness and totals", () => {
    const result = generateTeams({
      players: group(10),
      teamCount: 3,
      seed: "move",
    });
    const teams = result.teams.map((t) => ({ ...t, players: [...t.players] }));
    const moved = teams[0].players.pop()!;
    teams[1].players.push(moved);
    const recalculated = recalculateTeams(teams);
    expect(recalculated.teams[1].metrics.scratchTotal).toBe(
      teams[1].players.reduce((n, p) => n + p.usedAverage, 0),
    );
    expect(recalculated.fairness.unequalSizes).toBe(true);
  });
});
