import { describe, expect, it } from "vitest";
import { DEFAULT_MONDAY_ROSTER } from "@/lib/default-roster";
import { closeDb, ensureDefaultRoster, getDb, listPlayers } from "@/lib/db";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("default Monday roster", () => {
  it("seeds the fixed Monday members once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-roster-"));
    process.env.BOWLING_DB_PATH = path.join(dir, "seed.db");
    closeDb();
    getDb();
    const first = listPlayers(true).map((p) => p.displayName).sort();
    expect(first).toEqual([...DEFAULT_MONDAY_ROSTER].sort());
    ensureDefaultRoster();
    expect(listPlayers(true)).toHaveLength(DEFAULT_MONDAY_ROSTER.length);
    closeDb();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may keep a brief lock on the closed SQLite file.
    }
  });
});
