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

  beforeAll(async () => {
    ({ POST, GET } = await import("@/app/api/[...segments]/route"));
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

  it("refreshes MANUAL average from saved game scores", async () => {
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

    // Guests without a league average need 3 Monday nights before history avg applies.
    for (const sessionDate of ["2026-07-06", "2026-07-13", "2026-07-20"]) {
      const save = await POST(
        new NextRequest("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...sessionBody, sessionDate }),
        }),
        routeContext(["sessions"]),
      );
      expect(save.ok).toBe(true);
      if (sessionDate === "2026-07-20") {
        const saved = await save.json();
        expect(saved.manualAveragesUpdated).toBeGreaterThanOrEqual(1);
      }
    }

    const playersResponse = await GET(
      new NextRequest("http://localhost/api/players"),
      routeContext(["players"]),
    );
    const { players } = await playersResponse.json();
    const updated = players.find(
      (player: { displayName: string }) => player.displayName === "Guest Bowler",
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
      (player: { displayName: string }) => player.displayName === "Guest Bowler",
    );
    expect(guestStats).toMatchObject({
      mondayAverage: 190,
      wins: 0,
      losses: 9,
      sessions: 3,
    });
  });
});
