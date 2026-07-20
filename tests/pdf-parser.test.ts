import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseBlsText } from "@/lib/pdf-parser";

const fixture = fs.readFileSync(
  path.join(process.cwd(), "tests", "fixtures", "bls-rosters.txt"),
  "utf8",
);
const parsed = parseBlsText(fixture);

describe("BLS Team Rosters text parser", () => {
  it("parses known player average, games, and pins from the leading roster columns", () => {
    expect(
      parsed.players.find((p) => p.printedName === "Jewon Yeon"),
    ).toMatchObject({
      currentAverage: 186,
      games: 27,
      pins: 5036,
      teamNumber: 1,
      teamName: "Rolling Stones",
    });
    expect(
      parsed.players.find((p) => p.printedName === "See Won Kim"),
    ).toMatchObject({
      currentAverage: 134,
      games: 27,
      pins: 3626,
      teamNumber: 2,
    });
  });
  it("handles bk averages and blank values", () => {
    expect(
      parsed.players.find((p) => p.printedName === "Bob Bowler"),
    ).toMatchObject({ currentAverage: 178, games: 0, pins: null });
  });
  it("identifies temporary substitutes and truncated names", () => {
    expect(
      parsed.players.find((p) => p.printedName === "Pat Sub"),
    ).toMatchObject({ temporarySubstitute: true, currentAverage: 151 });
  });
  it("does not mistake team headings or later high-game columns for player averages", () => {
    expect(
      parsed.players.some(
        (p) =>
          p.printedName.includes("Rolling Stones") ||
          p.printedName.includes("No Player"),
      ),
    ).toBe(false);
    expect(
      parsed.players.find((p) => p.printedName === "Alice Strong")
        ?.currentAverage,
    ).toBe(210);
  });
  it("extracts league metadata", () => {
    expect(parsed).toMatchObject({ leagueDate: "07/16/2026", weekNumber: 10 });
  });
});
