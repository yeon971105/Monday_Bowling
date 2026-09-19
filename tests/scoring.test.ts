import { describe, expect, it } from "vitest";
import {
  clampGameIndex,
  computeGameResult,
  computeLastGamePrize,
  computeLiveStandings,
  computeMoneySettlement,
  computeScratchWinners,
  computeSeriesResults,
  mondayAverageFromScores,
  nextGameIndex,
  teamHandicapPerGame,
  teamsChangedDuringNight,
} from "@/lib/scoring";

describe("scoring", () => {
  it("keeps Next game on a valid 1–3 night even if tapped twice", () => {
    expect(nextGameIndex(0)).toBe(1);
    expect(nextGameIndex(1)).toBe(2);
    expect(nextGameIndex(2)).toBeNull();
    expect(nextGameIndex(3)).toBeNull();
    expect(clampGameIndex(3)).toBe(2);
    expect(clampGameIndex(-1)).toBe(0);
  });

  it("gives 90% of average-sum gap as handicap, floored", () => {
    expect(
      teamHandicapPerGame([{ averageSum: 1200 }, { averageSum: 1000 }]),
    ).toEqual([0, 180]);
    expect(
      teamHandicapPerGame([{ averageSum: 520 }, { averageSum: 357 }]),
    ).toEqual([0, 146]);
  });

  it("live standings show lead and pins needed to take first", () => {
    const standings = computeLiveStandings([
      { teamName: "Team 1", total: 850 },
      { teamName: "Team 2", total: 862 },
      { teamName: "Team 3", total: 800 },
    ]);
    expect(standings.find((row) => row.teamName === "Team 2")).toMatchObject({
      leading: true,
      leadBy: 12,
      toLead: 0,
    });
    expect(standings.find((row) => row.teamName === "Team 1")).toMatchObject({
      leading: false,
      behindBy: 12,
      toLead: 13,
    });
    expect(standings.find((row) => row.teamName === "Team 3")).toMatchObject({
      behindBy: 62,
      toLead: 63,
    });
  });

  it("tied live totals need 1 pin to take the lead alone", () => {
    const standings = computeLiveStandings([
      { teamName: "Team 1", total: 200 },
      { teamName: "Team 2", total: 200 },
    ]);
    expect(standings.every((row) => row.tied && row.toLead === 1)).toBe(true);
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
  });

  it("does not complete a game while a team is empty", () => {
    const result = computeGameResult({
      gameIndex: 0,
      teams: [
        { name: "Team 1", playerIds: ["a"], averageSum: 180 },
        { name: "Team 2", playerIds: ["b"], averageSum: 180 },
        { name: "Team 3", playerIds: [], averageSum: 0 },
      ],
      scores: {
        a: [150, null, null],
        b: [160, null, null],
      },
    });
    expect(result.complete).toBe(false);
    expect(result.winnerName).toBeNull();
  });

  it("everyone who played pays $5 per game to Jewon; Jewon pays $0", () => {
    const money = computeMoneySettlement({
      teams: [
        {
          name: "Team 1",
          averageSum: 200,
          players: [
            { id: "a", name: "A" },
            { id: "j", name: "Jewon Yeon" },
          ],
        },
        {
          name: "Team 2",
          averageSum: 200,
          players: [{ id: "b", name: "B" }],
        },
      ],
      scores: {
        a: [100, 100, 200],
        j: [120, 130, 140],
        b: [200, 200, 100],
      },
    });
    expect(money.find((line) => line.playerId === "a")).toMatchObject({
      laneFee: 15,
      betPaid: 0,
      betReceived: 0,
      netDue: 15,
    });
    expect(money.find((line) => line.playerId === "b")).toMatchObject({
      laneFee: 15,
      netDue: 15,
    });
    expect(money.find((line) => line.playerId === "j")).toMatchObject({
      laneFee: 15,
      netDue: 0,
    });
  });

  it("charges only completed games, including a 1-game night", () => {
    const money = computeMoneySettlement({
      teams: [
        {
          name: "Team 1",
          averageSum: 200,
          players: [{ id: "a", name: "A" }],
        },
        {
          name: "Team 2",
          averageSum: 200,
          players: [{ id: "b", name: "B" }],
        },
      ],
      scores: {
        a: [100, null, null],
        b: [200, null, null],
      },
      gameCount: 1,
    });
    expect(money.find((line) => line.playerId === "a")?.netDue).toBe(5);
    expect(money.find((line) => line.playerId === "b")?.netDue).toBe(5);
  });

  it("detects roster changes across games", () => {
    expect(
      teamsChangedDuringNight(
        [
          [
            {
              name: "Team 1",
              averageSum: 200,
              players: [{ id: "a", name: "A" }],
            },
            {
              name: "Team 2",
              averageSum: 200,
              players: [{ id: "b", name: "B" }],
            },
          ],
          [
            {
              name: "Team 1",
              averageSum: 200,
              players: [{ id: "a", name: "A" }],
            },
            {
              name: "Team 2",
              averageSum: 200,
              players: [{ id: "c", name: "C" }],
            },
          ],
        ],
        2,
      ),
    ).toBe(true);
    expect(
      teamsChangedDuringNight(
        [
          [
            {
              name: "Team 1",
              averageSum: 200,
              players: [{ id: "a", name: "A" }],
            },
            {
              name: "Team 2",
              averageSum: 200,
              players: [{ id: "b", name: "B" }],
            },
          ],
          [
            {
              name: "Team 1",
              averageSum: 200,
              players: [{ id: "a", name: "A" }],
            },
            {
              name: "Team 2",
              averageSum: 200,
              players: [{ id: "b", name: "B" }],
            },
          ],
        ],
        2,
      ),
    ).toBe(false);
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
    expect(result.complete).toBe(true);
    expect(
      result.teams.find((team) => team.teamName === "Team 2"),
    ).toMatchObject({
      total: 235,
      won: true,
    });
  });

  it("computes monday average from recorded games", () => {
    expect(mondayAverageFromScores([120, 140, null, 160])).toBe(140);
    expect(mondayAverageFromScores([null, null])).toBeNull();
  });

  it("awards one $5 Game 3 ticket per five players and sends the remainder to the pot", () => {
    const players = Array.from({ length: 12 }, (_, index) => ({
      id: String(index + 1),
      name: `Player ${index + 1}`,
      usedAverage: 150,
    }));
    const scores = Object.fromEntries(
      players.map((player, index) => [
        player.id,
        [null, null, 150 + index] as [null, null, number],
      ]),
    );
    const prize = computeLastGamePrize({ players, scores });
    expect(prize).toMatchObject({
      participantCount: 12,
      contribution: 12,
      ticketCount: 2,
      payout: 10,
      clubPotAdded: 2,
    });
    expect(prize.winners.map((winner) => winner.name)).toEqual([
      "Player 12",
      "Player 11",
    ]);
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

  it("scratch tickets go to lottery players with 2+ game wins, including late joins", () => {
    const games = [
      {
        gameIndex: 0,
        winnerName: "Team 1",
        lastName: "Team 2",
        margin: 10,
        teams: [
          {
            teamName: "Team 1",
            playerIds: ["a"],
            scratch: 200,
            handicap: 0,
            total: 200,
            place: 1,
            won: true,
          },
          {
            teamName: "Team 2",
            playerIds: ["b"],
            scratch: 100,
            handicap: 0,
            total: 100,
            place: 2,
            won: false,
          },
        ],
      },
      {
        gameIndex: 1,
        winnerName: "Team 1",
        lastName: "Team 2",
        margin: 10,
        teams: [
          {
            teamName: "Team 1",
            playerIds: ["a", "c"],
            scratch: 200,
            handicap: 0,
            total: 200,
            place: 1,
            won: true,
          },
          {
            teamName: "Team 2",
            playerIds: ["b"],
            scratch: 100,
            handicap: 0,
            total: 100,
            place: 2,
            won: false,
          },
        ],
      },
      {
        gameIndex: 2,
        winnerName: "Team 1",
        lastName: "Team 2",
        margin: 10,
        teams: [
          {
            teamName: "Team 1",
            playerIds: ["a", "c"],
            scratch: 200,
            handicap: 0,
            total: 200,
            place: 1,
            won: true,
          },
          {
            teamName: "Team 2",
            playerIds: ["b"],
            scratch: 100,
            handicap: 0,
            total: 100,
            place: 2,
            won: false,
          },
        ],
      },
    ];
    const winners = computeScratchWinners({
      games,
      players: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
      ],
      lotteryIds: ["a", "c"],
    });
    expect(winners).toEqual([
      { playerId: "a", name: "A", wins: 3 },
      { playerId: "c", name: "C", wins: 2 },
    ]);
  });

  it("does not award scratch to lottery players with only one win", () => {
    const winners = computeScratchWinners({
      games: [
        {
          gameIndex: 0,
          winnerName: "Team 1",
          lastName: "Team 2",
          margin: 5,
          teams: [
            {
              teamName: "Team 1",
              playerIds: ["a"],
              scratch: 150,
              handicap: 0,
              total: 150,
              place: 1,
              won: true,
            },
            {
              teamName: "Team 2",
              playerIds: ["b"],
              scratch: 100,
              handicap: 0,
              total: 100,
              place: 2,
              won: false,
            },
          ],
        },
      ],
      players: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      lotteryIds: ["a", "b"],
    });
    expect(winners).toEqual([]);
  });
});
