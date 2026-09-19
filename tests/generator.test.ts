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

  it("spreads avg≥150 and avg<150 pools across teams", () => {
    // Mix of highs (160+) and lows (120-140).
    const players: GeneratorPlayer[] = [
      ...[210, 200, 190, 180, 170, 160].map((average, i) => ({
        id: `h${i}`,
        name: `High ${i}`,
        usedAverage: average,
        averageMode: "AUTO" as const,
        handicap: 0,
        projectedScore: average,
      })),
      ...[140, 135, 130, 125, 120, 115].map((average, i) => ({
        id: `l${i}`,
        name: `Low ${i}`,
        usedAverage: average,
        averageMode: "AUTO" as const,
        handicap: 0,
        projectedScore: average,
      })),
    ];
    const result = generateTeams({
      players,
      teamCount: 3,
      seed: "pools",
    });
    for (const pool of ["high", "low"] as const) {
      const counts = result.teams.map(
        (team) =>
          team.players.filter((player) =>
            pool === "high"
              ? player.usedAverage >= 150
              : player.usedAverage < 150,
          ).length,
      );
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
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

  it("different seeds reshuffle partner combinations", () => {
    const players = group(12);
    const combos = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const result = generateTeams({
        players,
        teamCount: 2,
        seed: `reshuffle-${i}`,
      });
      combos.add(
        result.teams
          .map((team) =>
            team.players
              .map((player) => player.id)
              .sort()
              .join(","),
          )
          .sort()
          .join("|"),
      );
    }
    expect(combos.size).toBeGreaterThan(3);
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
