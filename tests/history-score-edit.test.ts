import { afterAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-history-edit-"));
process.env.BOWLING_DB_PATH = path.join(tempDir, "history.db");
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.LIBSQL_URL;
delete process.env.LIBSQL_AUTH_TOKEN;

afterAll(async () => {
  const { closeDb } = await import("@/lib/db");
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

it("edits saved scores without recalculating results or payouts", async () => {
  const { getDb } = await import("@/lib/db");
  const { PATCH } = await import("@/app/api/[...segments]/route");
  const db = getDb();
  const original = { "10": [110, 120, 124] };
  const changed = { "10": [110, 120, 207] };
  db.prepare(
    `INSERT INTO sessions(session_date, mode, team_count, target_team_size, seed,
      handicap_settings_json, attendees_json, absent_ids_json, generated_teams_json,
      final_teams_json, fairness_json, scores_json, results_json,
      game_results_json, scratch_winners_json, last_game_prize_json)
     VALUES ('2026-09-28', 'BALANCE', 1, 1, 'test', '{}', '[]', '[]', '[]',
       '[{"name":"Team 1","players":[{"id":"10","name":"Insoo Choo"}]}]',
       '{}', ?, '[{"teamName":"Team 1","finalTotal":354}]',
       '[{"winnerName":"Team 1"}]', '[{"playerId":"10","wins":1}]',
       '{"clubPotAdded":5}')`,
  ).run(JSON.stringify(original));
  const id = Number(
    (db.prepare("SELECT id FROM sessions").get() as { id: number }).id,
  );
  db.prepare(
    `INSERT INTO scratch_ledger(entry_date, kind, player_id, player_name, amount, session_id)
     VALUES ('2026-09-28', 'ticket', 10, 'Insoo Choo', 10, ?)`,
  ).run(id);
  const before = db
    .prepare("SELECT * FROM sessions WHERE id=?")
    .get(id) as Record<string, unknown>;

  const request = (scores: unknown, expectedScores: unknown) =>
    new NextRequest(`http://localhost/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scores, expectedScores }),
    });
  const context = {
    params: Promise.resolve({ segments: ["sessions", String(id)] }),
  };

  const invalid = await PATCH(
    request({ "10": [110, 120, 301] }, original),
    context,
  );
  expect(invalid.status).toBe(400);

  const saved = await PATCH(request(changed, original), context);
  expect(saved.ok).toBe(true);
  const after = db
    .prepare("SELECT * FROM sessions WHERE id=?")
    .get(id) as Record<string, unknown>;
  expect(JSON.parse(after.scores_json as string)).toEqual(changed);
  for (const column of [
    "results_json",
    "game_results_json",
    "scratch_winners_json",
    "last_game_prize_json",
    "game_count",
    "final_teams_json",
  ]) {
    expect(after[column]).toEqual(before[column]);
  }
  expect(
    (
      db
        .prepare("SELECT COUNT(*) count FROM scratch_ledger WHERE session_id=?")
        .get(id) as { count: number }
    ).count,
  ).toBe(1);

  const stale = await PATCH(request(original, original), context);
  expect(stale.status).toBe(409);
});
