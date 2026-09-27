import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-scoring-"));
process.env.BOWLING_DB_PATH = path.join(tempDir, "scoring.db");
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.LIBSQL_URL;
delete process.env.LIBSQL_AUTH_TOKEN;

const routeContext = (segments: string[]) => ({
  params: Promise.resolve({ segments }),
});

describe("session save updates MANUAL monday averages", () => {
  let POST: typeof import("@/app/api/[...segments]/route").POST;
  let GET: typeof import("@/app/api/[...segments]/route").GET;
  let PUT: typeof import("@/app/api/[...segments]/route").PUT;

  beforeAll(async () => {
    ({ POST, GET, PUT } = await import("@/app/api/[...segments]/route"));
  });

  afterAll(async () => {
    const { closeDb } = await import("@/lib/db");
    closeDb();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows may keep a brief lock on the closed SQLite file.
    }
  });

  it("keeps manual input below 9 total games and switches at 9", async () => {
    const create = await POST(
      new NextRequest("http://localhost/api/players", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Guest Bowler",
          averageMode: "MANUAL",
          manualAverage: 120,
        }),
      }),
      routeContext(["players"]),
    );
    expect(create.ok).toBe(true);
    const guest = await create.json();

    const teams = [
      {
        name: "Team 1",
        players: [
          {
            id: String(guest.id),
            name: guest.displayName,
            usedAverage: 120,
            averageMode: "MANUAL",
            handicap: 90,
            projectedScore: 210,
          },
        ],
        metrics: {
          scratchTotal: 120,
          handicapTotal: 90,
          projectedTotal: 210,
          scratchPerPlayer: 120,
          projectedPerPlayer: 210,
          tierCounts: { A: 0, B: 0, C: 1, D: 0 },
        },
      },
      {
        name: "Team 2",
        players: [
          {
            id: "999001",
            name: "Temp A",
            usedAverage: 150,
            averageMode: "MANUAL",
            handicap: 63,
            projectedScore: 213,
            guest: true,
          },
          {
            id: "999002",
            name: "Temp B",
            usedAverage: 150,
            averageMode: "MANUAL",
            handicap: 63,
            projectedScore: 213,
            guest: true,
          },
        ],
        metrics: {
          scratchTotal: 300,
          handicapTotal: 126,
          projectedTotal: 426,
          scratchPerPlayer: 150,
          projectedPerPlayer: 213,
          tierCounts: { A: 0, B: 1, C: 1, D: 0 },
        },
      },
    ];

    const scores = {
      [String(guest.id)]: [180, 190, 200],
      "999001": [140, 140, 140],
      "999002": [140, 140, 140],
    };

    const sessionBody = {
      mode: "BALANCED",
      targetTeamSize: 2,
      seed: "test-seed",
      attendees: teams.flatMap((team) => team.players),
      teams,
      fairness: { score: 0 },
      scores,
      results: [
        {
          teamName: "Team 1",
          gameTotals: [180, 190, 200],
          scratchTotal: 570,
          handicapTotal: 0,
          finalTotal: 570,
          handicapPerGame: 0,
          won: true,
        },
        {
          teamName: "Team 2",
          gameTotals: [280, 280, 280],
          scratchTotal: 840,
          handicapTotal: 0,
          finalTotal: 840,
          handicapPerGame: 0,
          won: false,
        },
      ],
      gameCount: 3,
    };

    const shortNightBody = {
      ...sessionBody,
      scores: {
        [String(guest.id)]: [190, 190, null],
        "999001": [140, 140, null],
        "999002": [140, 140, null],
      },
      results: [],
      gameCount: 2,
    };
    for (const sessionDate of ["2026-07-06", "2026-07-13", "2026-07-20"]) {
      const save = await POST(
        new NextRequest("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...shortNightBody, sessionDate }),
        }),
        routeContext(["sessions"]),
      );
      expect(save.ok).toBe(true);
      if (sessionDate === "2026-07-20") {
        const saved = await save.json();
        expect(saved.manualAveragesUpdated).toBe(0);
      }
    }

    const playersAtSixResponse = await GET(
      new NextRequest("http://localhost/api/players"),
      routeContext(["players"]),
    );
    const { players: playersAtSix } = await playersAtSixResponse.json();
    expect(
      playersAtSix.find((player: { id: number }) => player.id === guest.id),
    ).toMatchObject({ manualAverage: 120, usedAverage: 120 });

    const ninthGameSave = await POST(
      new NextRequest("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...sessionBody,
          sessionDate: "2026-07-27",
          results: [],
        }),
      }),
      routeContext(["sessions"]),
    );
    expect(ninthGameSave.ok).toBe(true);
    expect(
      (await ninthGameSave.json()).manualAveragesUpdated,
    ).toBeGreaterThanOrEqual(1);

    const playersResponse = await GET(
      new NextRequest("http://localhost/api/players"),
      routeContext(["players"]),
    );
    const { players } = await playersResponse.json();
    const updated = players.find(
      (player: { displayName: string }) =>
        player.displayName === "Guest Bowler",
    );
    expect(updated).toMatchObject({
      averageMode: "MANUAL",
      manualAverage: 190,
      usedAverage: 190,
    });

    const statsResponse = await GET(
      new NextRequest("http://localhost/api/stats"),
      routeContext(["stats"]),
    );
    const { players: stats } = await statsResponse.json();
    const guestStats = stats.find(
      (player: { displayName: string }) =>
        player.displayName === "Guest Bowler",
    );
    expect(guestStats).toMatchObject({
      mondayAverage: 190,
      gamesPlayed: 9,
      wins: 0,
      losses: 0,
      sessions: 4,
    });
  });

  it("keeps the current average below 9 games and unlocks at 9", async () => {
    const create = await POST(
      new NextRequest("http://localhost/api/players", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Locked Bowler",
          averageMode: "FIXED",
          fixedAverage: 120,
        }),
      }),
      routeContext(["players"]),
    );
    const player = await create.json();
    const teams = [
      {
        name: "Team 1",
        players: [
          {
            id: String(player.id),
            name: player.displayName,
            usedAverage: 120,
            averageMode: "FIXED",
            handicap: 90,
            projectedScore: 210,
          },
        ],
        metrics: {
          scratchTotal: 120,
          handicapTotal: 90,
          projectedTotal: 210,
          scratchPerPlayer: 120,
          projectedPerPlayer: 210,
          tierCounts: { A: 1, B: 0, C: 0, D: 0 },
        },
      },
      {
        name: "Team 2",
        players: [
          {
            id: "locked-opponent",
            name: "Opponent",
            usedAverage: 150,
            averageMode: "MANUAL",
            handicap: 63,
            projectedScore: 213,
          },
        ],
        metrics: {
          scratchTotal: 150,
          handicapTotal: 63,
          projectedTotal: 213,
          scratchPerPlayer: 150,
          projectedPerPlayer: 213,
          tierCounts: { A: 0, B: 1, C: 0, D: 0 },
        },
      },
    ];
    for (let night = 0; night < 2; night += 1) {
      const save = await POST(
        new NextRequest("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "BALANCED",
            targetTeamSize: 1,
            seed: `locked-${night}`,
            attendees: teams.flatMap((team) => team.players),
            teams,
            gameRosters: [teams, teams, teams],
            scores: {
              [String(player.id)]: [180, 180, 180],
              "locked-opponent": [150, 150, 150],
            },
            results: [],
            lotteryIds: [],
            scratchWinners: [],
            gameCount: 3,
          }),
        }),
        routeContext(["sessions"]),
      );
      expect(save.ok).toBe(true);
    }

    const firstGame = await POST(
      new NextRequest("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "BALANCED",
          targetTeamSize: 1,
          seed: "locked-third-night",
          attendees: teams.flatMap((team) => team.players),
          teams,
          gameRosters: [teams, teams, teams],
          scores: {
            [String(player.id)]: [180, null, null],
            "locked-opponent": [150, null, null],
          },
          results: [],
          lotteryIds: [],
          scratchWinners: [],
          gameCount: 1,
        }),
      }),
      routeContext(["sessions"]),
    );
    expect(firstGame.ok).toBe(true);
    const firstGameSaved = await firstGame.json();
    const statsAtSevenResponse = await GET(
      new NextRequest("http://localhost/api/stats"),
      routeContext(["stats"]),
    );
    const { players: statsAtSeven } = await statsAtSevenResponse.json();
    expect(
      statsAtSeven.find((row: { id: number }) => row.id === player.id),
    ).toMatchObject({
      averageMode: "FIXED",
      gamesPlayed: 7,
      mondayAverage: 180,
      handicapAverage: 120,
      handicap: 90,
    });

    const scoresThroughGameTwo = {
      [String(player.id)]: [180, 180, null],
      "locked-opponent": [150, 150, null],
    };
    const secondGame = await PUT(
      new NextRequest(`http://localhost/api/sessions/${firstGameSaved.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scores: scoresThroughGameTwo }),
      }),
      routeContext(["sessions", String(firstGameSaved.id)]),
    );
    expect(secondGame.ok).toBe(true);
    const statsAtEightResponse = await GET(
      new NextRequest("http://localhost/api/stats"),
      routeContext(["stats"]),
    );
    const { players: statsAtEight } = await statsAtEightResponse.json();
    expect(
      statsAtEight.find((row: { id: number }) => row.id === player.id),
    ).toMatchObject({
      averageMode: "FIXED",
      gamesPlayed: 8,
      mondayAverage: 180,
      handicapAverage: 120,
      handicap: 90,
    });

    const ninthGame = await PUT(
      new NextRequest(`http://localhost/api/sessions/${firstGameSaved.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scores: {
            [String(player.id)]: [180, 180, 180],
            "locked-opponent": [150, 150, 150],
          },
        }),
      }),
      routeContext(["sessions", String(firstGameSaved.id)]),
    );
    expect(ninthGame.ok).toBe(true);

    const statsAtNineResponse = await GET(
      new NextRequest("http://localhost/api/stats"),
      routeContext(["stats"]),
    );
    const { players: statsAtNine } = await statsAtNineResponse.json();
    expect(
      statsAtNine.find((row: { id: number }) => row.id === player.id),
    ).toMatchObject({
      gamesPlayed: 9,
      mondayAverage: 180,
      handicapAverage: 180,
      handicap: 36,
    });
    const playersResponse = await GET(
      new NextRequest("http://localhost/api/players"),
      routeContext(["players"]),
    );
    const { players } = await playersResponse.json();
    expect(
      players.find((row: { id: number }) => row.id === player.id),
    ).toMatchObject({
      averageMode: "MANUAL",
      fixedAverage: null,
      manualAverage: 180,
      usedAverage: 180,
    });
    const statsResponse = await GET(
      new NextRequest("http://localhost/api/stats"),
      routeContext(["stats"]),
    );
    const { players: stats } = await statsResponse.json();
    expect(
      stats.find((row: { id: number }) => row.id === player.id),
    ).toMatchObject({
      gamesPlayed: 9,
      mondayAverage: 180,
      handicapAverage: 180,
      handicap: 36,
    });
  });
});
