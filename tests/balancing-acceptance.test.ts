import { describe, expect, it } from "vitest";
import {
  benchmarkTeamCount,
  realisticMondayGroup,
} from "@/lib/balancing-benchmark";
import { generateTeams } from "@/lib/generator";

describe("real-fixture balancing acceptance", () => {
  it.each([10, 11, 12, 13, 14, 15])(
    "keeps 100 seeded assignments of %i players valid, within the handicap cap, and varied",
    (count) => {
      const players = realisticMondayGroup(count);
      const teamCount = benchmarkTeamCount(count);
      const assignments = new Set<string>();
      for (let seed = 0; seed < 100; seed++) {
        const options = {
          players,
          teamCount,
          seed: `acceptance-${count}-${seed}`,
        };
        const result = generateTeams(options);
        if (seed === 0)
          expect(generateTeams(options).teams).toEqual(result.teams);
        expect(
          result.teams
            .flatMap((team) => team.players.map((player) => player.id))
            .sort(),
        ).toEqual(players.map((player) => player.id).sort());
        const sizes = result.teams.map((team) => team.players.length);
        expect(Math.min(...sizes)).toBeGreaterThan(0);
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
        const totals = result.teams.map((team) =>
          team.players.reduce((sum, player) => sum + player.usedAverage, 0),
        );
        const handicapGap = Math.floor(
          (Math.max(...totals) - Math.min(...totals)) * 0.9,
        );
        expect(handicapGap).toBeLessThan(count % teamCount === 0 ? 50 : 100);
        assignments.add(
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
      expect(assignments.size).toBeGreaterThan(10);
    },
  );
});
