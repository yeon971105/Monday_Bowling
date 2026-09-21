import { describe, expect, it } from "vitest";
import { parseLineupInput, refreshLineupTeams } from "@/lib/lineup";
import type { Player } from "@/lib/types";

const member = (id: string, name: string, avg: number) => ({
  id,
  name,
  usedAverage: avg,
  averageMode: "FIXED",
  handicap: 20,
  projectedScore: avg + 20,
});

const twoTeams = [
  { name: "Team 1", players: [member("1", "A", 180)] },
  { name: "Team 2", players: [member("2", "B", 150)] },
];

describe("parseLineupInput", () => {
  it("accepts a lineup and recomputes team metrics", () => {
    const teams = parseLineupInput({ teams: twoTeams });
    expect(teams).toHaveLength(2);
    expect(teams[0].metrics.scratchTotal).toBe(180);
    expect(teams[1].metrics.projectedTotal).toBe(170);
  });

  it("rejects bad lineups", () => {
    expect(() => parseLineupInput({ teams: [twoTeams[0]] })).toThrow(/teams/);
    expect(() =>
      parseLineupInput({
        teams: [twoTeams[0], { name: "T2", players: [member("1", "A", 180)] }],
      }),
    ).toThrow(/more than one team/);
    expect(() =>
      parseLineupInput({
        teams: [
          { name: "T1", players: [] },
          { name: "T2", players: [] },
        ],
      }),
    ).toThrow(/at least one player/);
    expect(() =>
      parseLineupInput({
        teams: [
          {
            name: "T1",
            players: [{ ...member("1", "A", 180), usedAverage: "x" }],
          },
          twoTeams[1],
        ],
      }),
    ).toThrow(/average/);
  });
});

describe("refreshLineupTeams", () => {
  it("uses today's averages but keeps players missing from the roster", () => {
    const teams = parseLineupInput({ teams: twoTeams });
    const roster = [
      {
        id: 1,
        displayName: "A",
        averageMode: "FIXED",
        usedAverage: 190,
        handicap: 15,
        projectedHandicapScore: 205,
      } as Player,
    ];
    const refreshed = refreshLineupTeams(teams, roster);
    expect(refreshed[0].players[0].usedAverage).toBe(190);
    expect(refreshed[0].metrics.projectedTotal).toBe(205);
    expect(refreshed[1].players[0].usedAverage).toBe(150);
  });
});
