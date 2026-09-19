import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-payout-"));
process.env.BOWLING_DB_PATH = path.join(tempDir, "payout.db");
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.LIBSQL_URL;
delete process.env.LIBSQL_AUTH_TOKEN;

describe("manual club payouts", () => {
  afterAll(async () => {
    const { closeDb } = await import("@/lib/db");
    closeDb();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows may keep a brief lock on the closed SQLite file.
    }
  });

  it("records who received money and keeps it on the ledger", async () => {
    const { listPlayers } = await import("@/lib/db");
    const {
      deleteScratchPayout,
      getScratchMoney,
      recordScratchPayouts,
      setScratchPoolMember,
    } = await import("@/lib/money");
    const players = listPlayers();
    const first = players[0];
    const second = players[1];
    expect(first && second).toBeTruthy();
    setScratchPoolMember(first.id, true);
    setScratchPoolMember(second.id, true);
    const before = getScratchMoney(new Date("2026-09-16T20:00:00Z"));
    const after = recordScratchPayouts({
      date: "2026-09-16",
      amount: 50,
      playerIds: [first.id, second.id],
      note: "Pot split",
    });
    const payouts = after.entries.filter((entry) => entry.kind === "payout");
    expect(payouts).toHaveLength(2);
    expect(after.balance).toBe(before.balance - 100);
    expect(payouts.every((entry) => entry.date === "2026-09-16")).toBe(true);
    expect(payouts.every((entry) => entry.note === "Pot split")).toBe(true);
    const undone = deleteScratchPayout(payouts[0].id);
    expect(undone.entries.filter((entry) => entry.kind === "payout")).toHaveLength(
      1,
    );
    expect(undone.balance).toBe(before.balance - 50);
  });
});
