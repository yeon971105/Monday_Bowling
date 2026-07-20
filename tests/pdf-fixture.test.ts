import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import pdf from "pdf-parse";
import { parseBlsText } from "@/lib/pdf-parser";

const filename = path.join(process.cwd(), "fixtures", "OH260716-10.pdf");

describe("real OH260716-10.pdf fixture", () => {
  it("exists, is readable, and identifies the real league metadata", async () => {
    expect(fs.existsSync(filename)).toBe(true);
    const extracted = await pdf(fs.readFileSync(filename));
    const parsed = parseBlsText(extracted.text);
    expect(extracted.numpages).toBe(2);
    expect(parsed).toMatchObject({
      leagueName: "Ohana League",
      bowlingCenter: "4th Street Bowl",
      leagueDate: "7/16/2026",
      weekNumber: 10,
      errors: [],
    });
  });

  it("parses Jewon Yeon and See Won Kim from their correct teams", async () => {
    const parsed = parseBlsText((await pdf(fs.readFileSync(filename))).text);
    expect(
      parsed.players.find((p) => p.printedName === "Jewon Yeon"),
    ).toMatchObject({
      currentAverage: 186,
      pdfHandicap: 30,
      games: 27,
      pins: 5036,
      teamNumber: 17,
      teamName: "Team 17",
      temporarySubstitute: false,
    });
    expect(
      parsed.players.find((p) => p.printedName === "See Won Kim"),
    ).toMatchObject({
      currentAverage: 134,
      pdfHandicap: 77,
      games: 27,
      pins: 3626,
      teamNumber: 18,
      teamName: "Team 18",
      temporarySubstitute: false,
    });
  });

  it("handles BLS special cases without using later numeric columns", async () => {
    const parsed = parseBlsText((await pdf(fs.readFileSync(filename))).text);
    expect(
      parsed.players.find((p) => p.printedName === "John Heflin"),
    ).toMatchObject({
      currentAverage: 178,
      pdfHandicap: 37,
      games: 3,
      pins: 602,
    });
    expect(
      parsed.players.find((p) => p.printedName === "Greg Romano"),
    ).toMatchObject({
      currentAverage: 199,
      pdfHandicap: 18,
      games: 3,
      pins: 546,
    });
    expect(
      parsed.players.find((p) => p.printedName === "Jeremy Cerda"),
    ).toMatchObject({ currentAverage: 175, temporarySubstitute: true });
    expect(
      parsed.players.find((p) => p.printedName === "Clint Ho"),
    ).toMatchObject({ currentAverage: 205, temporarySubstitute: true });
    expect(
      parsed.players.find((p) => p.printedName === "Kimberly Panel"),
    ).toMatchObject({ currentAverage: 143 });
    expect(
      parsed.players.find(
        (p) => p.printedName === "Andrew Nguye" && p.teamNumber === 2,
      ),
    ).toMatchObject({ currentAverage: 174 });
    expect(
      parsed.players.find((p) => p.printedName === "Roxie Bryant"),
    ).toMatchObject({
      currentAverage: 97,
      pdfHandicap: 110,
      games: 21,
      pins: 2055,
    });
    expect(
      parsed.players.find((p) => p.printedName === "Bernard Polk"),
    ).toMatchObject({ currentAverage: 220, pdfHandicap: 0 });
    expect(
      parsed.players.find((p) => p.printedName === "Anthony Panel"),
    ).toMatchObject({ currentAverage: 221, pdfHandicap: 0 });
    expect(parsed.players.filter((p) => p.teamNumber === 17)).toHaveLength(5);
    expect(parsed.players.some((p) => /Team 17/.test(p.printedName))).toBe(
      false,
    );
  });
});
