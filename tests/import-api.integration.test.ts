import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { File } from "node:buffer";
import { NextRequest } from "next/server";

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "monday-bowling-import-"),
);
process.env.BOWLING_DB_PATH = path.join(tempDir, "integration.db");

const routeContext = (segments: string[]) => ({
  params: Promise.resolve({ segments }),
});
let POST: typeof import("@/app/api/[...segments]/route").POST;
let GET: typeof import("@/app/api/[...segments]/route").GET;
let PUT: typeof import("@/app/api/[...segments]/route").PUT;

async function postJson(segments: string[], body: unknown) {
  const response = await POST(
    new NextRequest(`http://localhost/api/${segments.join("/")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    routeContext(segments),
  );
  expect(response.ok).toBe(true);
  return response.json();
}

describe("real PDF import API integration", () => {
  beforeAll(async () => {
    ({ POST, GET, PUT } = await import("@/app/api/[...segments]/route"));
    const { listPlayers } = await import("@/lib/db");
    // Touch DB so the default Monday roster is seeded.
    const seeded = listPlayers(true);
    const jewon = seeded.find((p) => p.displayName === "Jewon Yeon");
    const seeWon = seeded.find((p) => p.displayName === "See Won Kim");
    expect(jewon && seeWon).toBeTruthy();
    await PUT(
      new NextRequest(`http://localhost/api/players/${jewon!.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...jewon,
          averageMode: "AUTO",
          leagueAverage: 180,
        }),
      }),
      routeContext(["players", String(jewon!.id)]),
    );
    await PUT(
      new NextRequest(`http://localhost/api/players/${seeWon!.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...seeWon,
          averageMode: "AUTO",
          leagueAverage: 130,
        }),
      }),
      routeContext(["players", String(seeWon!.id)]),
    );
    await postJson(["players"], {
      displayName: "Manual Bernard",
      leagueName: "Bernard Polk",
      averageMode: "MANUAL",
      manualAverage: 155,
    });
    await postJson(["players"], {
      displayName: "Fixed Anthony",
      leagueName: "Anthony Panel",
      averageMode: "FIXED",
      fixedAverage: 200,
    });
    await postJson(["players"], {
      displayName: "Kimberly Panelo",
      averageMode: "MANUAL",
      manualAverage: 143,
      aliases: ["Kimberly Panel"],
    });
    await postJson(["players"], {
      displayName: "Jeremy Cerd",
      averageMode: "MANUAL",
      manualAverage: 170,
    });
    await postJson(["players"], {
      displayName: "Jeremy Cerdo",
      averageMode: "MANUAL",
      manualAverage: 171,
    });
  });

  afterAll(async () => {
    const { closeDb } = await import("@/lib/db");
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reviews and applies accepted real-PDF changes without overwriting protected averages", async () => {
    const form = new FormData();
    form.set(
      "file",
      new File(
        [
          fs.readFileSync(
            path.join(process.cwd(), "fixtures", "OH260716-10.pdf"),
          ),
        ],
        "OH260716-10.pdf",
        { type: "application/pdf" },
      ) as unknown as Blob,
    );
    const response = await POST(
      new NextRequest("http://localhost/api/imports", {
        method: "POST",
        body: form,
      }),
      routeContext(["imports"]),
    );
    expect(response.ok).toBe(true);
    const review = await response.json();
    expect(review).toMatchObject({
      leagueName: "Ohana League",
      bowlingCenter: "4th Street Bowl",
      leagueDate: "7/16/2026",
      weekNumber: 10,
    });
    const jewon = review.reviewRows.find(
      (row: { printedName: string }) => row.printedName === "Jewon Yeon",
    );
    const bernard = review.reviewRows.find(
      (row: { printedName: string }) => row.printedName === "Bernard Polk",
    );
    const anthony = review.reviewRows.find(
      (row: { printedName: string }) => row.printedName === "Anthony Panel",
    );
    const kimberly = review.reviewRows.find(
      (row: { printedName: string }) => row.printedName === "Kimberly Panel",
    );
    const jeremy = review.reviewRows.find(
      (row: { printedName: string }) => row.printedName === "Jeremy Cerda",
    );
    expect(jewon).toMatchObject({
      category: "EXACT",
      oldAverage: 180,
      currentAverage: 186,
      incomingChangesUsedAverage: true,
    });
    expect(bernard).toMatchObject({
      category: "EXACT",
      usedAverageProtected: true,
      usedAverage: 155,
    });
    expect(anthony).toMatchObject({
      category: "EXACT",
      usedAverageProtected: true,
      usedAverage: 200,
    });
    expect(kimberly).toMatchObject({ category: "ALIAS" });
    expect(jeremy).toMatchObject({
      category: "AMBIGUOUS",
      temporarySubstitute: true,
    });

    const decisions = review.reviewRows.map(
      (row: {
        rowIndex: number;
        printedName: string;
        playerId: number | null;
        category: string;
      }) => {
        if (row.category === "EXACT" || row.category === "ALIAS")
          return {
            rowIndex: row.rowIndex,
            action: "UPDATE" as const,
            playerId: row.playerId,
            saveAlias: row.printedName === "Kimberly Panel",
          };
        return { rowIndex: row.rowIndex, action: "IGNORE" as const };
      },
    );
    await postJson(["imports", String(review.id), "apply"], { decisions });

    const playersResponse = await GET(
      new NextRequest("http://localhost/api/players"),
      routeContext(["players"]),
    );
    const { players } = await playersResponse.json();
    const byName = Object.fromEntries(
      players.map((player: { displayName: string }) => [
        player.displayName,
        player,
      ]),
    );
    expect(byName["Jewon Yeon"]).toMatchObject({
      leagueAverage: 186,
      usedAverage: 186,
      handicap: 30,
    });
    expect(byName["See Won Kim"]).toMatchObject({
      leagueAverage: 134,
      usedAverage: 134,
    });
    expect(byName["Manual Bernard"]).toMatchObject({
      leagueAverage: 220,
      usedAverage: 155,
    });
    expect(byName["Fixed Anthony"]).toMatchObject({
      leagueAverage: 221,
      usedAverage: 200,
    });
    expect(byName["Kimberly Panelo"].aliases).toContain("Kimberly Panel");
  });
});
