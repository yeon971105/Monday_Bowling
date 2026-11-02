import { expect, it } from "vitest";
import { generateTeams } from "@/lib/generator";
import type { GeneratorPlayer } from "@/lib/types";

const players = (averages: number[]): GeneratorPlayer[] =>
  averages.map((usedAverage, i) => ({
    id: String(i + 1),
    name: `Player ${i + 1}`,
    usedAverage,
    averageMode: "MANUAL",
    handicap: 0,
    projectedScore: usedAverage,
  }));
const total = (team: GeneratorPlayer[]) =>
  team.reduce((sum, player) => sum + player.usedAverage, 0);

it("does not change attendance parity by silently excluding a checked-in player without an average", () => {
  expect(() =>
    generateTeams({
      players: players([180, 101]),
      attendanceCount: 3,
      teamCount: 2,
      seed: "missing-average",
    }),
  ).toThrow("Every checked-in player needs an average");
});

it("allows an even-attendance average-total gap of 79, but not 80", () => {
  const result = generateTeams({
    players: players([180, 101]),
    teamCount: 2,
    seed: "even",
  });
  expect(
    Math.abs(total(result.teams[0].players) - total(result.teams[1].players)),
  ).toBe(79);
  expect(() =>
    generateTeams({ players: players([180, 100]), teamCount: 2, seed: "even" }),
  ).toThrow("average-total gap below 80");
});

it("accepts 119 before adding the odd attendee, but rejects 120", () => {
  const result = generateTeams({
    players: players([200, 81, 80]),
    teamCount: 2,
    seed: "odd",
  });
  const larger = result.teams.find((team) => team.players.length === 2)!;
  expect(larger.players.map((player) => player.id).sort()).toEqual(["2", "3"]);
  expect(
    result.teams.map((team) => total(team.players)).sort((a, b) => a - b),
  ).toEqual([161, 200]);
  expect(() =>
    generateTeams({
      players: players([200, 80, 79]),
      teamCount: 2,
      seed: "odd",
    }),
  ).toThrow("average-total gap below 120");
});

it("applies the odd-attendance limit before adding back the lowest average", () => {
  const result = generateTeams({
    players: players([150, 150, 150]),
    teamCount: 2,
    seed: "tied-lowest",
  });
  expect(
    result.teams.map((team) => total(team.players)).sort((a, b) => a - b),
  ).toEqual([150, 300]);
});

it("adds the lowest-average attendee to the weaker base team and preserves final paying balance", () => {
  for (let paying = 0; paying <= 7; paying++) {
    const roster = players([220, 200, 180, 160, 140, 120, 100]).map(
      (player, index) => ({
        ...player,
        payingMember: paying > 0 && (index < paying - 1 || index === 6),
      }),
    );
    for (let seed = 0; seed < 20; seed++) {
      const result = generateTeams({
        players: roster,
        teamCount: 2,
        seed: `odd-payers-${paying}-${seed}`,
      });
      expect(
        result.teams
          .flatMap((team) => team.players.map((player) => player.id))
          .sort(),
      ).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
      const withLowest = result.teams.find((team) =>
        team.players.some((player) => player.id === "7"),
      )!;
      const other = result.teams.find((team) => team !== withLowest)!;
      const base = withLowest.players.filter((player) => player.id !== "7");
      expect(base).toHaveLength(3);
      expect(other.players).toHaveLength(3);
      expect(total(base)).toBeLessThanOrEqual(total(other.players));
      expect(Math.abs(total(base) - total(other.players))).toBeLessThan(120);
      const counts = result.teams.map(
        (team) => team.players.filter((player) => player.payingMember).length,
      );
      expect(Math.abs(counts[0] - counts[1])).toBeLessThanOrEqual(1);
    }
  }
});
