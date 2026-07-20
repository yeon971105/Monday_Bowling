import { describe, expect, it } from "vitest";
import { calculateHandicap } from "@/lib/bowling";

const standard = {
  handicapBase: 220,
  handicapPercentage: 0.9,
  handicapRounding: "floor" as const,
};

describe("handicap calculation", () => {
  it.each([
    [220, 0],
    [200, 18],
    [186, 30],
    [150, 63],
    [134, 77],
    [221, 0],
    [300, 0],
  ])("%i produces %i", (average, expected) => {
    expect(calculateHandicap(average, standard)).toBe(expected);
  });
  it("uses changed base and percentage immediately", () => {
    expect(
      calculateHandicap(180, {
        handicapBase: 200,
        handicapPercentage: 0.8,
        handicapRounding: "floor",
      }),
    ).toBe(16);
    expect(
      calculateHandicap(180, {
        handicapBase: 210,
        handicapPercentage: 1,
        handicapRounding: "round",
      }),
    ).toBe(30);
  });
});
