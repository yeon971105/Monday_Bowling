import { describe, expect, it } from "vitest";
import { defaultDecisionsForReview, type ImportReview } from "@/lib/import-review";

describe("default import decisions", () => {
  it("auto-updates exact/alias Monday members and ignores everyone else", () => {
    const review = {
      reviewRows: [
        {
          rowIndex: 0,
          category: "EXACT",
          playerId: 1,
          printedName: "Jewon Yeon",
        },
        {
          rowIndex: 1,
          category: "ALIAS",
          playerId: 2,
          printedName: "Kimberly Panel",
        },
        {
          rowIndex: 2,
          category: "NEW",
          playerId: null,
          printedName: "Someone Else",
        },
        {
          rowIndex: 3,
          category: "PROBABLE",
          playerId: 3,
          printedName: "Close Match",
        },
        {
          rowIndex: 4,
          category: "AMBIGUOUS",
          playerId: null,
          printedName: "Jeremy Cerda",
        },
      ],
    } as ImportReview;

    expect(defaultDecisionsForReview(review)).toEqual([
      {
        rowIndex: 0,
        action: "UPDATE",
        playerId: 1,
        saveAlias: false,
      },
      {
        rowIndex: 1,
        action: "UPDATE",
        playerId: 2,
        saveAlias: true,
      },
      { rowIndex: 2, action: "IGNORE" },
      { rowIndex: 3, action: "IGNORE" },
      { rowIndex: 4, action: "IGNORE" },
    ]);
  });
});
