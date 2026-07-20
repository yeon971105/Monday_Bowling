import { describe, expect, it } from "vitest";
import {
  benchmarkMode,
  benchmarkTeamCount,
  realisticMondayGroup,
} from "@/lib/balancing-benchmark";
import { generateTeams } from "@/lib/generator";

describe("real-fixture balancing acceptance", () => {
  it("keeps 100 seeded balanced assignments valid and materially fairer than fully random", () => {
    for (const count of [10, 11, 12, 13, 14, 15]) {
      const players = realisticMondayGroup(count);
      const teamCount = benchmarkTeamCount(count);
      const sameSeed = generateTeams({
        players,
        teamCount,
        mode: "BALANCED",
        seed: `same-${count}`,
      });
      expect(
        generateTeams({
          players,
          teamCount,
          mode: "BALANCED",
          seed: `same-${count}`,
        }).teams,
      ).toEqual(sameSeed.teams);
      for (const team of sameSeed.teams)
        expect(team.players.length).toBeGreaterThan(0);
      expect(
        sameSeed.teams
          .flatMap((team) => team.players)
          .map((player) => player.id)
          .sort(),
      ).toEqual(players.map((player) => player.id).sort());
      const sizes = sameSeed.teams.map((team) => team.players.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);

      const balanced = benchmarkMode("BALANCED", count);
      const random = benchmarkMode("RANDOM", count);
      expect(balanced.uniqueAssignments).toBeGreaterThan(10);
      expect(balanced.tierViolations).toBe(0);
      expect(balanced.topPairAssignments).toBe(0);
      expect(balanced.bottomConcentrations).toBe(0);
      expect(balanced.repeatedPairs).toBe(0);
      expect(balanced.averageScratchSpread).toBeLessThan(
        random.averageScratchSpread * 0.8,
      );
    }
  }, 120000);
});
