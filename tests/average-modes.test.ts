import { describe, expect, it } from "vitest";
import { resolveUsedAverage, validateAverage } from "@/lib/bowling";

describe("average modes", () => {
  it("AUTO follows an accepted PDF league value", () => {
    expect(
      resolveUsedAverage({
        averageMode: "AUTO",
        leagueAverage: 186,
        manualAverage: 170,
        fixedAverage: null,
      }),
    ).toBe(186);
    expect(
      resolveUsedAverage({
        averageMode: "AUTO",
        leagueAverage: 190,
        manualAverage: 170,
        fixedAverage: null,
      }),
    ).toBe(190);
  });
  it("MANUAL is not overwritten when league reference changes", () => {
    expect(
      resolveUsedAverage({
        averageMode: "MANUAL",
        leagueAverage: 200,
        manualAverage: 177,
        fixedAverage: null,
      }),
    ).toBe(177);
  });
  it("FIXED retains its lock while recording the latest league average", () => {
    const record = {
      averageMode: "FIXED" as const,
      leagueAverage: 205,
      manualAverage: 175,
      fixedAverage: 188,
    };
    expect(resolveUsedAverage(record)).toBe(188);
    expect(record.leagueAverage).toBe(205);
  });
  it("unlocks FIXED to the selected source mode", () => {
    const values = {
      leagueAverage: 191,
      manualAverage: 180,
      fixedAverage: 188,
    };
    expect(resolveUsedAverage({ averageMode: "AUTO", ...values })).toBe(191);
    expect(resolveUsedAverage({ averageMode: "MANUAL", ...values })).toBe(180);
  });
  it("supports non-league manual players and rejects unreasonable averages", () => {
    expect(
      resolveUsedAverage({
        averageMode: "MANUAL",
        leagueAverage: null,
        manualAverage: 145,
        fixedAverage: null,
      }),
    ).toBe(145);
    expect(() => validateAverage(301, false)).toThrow(/0 and 300/);
  });
});
