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
    expect(
      undone.entries.filter((entry) => entry.kind === "payout"),
    ).toHaveLength(1);
    expect(undone.balance).toBe(before.balance - 50);
  });

  it("records Game 3 entry fees and tickets with only the remainder added", async () => {
    const { getScratchMoney, recordLastGamePrize } =
      await import("@/lib/money");
    const before = getScratchMoney(new Date("2026-09-16T20:00:00Z"));
    recordLastGamePrize({
      sessionId: 42,
      sessionDate: "2026-09-16",
      prize: {
        participantCount: 12,
        contribution: 12,
        ticketCount: 2,
        payout: 10,
        clubPotAdded: 2,
        winners: [
          {
            playerId: "101",
            name: "A",
            score: 200,
            usedAverage: 150,
            improvement: 50,
          },
          {
            playerId: "102",
            name: "B",
            score: 190,
            usedAverage: 150,
            improvement: 40,
          },
        ],
      },
    });
    const after = getScratchMoney(new Date("2026-09-16T20:00:00Z"));
    expect(after.balance).toBe(before.balance + 2);
    expect(
      after.entries
        .filter((entry) => entry.sessionId === 42)
        .map((entry) => entry.amount),
    ).toEqual(expect.arrayContaining([12, -5, -5]));
  });
});
