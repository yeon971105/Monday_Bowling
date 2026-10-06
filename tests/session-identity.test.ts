import { afterAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-identity-"));
process.env.BOWLING_DB_PATH = path.join(tempDir, "identity.db");
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.LIBSQL_URL;
delete process.env.LIBSQL_AUTH_TOKEN;

afterAll(async () => {
  const { closeDb } = await import("@/lib/db");
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

it("attributes October 5 Temp Guest games to Dongyoung without changing scores or averages", async () => {
  const { closeDb, getDb } = await import("@/lib/db");
  const { computePlayerStats } = await import("@/lib/stats");
  const db = getDb();
  db.prepare(
    "INSERT INTO players(id, display_name, average_mode, manual_average) VALUES (30, 'Temp Guest', 'MANUAL', 150), (31, 'Dongyoung Park', 'MANUAL', 133)",
  ).run();
  db.prepare(
    `INSERT INTO sessions(id, session_date, mode, team_count, target_team_size, seed,
    handicap_settings_json, attendees_json, absent_ids_json, generated_teams_json,
    final_teams_json, fairness_json, scores_json, game_rosters_json, game_results_json, created_at)
    VALUES (82, '2026-10-05', 'BALANCE', 2, 3, 'test', '{}',
      '[{"id":"30","name":"Temp Guest"}]', '[31]',
      '[{"name":"Team 1","players":[{"id":"30","name":"Temp Guest","usedAverage":150}]}]',
      '[{"name":"Team 1","players":[{"id":"30","name":"Temp Guest","usedAverage":150}]}]',
      '{}', '{"30":[105,113,135]}',
      '[[{"name":"Team 1","players":[{"id":"30","name":"Temp Guest","usedAverage":150}]}]]',
      '[{"gameIndex":0,"teams":[{"teamName":"Team 1","playerIds":["30"],"won":false}]}]',
      '2026-10-06 00:00:00')`,
  ).run();
  db.prepare("UPDATE sessions SET game_results_json = ? WHERE id = 82").run(
    JSON.stringify(
      [0, 1, 2].map((gameIndex) => ({
        gameIndex,
        winnerName: "Team 2",
        lastName: "Team 1",
        teams: [{ teamName: "Team 1", playerIds: ["30"], won: false }],
      })),
    ),
  );
  closeDb();

  const repaired = getDb();
  const row = repaired
    .prepare(
      "SELECT scores_json scores, final_teams_json teams, game_rosters_json rosters, game_results_json games, attendees_json attendees, absent_ids_json absent FROM sessions WHERE id = 82",
    )
    .get() as Record<string, string>;
  expect(JSON.parse(row.scores)).toEqual({ 31: [105, 113, 135] });
  expect(JSON.parse(row.teams)[0].players[0]).toMatchObject({
    id: "31",
    name: "Dongyoung Park",
    usedAverage: 150,
  });
  expect(JSON.parse(row.rosters)[0][0].players[0].name).toBe("Dongyoung Park");
  expect(JSON.parse(row.games)[0].teams[0].playerIds).toEqual(["31"]);
  expect(JSON.parse(row.attendees)[0].name).toBe("Dongyoung Park");
  expect(JSON.parse(row.absent)).toEqual([]);
  const stats = computePlayerStats(repaired);
  expect(
    stats.find((player) => player.displayName === "Dongyoung Park"),
  ).toMatchObject({
    gamesPlayed: 3,
    wins: 0,
    losses: 3,
    totalPins: 353,
    usedAverage: 133,
  });
  expect(
    stats.find((player) => player.displayName === "Temp Guest")?.gamesPlayed,
  ).toBe(0);
});
