import { afterAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-generator-"));
process.env.BOWLING_DB_PATH = path.join(tempDir, "test.db");
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.LIBSQL_URL;
delete process.env.LIBSQL_AUTH_TOKEN;

afterAll(async () => {
  const { closeDb } = await import("@/lib/db");
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

it.each([
  { average: 125, status: 200 },
  { average: 124, status: 400 },
])(
  "generation API enforces the handicap cap: second average $average returns $status",
  async ({ average, status }) => {
    const { POST } = await import("@/app/api/[...segments]/route");
    const response = await POST(
      new NextRequest("http://localhost/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          players: [180, average].map((usedAverage, index) => ({
            id: String(index + 1),
            name: `Player ${index + 1}`,
            usedAverage,
            averageMode: "AUTO",
            handicap: 0,
            projectedScore: usedAverage,
          })),
          teamCount: 2,
          mode: "BALANCED",
          seed: "api-test",
        }),
      }),
      { params: Promise.resolve({ segments: ["generate"] }) },
    );
    expect(response.status).toBe(status);
    const body = await response.json();
    if (status === 400) expect(body.error).toContain("handicap gap below 50");
    else expect(body.teams).toHaveLength(2);
  },
);
