import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-membership-"));
process.env.BOWLING_DB_PATH = path.join(tempDir, "membership.db");
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.LIBSQL_URL;
delete process.env.LIBSQL_AUTH_TOKEN;

describe("club membership dues", () => {
  afterAll(async () => {
    vi.useRealTimers();
    const { closeDb } = await import("@/lib/db");
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("raises next collection on signup without raising the pot until the next 9th", async () => {
    const { listPlayers } = await import("@/lib/db");
    const { getScratchMoney, setScratchPoolMember } =
      await import("@/lib/money");
    const member = listPlayers()[0];
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T20:00:00Z"));
    const before = getScratchMoney();

    setScratchPoolMember(member.id, true);
    const joined = getScratchMoney();
    expect(joined.balance).toBe(before.balance);
    expect(joined.nextDuesTotal).toBe(before.nextDuesTotal + 20);
    expect(joined.members.some((entry) => entry.id === member.id)).toBe(false);
    expect(
      listPlayers().find((entry) => entry.id === member.id)?.scratchPool,
    ).toBe(false);
    expect(joined.entries.filter((row) => row.kind === "dues")).toHaveLength(0);

    vi.setSystemTime(new Date("2026-10-09T20:00:00Z"));
    const collected = getScratchMoney();
    expect(collected.balance).toBe(before.balance + 20);
    expect(collected.members.some((entry) => entry.id === member.id)).toBe(
      true,
    );
    expect(
      listPlayers().find((entry) => entry.id === member.id)?.scratchPool,
    ).toBe(true);
    expect(collected.entries.filter((row) => row.kind === "dues")).toHaveLength(
      1,
    );
    expect(getScratchMoney().balance).toBe(collected.balance);

    vi.setSystemTime(new Date("2026-11-09T20:00:00Z"));
    const nextMonth = getScratchMoney();
    expect(nextMonth.balance).toBe(before.balance + 40);
    expect(nextMonth.entries.filter((row) => row.kind === "dues")).toHaveLength(
      2,
    );
  });

  it("removes only the verified late September signup charge during migration", async () => {
    const { closeDb, getDb } = await import("@/lib/db");
    vi.useRealTimers();
    const db = getDb();
    db.prepare(
      "INSERT INTO players(id, display_name, scratch_pool) VALUES (17, 'Late member', 1)",
    ).run();
    db.prepare(
      `INSERT INTO scratch_ledger(id, entry_date, kind, player_id, player_name, amount, month_key, created_at)
       VALUES (1691, '2026-09-09', 'dues', 17, 'Late member', 20, '2026-09', '2026-09-30 00:20:57')`,
    ).run();
    db.exec("ALTER TABLE players DROP COLUMN scratch_dues_start_month");
    closeDb();

    const migrated = getDb();
    expect(
      migrated
        .prepare("SELECT scratch_dues_start_month FROM players WHERE id = 17")
        .get(),
    ).toMatchObject({ scratch_dues_start_month: "2026-10" });
    expect(
      migrated.prepare("SELECT id FROM scratch_ledger WHERE id = 1691").get(),
    ).toBeUndefined();
  });

  it("corrects Jinsol's October 5 ticket while keeping other winners", async () => {
    const { closeDb, getDb } = await import("@/lib/db");
    const db = getDb();
    db.prepare(
      "INSERT INTO players(id, display_name, scratch_pool, scratch_dues_start_month) VALUES (18, 'Jinsol Bae', 1, '2026-10')",
    ).run();
    db.prepare(
      "INSERT INTO players(id, display_name, scratch_pool) VALUES (19, 'Other member', 1)",
    ).run();
    db.prepare(
      `INSERT INTO sessions(id, session_date, mode, team_count, target_team_size, seed,
      handicap_settings_json, attendees_json, absent_ids_json, generated_teams_json,
      final_teams_json, fairness_json, lottery_ids_json, scratch_winners_json, created_at)
      VALUES (81, '2026-10-05', 'BALANCE', 2, 3, 'test', '{}', '[]', '[]', '[]', '[]', '{}',
        '["18","19"]', '[{"playerId":"18","name":"Jinsol Bae","wins":2},{"playerId":"19","name":"Other member","wins":2}]',
        '2026-10-06 00:00:00')`,
    ).run();
    db.prepare(
      `INSERT INTO scratch_ledger(entry_date, kind, player_id, player_name, amount, session_id)
      VALUES ('2026-10-05', 'ticket', 18, 'Jinsol Bae', -10, 81),
             ('2026-10-05', 'ticket', 19, 'Other member', -10, 81)`,
    ).run();
    closeDb();

    const repaired = getDb();
    const session = repaired
      .prepare(
        "SELECT lottery_ids_json lotteryIds, scratch_winners_json winners FROM sessions WHERE id = 81",
      )
      .get() as { lotteryIds: string; winners: string };
    expect(JSON.parse(session.lotteryIds)).toEqual(["19"]);
    expect(JSON.parse(session.winners)).toEqual([
      { playerId: "19", name: "Other member", wins: 2 },
    ]);
    expect(
      repaired
        .prepare("SELECT player_name FROM scratch_ledger WHERE session_id = 81")
        .all(),
    ).toEqual([{ player_name: "Other member" }]);
  });
});
