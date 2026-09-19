import { describe, expect, it } from "vitest";
import {
  duesMonthKeysDue,
  formatScratchMoney,
  nextDuesDate,
  nextMonthKey,
  withRunningBalances,
} from "@/lib/money";

describe("scratch money calendar", () => {
  it("does not collect before the 9th", () => {
    expect(duesMonthKeysDue("2026-09-07")).toEqual([]);
    expect(nextDuesDate("2026-09-07")).toBe("2026-09-09");
  });

  it("collects on and after the 9th, including missed months", () => {
    expect(duesMonthKeysDue("2026-09-09")).toEqual(["2026-09"]);
    expect(duesMonthKeysDue("2026-10-08")).toEqual(["2026-09"]);
    expect(duesMonthKeysDue("2026-10-09")).toEqual(["2026-09", "2026-10"]);
    expect(nextDuesDate("2026-09-09")).toBe("2026-10-09");
    expect(nextMonthKey("2026-12")).toBe("2027-01");
  });
});

describe("scratch money ledger", () => {
  it("tracks remaining pot after dues and $10 tickets", () => {
    const rows = withRunningBalances([
      { amount: 20 },
      { amount: 20 },
      { amount: -10 },
    ]);
    expect(rows.map((row) => row.balanceAfter)).toEqual([20, 40, 30]);
    expect(formatScratchMoney(-10, true)).toBe("-$10");
    expect(formatScratchMoney(20, true)).toBe("+$20");
  });
});

describe("ledger dates", () => {
  it("accepts real calendar days only", async () => {
    const { isLedgerDate } = await import("@/lib/money");
    expect(isLedgerDate("2026-09-16")).toBe(true);
    expect(isLedgerDate("2026-02-29")).toBe(false);
    expect(isLedgerDate("09/16/2026")).toBe(false);
  });
});
