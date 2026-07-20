import { calculateHandicap } from "./bowling";
import { generateTeams } from "./generator";
import type { BalancingMode, GeneratorPlayer } from "./types";

const SOURCE_AVERAGES = [
  221, 97, 220, 124, 211, 134, 209, 143, 202, 150, 200, 154, 193, 165, 192, 171,
  189, 175, 186, 179,
];

export const benchmarkTeamCount = (count: number): number => {
  if (count <= 11) return 3;
  if (count <= 14) return 4;
  return 5;
};

export function realisticMondayGroup(count: number): GeneratorPlayer[] {
  return SOURCE_AVERAGES.slice(0, count - 1)
    .concat(160) // one non-league manually maintained player
    .map((usedAverage, index) => {
      const handicap = calculateHandicap(usedAverage, {
        handicapBase: 220,
        handicapPercentage: 0.9,
        handicapRounding: "floor",
      });
      return {
        id: `benchmark-${index + 1}`,
        name:
          index === count - 1 ? "Manual Guest" : `League Bowler ${index + 1}`,
        usedAverage,
        averageMode: index === count - 1 ? "MANUAL" : "AUTO",
        handicap,
        projectedScore: usedAverage + handicap,
      };
    });
}

export type BenchmarkSummary = {
  count: number;
  teamCount: number;
  averageScratchSpread: number;
  averageProjectedSpread: number;
  tierViolations: number;
  topPairAssignments: number;
  bottomConcentrations: number;
  repeatedPairs: number;
  uniqueAssignments: number;
};

function pairTogether(
  teams: ReturnType<typeof generateTeams>["teams"],
  firstId: string,
  secondId: string,
): boolean {
  return teams.some(
    (team) =>
      team.players.some((p) => p.id === firstId) &&
      team.players.some((p) => p.id === secondId),
  );
}

export function benchmarkMode(
  mode: BalancingMode,
  count: number,
  seedCount = 100,
): BenchmarkSummary {
  const players = realisticMondayGroup(count);
  const teamCount = benchmarkTeamCount(count);
  let scratch = 0;
  let projected = 0;
  let tierViolations = 0;
  let topPairAssignments = 0;
  let bottomConcentrations = 0;
  let repeatedPairs = 0;
  const assignments = new Set<string>();

  for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
    const result = generateTeams({
      players,
      teamCount,
      mode,
      seed: `real-fixture-${count}-${seedIndex}`,
    });
    scratch += result.fairness.scratchSpread;
    projected += result.fairness.projectedSpread;
    repeatedPairs += result.fairness.repeatedPairs;
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
    for (const counts of Object.values(result.fairness.tierDistribution)) {
      if (Math.max(...counts) - Math.min(...counts) > 1) tierViolations++;
    }
    const ranked = [...players].sort((a, b) => b.usedAverage - a.usedAverage);
    if (pairTogether(result.teams, ranked[0].id, ranked[1].id))
      topPairAssignments++;
    const lowIds = new Set(ranked.slice(-2).map((player) => player.id));
    if (
      result.teams.some(
        (team) =>
          team.players.filter((player) => lowIds.has(player.id)).length > 1,
      )
    )
      bottomConcentrations++;
  }
  return {
    count,
    teamCount,
    averageScratchSpread: scratch / seedCount,
    averageProjectedSpread: projected / seedCount,
    tierViolations,
    topPairAssignments,
    bottomConcentrations,
    repeatedPairs,
    uniqueAssignments: assignments.size,
  };
}
