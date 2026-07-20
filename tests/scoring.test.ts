import { describe, expect, it } from "vitest";
import {
  computeGameResult,
  computeMoneySettlement,
  computeSeriesResults,
  mondayAverageFromScores,
  teamHandicapPerGame,
} from "@/lib/scoring";

describe("scoring", () => {
  it("gives 90% of average-sum gap as handicap, floored", () => {
    expect(
      teamHandicapPerGame([{ averageSum: 1200 }, { averageSum: 1000 }]),
    ).toEqual([0, 180]);
    // 146.7 → 146
    expect(
      teamHandicapPerGame([{ averageSum: 520 }, { averageSum: 357 }]),
    ).toEqual([0, 146]);
  });

  it("does not declare a winner before all scores for the game are entered", () => {
    const result = computeGameResult({
      gameIndex: 0,
      teams: [
        { name: "Team 1", playerIds: ["a", "b"], averageSum: 300 },
        { name: "Team 2", playerIds: ["c"], averageSum: 150 },
      ],
      scores: {
        a: [100, null, null],
        b: [null, null, null],
        c: [100, null, null],
      },
    });
    expect(result.complete).toBe(false);
    expect(result.winnerName).toBeNull();
    expect(result.teams.every((team) => team.total === 0)).toBe(true);
  });

  it("applies handicap only after the game is complete", () => {
    const result = computeGameResult({
      gameIndex: 0,
      teams: [
        { name: "Team 1", playerIds: ["a", "b"], averageSum: 300 },
        { name: "Team 2", playerIds: ["c"], averageSum: 150 },
      ],
      scores: {
        a: [100, null, null],
        b: [100, null, null],
        c: [100, null, null],
      },
    });
    // handicap for team2 = round(0.9 * 150) = 135
    expect(result.complete).toBe(true);
    expect(result.margin).toBe(235 - 200);
    expect(result.teams.find((team) => team.teamName === "Team 2")).toMatchObject({
      scratch: 100,
      handicap: 135,
      total: 235,
      won: true,
    });
    expect(result.teams.find((team) => team.teamName === "Team 1")?.won).toBe(
      false,
    );
  });

  it("losers cover winners' lane fees so winners net $0", () => {
    const money = computeMoneySettlement({
      teams: [
        {
          name: "Team 1",
          averageSum: 300,
          players: [
            { id: "a", name: "A" },
            { id: "b", name: "B" },
          ],
        },
        {
          name: "Team 2",
          averageSum: 150,
          players: [{ id: "c", name: "C" }],
        },
      ],
      scores: {
        a: [100, 100, 100],
        b: [100, 100, 100],
        c: [200, 200, 200],
      },
    });
    // Team2 wins all 3; C's $15 lane is covered → net $0
    const c = money.find((line) => line.playerId === "c")!;
    expect(c.laneFee).toBe(15);
    expect(c.betReceived).toBe(15);
    expect(c.netDue).toBe(0);
    // Each Team1 player: own $15 + share of C's $15 ($7.50) = $22.50
    const a = money.find((line) => line.playerId === "a")!;
    expect(a.betPaid).toBe(7.5);
    expect(a.laneFee).toBe(15);
    expect(a.netDue).toBe(22.5);
  });

  it("equal teams: sweep losers each owe $30, winners $0", () => {
    const team1 = ["a1", "a2", "a3", "a4", "a5", "a6"];
    const team2 = ["b1", "b2", "b3", "b4", "b5", "b6"];
    const scores = Object.fromEntries([
      ...team1.map((id) => [id, [100, 100, 100]]),
      ...team2.map((id) => [id, [200, 200, 200]]),
    ]);
    const money = computeMoneySettlement({
      teams: [
        {
          name: "Team 1",
          averageSum: 900,
          players: team1.map((id) => ({ id, name: id })),
        },
        {
          name: "Team 2",
          averageSum: 1200,
          players: team2.map((id) => ({ id, name: id })),
        },
      ],
      scores,
    });
    for (const id of team2)
      expect(money.find((line) => line.playerId === id)?.netDue).toBe(0);
    for (const id of team1)
      expect(money.find((line) => line.playerId === id)?.netDue).toBe(30);
  });

  it("computes monday average from recorded games", () => {
    expect(mondayAverageFromScores([120, 140, null, 160])).toBe(140);
    expect(mondayAverageFromScores([null, null])).toBeNull();
  });

  it("builds series totals with per-game handicap", () => {
    const series = computeSeriesResults({
      teams: [
        { name: "Team 1", playerIds: ["a"], averageSum: 200 },
        { name: "Team 2", playerIds: ["b"], averageSum: 100 },
      ],
      scores: {
        a: [150, 150, 150],
        b: [100, 100, 100],
      },
    });
    expect(series.find((team) => team.teamName === "Team 2")).toMatchObject({
      handicapPerGame: 90,
      finalTotal: 300 + 270,
    });
  });
});
