import Database from "libsql";
import fs from "node:fs";
import path from "node:path";
import {
  calculateHandicap,
  DEFAULT_SETTINGS,
  resolveUsedAverage,
} from "./bowling";
import { DEFAULT_MONDAY_ROSTER } from "./default-roster";
import type { LeagueSettings, Player, SavedLineup } from "./types";

type SqliteDb = InstanceType<typeof Database>;

let database: SqliteDb | null = null;

export function pacificYmd(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  league_name TEXT,
  average_mode TEXT NOT NULL DEFAULT 'MANUAL' CHECK(average_mode IN ('AUTO','MANUAL','FIXED')),
  league_average INTEGER,
  manual_average INTEGER,
  fixed_average INTEGER,
  pdf_handicap INTEGER,
  games INTEGER,
  pins INTEGER,
  team_number INTEGER,
  team_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  last_import_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  alias TEXT NOT NULL COLLATE NOCASE UNIQUE
);
CREATE TABLE IF NOT EXISTS average_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  league_average INTEGER,
  manual_average INTEGER,
  fixed_average INTEGER,
  used_average INTEGER,
  source TEXT NOT NULL,
  import_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_filename TEXT NOT NULL,
  source_blob BLOB,
  league_name TEXT,
  league_date TEXT,
  week_number INTEGER,
  status TEXT NOT NULL DEFAULT 'REVIEW',
  parsed_json TEXT NOT NULL,
  decisions_json TEXT,
  errors_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_date TEXT NOT NULL,
  mode TEXT NOT NULL,
  team_count INTEGER NOT NULL,
  target_team_size INTEGER NOT NULL,
  seed TEXT NOT NULL,
  handicap_settings_json TEXT NOT NULL,
  attendees_json TEXT NOT NULL,
  absent_ids_json TEXT NOT NULL,
  generated_teams_json TEXT NOT NULL,
  final_teams_json TEXT NOT NULL,
  fairness_json TEXT NOT NULL,
  scores_json TEXT,
  results_json TEXT,
  game_count INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS saved_lineup (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  teams_json TEXT NOT NULL,
  saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

type LibsqlOpenOptions = {
  authToken?: string;
  syncUrl?: string;
};

function openDatabase(): SqliteDb {
  const tursoUrl =
    process.env.TURSO_DATABASE_URL?.trim() ||
    process.env.LIBSQL_URL?.trim() ||
    "";
  const authToken =
    process.env.TURSO_AUTH_TOKEN?.trim() ||
    process.env.LIBSQL_AUTH_TOKEN?.trim() ||
    undefined;

  if (tursoUrl) {
    // Direct remote connection (works on Vercel Node runtime).
    const options: LibsqlOpenOptions = { authToken };
    return new Database(tursoUrl, options as never);
  }

  const filename =
    process.env.BOWLING_DB_PATH ??
    path.join(process.cwd(), "data", "bowling.db");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  return new Database(filename);
}

export function getDb(): SqliteDb {
  if (database) return database;
  database = openDatabase();
  try {
    database.pragma("journal_mode = WAL");
  } catch {
    // Remote/replica connections may reject WAL.
  }
  database.exec(SCHEMA);
  migrateSessionColumns(database);
  migrateSessionDates(database);
  migrateScratchMoney(database);
  repairOct5JinsolTicket(database);
  repairOct5GuestIdentity(database);
  const insert = database.prepare(
    "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)",
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS))
    insert.run(key, JSON.stringify(value));
  ensureDefaultRoster(database);
  return database;
}

function migrateSessionColumns(db: SqliteDb): void {
  const columns = (
    db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>
  ).map((column) => column.name);
  const add = (name: string, type: string) => {
    if (!columns.includes(name))
      db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
  };
  add("scores_json", "TEXT");
  add("results_json", "TEXT");
  add("game_count", "INTEGER NOT NULL DEFAULT 3");
  add("game_rosters_json", "TEXT");
  add("game_results_json", "TEXT");
  add("lottery_ids_json", "TEXT");
  add("scratch_winners_json", "TEXT");
  add("last_game_prize_json", "TEXT");
}

function migrateSessionDates(db: SqliteDb): void {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const rows = db
    .prepare("SELECT id, session_date, created_at FROM sessions")
    .all() as Array<{ id: number; session_date: string; created_at: string }>;
  const update = db.prepare(
    "UPDATE sessions SET session_date = ? WHERE id = ?",
  );
  for (const row of rows) {
    const created = new Date(`${row.created_at.replace(" ", "T")}Z`);
    if (Number.isNaN(created.getTime())) continue;
    const systemDate = format.format(created);
    if (systemDate !== row.session_date) update.run(systemDate, row.id);
  }
}

function migrateScratchMoney(db: SqliteDb): void {
  const playerColumns = (
    db.prepare("PRAGMA table_info(players)").all() as Array<{ name: string }>
  ).map((column) => column.name);
  if (!playerColumns.includes("scratch_pool"))
    db.exec(
      "ALTER TABLE players ADD COLUMN scratch_pool INTEGER NOT NULL DEFAULT 0",
    );
  const addingDuesStartMonth = !playerColumns.includes(
    "scratch_dues_start_month",
  );
  if (addingDuesStartMonth)
    db.exec("ALTER TABLE players ADD COLUMN scratch_dues_start_month TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS scratch_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_date TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('dues','ticket','payout','last_game_fee','last_game_ticket')),
      player_id INTEGER,
      player_name TEXT NOT NULL,
      amount INTEGER NOT NULL,
      session_id INTEGER,
      month_key TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS scratch_ledger_dues
      ON scratch_ledger(kind, month_key, player_id) WHERE kind = 'dues';
    CREATE UNIQUE INDEX IF NOT EXISTS scratch_ledger_tickets
      ON scratch_ledger(kind, session_id, player_id) WHERE kind = 'ticket';
    CREATE UNIQUE INDEX IF NOT EXISTS scratch_ledger_last_game_fee
      ON scratch_ledger(kind, session_id) WHERE kind = 'last_game_fee';
    CREATE UNIQUE INDEX IF NOT EXISTS scratch_ledger_last_game_tickets
      ON scratch_ledger(kind, session_id, player_id) WHERE kind = 'last_game_ticket';
  `);
  migrateScratchLedgerKinds(db);
  if (addingDuesStartMonth) {
    // This member joined Sep 29; the old code charged September dues on signup.
    db.exec(`
      UPDATE players SET scratch_dues_start_month = '2026-10'
      WHERE id = 17 AND scratch_pool = 1
        AND EXISTS (
          SELECT 1 FROM scratch_ledger WHERE id = 1691
            AND kind = 'dues' AND player_id = 17 AND amount = 20
            AND month_key = '2026-09' AND created_at = '2026-09-30 00:20:57'
        );
      DELETE FROM scratch_ledger WHERE id = 1691
        AND kind = 'dues' AND player_id = 17 AND amount = 20
        AND month_key = '2026-09' AND created_at = '2026-09-30 00:20:57'
        AND EXISTS (
          SELECT 1 FROM players WHERE id = 17
            AND scratch_dues_start_month = '2026-10'
        );
    `);
  }
}

function repairOct5JinsolTicket(db: SqliteDb): void {
  // Undo the Oct 5 ticket awarded before Jinsol's Oct 9 membership start.
  const player = db
    .prepare(
      "SELECT id, scratch_dues_start_month startMonth FROM players WHERE display_name = 'Jinsol Bae' AND scratch_pool = 1",
    )
    .get() as { id: number; startMonth: string | null } | undefined;
  if (!player) return;
  const sessions = db
    .prepare(
      "SELECT id, lottery_ids_json lotteryIds, scratch_winners_json winners FROM sessions WHERE session_date = '2026-10-05'",
    )
    .all() as Array<{
    id: number;
    lotteryIds: string | null;
    winners: string | null;
  }>;
  for (const session of sessions) {
    let winners: Array<{ playerId: string | number }>;
    let lotteryIds: Array<string | number>;
    try {
      winners = JSON.parse(session.winners ?? "[]");
      lotteryIds = JSON.parse(session.lotteryIds ?? "[]");
      if (!Array.isArray(winners) || !Array.isArray(lotteryIds)) continue;
    } catch {
      continue;
    }
    if (
      !winners.some((winner) => String(winner.playerId) === String(player.id))
    )
      continue;
    if (!player.startMonth || player.startMonth < "2026-10")
      db.prepare(
        "UPDATE players SET scratch_dues_start_month = '2026-10' WHERE id = ?",
      ).run(player.id);
    db.prepare(
      "UPDATE sessions SET lottery_ids_json = ?, scratch_winners_json = ? WHERE id = ?",
    ).run(
      JSON.stringify(
        lotteryIds.filter((id) => String(id) !== String(player.id)),
      ),
      JSON.stringify(
        winners.filter(
          (winner) => String(winner.playerId) !== String(player.id),
        ),
      ),
      session.id,
    );
    db.prepare(
      "DELETE FROM scratch_ledger WHERE kind = 'ticket' AND session_id = ? AND player_id = ?",
    ).run(session.id, player.id);
  }
}

function repairOct5GuestIdentity(db: SqliteDb): void {
  // Attribute the three Oct 5 games to the existing player, keeping the night's 150 average.
  const guest = db
    .prepare("SELECT id FROM players WHERE display_name = 'Temp Guest'")
    .get() as { id: number } | undefined;
  const dongyoung = db
    .prepare("SELECT id FROM players WHERE display_name = 'Dongyoung Park'")
    .get() as { id: number } | undefined;
  if (!guest || !dongyoung) return;
  const oldId = String(guest.id);
  const newId = String(dongyoung.id);
  const columns = [
    "attendees_json",
    "generated_teams_json",
    "final_teams_json",
    "game_rosters_json",
    "game_results_json",
  ] as const;
  const rows = db
    .prepare(
      `SELECT id, scores_json, absent_ids_json, ${columns.join(", ")} FROM sessions WHERE session_date = '2026-10-05'`,
    )
    .all() as Array<Record<string, string | number | null>>;
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace);
    if (!value || typeof value !== "object") return value;
    const result = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, replace(child)]),
    );
    if (String(result.id) === oldId && result.name === "Temp Guest") {
      result.id = typeof result.id === "number" ? dongyoung.id : newId;
      result.name = "Dongyoung Park";
    }
    if (Array.isArray(result.playerIds))
      result.playerIds = result.playerIds.map((id: string | number) =>
        String(id) === oldId ? newId : id,
      );
    return result;
  };
  for (const row of rows) {
    let scores: Record<string, unknown>;
    let absent: Array<string | number>;
    let snapshots: Array<unknown>;
    try {
      scores = JSON.parse(String(row.scores_json ?? "{}"));
      absent = JSON.parse(String(row.absent_ids_json));
      snapshots = columns.map((column) =>
        row[column] == null ? null : JSON.parse(String(row[column])),
      );
      if (!Array.isArray(absent) || !Array.isArray(snapshots[2])) continue;
    } catch {
      continue;
    }
    if (
      JSON.stringify(scores[oldId]) !== "[105,113,135]" ||
      scores[newId] != null
    )
      continue;
    if (!JSON.stringify(snapshots[2]).includes('"name":"Temp Guest"')) continue;
    scores[newId] = scores[oldId];
    delete scores[oldId];
    db.prepare(
      `UPDATE sessions SET scores_json = ?, absent_ids_json = ?, ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`,
    ).run(
      JSON.stringify(scores),
      JSON.stringify(absent.filter((id) => String(id) !== newId)),
      ...snapshots.map((snapshot) =>
        snapshot == null ? null : JSON.stringify(replace(snapshot)),
      ),
      row.id,
    );
  }
}

function migrateScratchLedgerKinds(db: SqliteDb): void {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scratch_ledger'`,
    )
    .get() as { sql: string } | undefined;
  if (!row?.sql || row.sql.includes("'last_game_fee'")) return;
  db.exec(`
    CREATE TABLE scratch_ledger_next (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_date TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('dues','ticket','payout','last_game_fee','last_game_ticket')),
      player_id INTEGER,
      player_name TEXT NOT NULL,
      amount INTEGER NOT NULL,
      session_id INTEGER,
      month_key TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO scratch_ledger_next(
      id, entry_date, kind, player_id, player_name, amount,
      session_id, month_key, note, created_at
    )
    SELECT id, entry_date, kind, player_id, player_name, amount,
           session_id, month_key, note, created_at
    FROM scratch_ledger;
    DROP TABLE scratch_ledger;
    ALTER TABLE scratch_ledger_next RENAME TO scratch_ledger;
    CREATE UNIQUE INDEX IF NOT EXISTS scratch_ledger_dues
      ON scratch_ledger(kind, month_key, player_id) WHERE kind = 'dues';
    CREATE UNIQUE INDEX IF NOT EXISTS scratch_ledger_tickets
      ON scratch_ledger(kind, session_id, player_id) WHERE kind = 'ticket';
    CREATE UNIQUE INDEX IF NOT EXISTS scratch_ledger_last_game_fee
      ON scratch_ledger(kind, session_id) WHERE kind = 'last_game_fee';
    CREATE UNIQUE INDEX IF NOT EXISTS scratch_ledger_last_game_tickets
      ON scratch_ledger(kind, session_id, player_id) WHERE kind = 'last_game_ticket';
  `);
}

export function ensureDefaultRoster(db = getDb()): void {
  const insert = db.prepare(
    `INSERT INTO players(display_name, league_name, average_mode, active)
     SELECT ?, ?, 'AUTO', 1
     WHERE NOT EXISTS (
       SELECT 1 FROM players
       WHERE display_name = ? COLLATE NOCASE
          OR league_name = ? COLLATE NOCASE
     )`,
  );
  for (const name of DEFAULT_MONDAY_ROSTER) insert.run(name, name, name, name);
}

export function closeDb(): void {
  try {
    persistDb();
  } catch {
    // ignore
  }
  database?.close();
  database = null;
}

/** Push/pull embedded replica when using Turso. No-op for local file DB. */
export function persistDb(): void {
  if (!database) return;
  if (!process.env.TURSO_DATABASE_URL && !process.env.LIBSQL_URL) return;
  try {
    const sync = (database as SqliteDb & { sync?: () => void }).sync;
    if (typeof sync === "function") sync.call(database);
  } catch {
    // Local file DBs expose sync() but throw SyncNotSupported.
  }
}

/** The one lineup built ahead of the night (e.g. Sunday), shared by every device. */
export function getSavedLineup(db = getDb()): SavedLineup | null {
  const row = db
    .prepare("SELECT teams_json, saved_at FROM saved_lineup WHERE id = 1")
    .get() as { teams_json: string; saved_at: string } | undefined;
  if (!row) return null;
  return {
    teams: JSON.parse(row.teams_json) as SavedLineup["teams"],
    savedAt: row.saved_at,
  };
}

export function saveLineup(
  teams: SavedLineup["teams"],
  db = getDb(),
): SavedLineup {
  db.prepare(
    `INSERT INTO saved_lineup(id, teams_json, saved_at)
     VALUES (1, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       teams_json = excluded.teams_json,
       saved_at = excluded.saved_at`,
  ).run(JSON.stringify(teams));
  return getSavedLineup(db)!;
}

export function clearSavedLineup(db = getDb()): void {
  db.prepare("DELETE FROM saved_lineup WHERE id = 1").run();
}

export function getSettings(db = getDb()): LeagueSettings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{
    key: string;
    value: string;
  }>;
  return {
    ...DEFAULT_SETTINGS,
    ...Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)])),
  };
}

type PlayerRow = {
  id: number;
  display_name: string;
  league_name: string | null;
  average_mode: Player["averageMode"];
  league_average: number | null;
  manual_average: number | null;
  fixed_average: number | null;
  pdf_handicap: number | null;
  games: number | null;
  pins: number | null;
  team_number: number | null;
  team_name: string | null;
  active: number;
  archived: number;
  notes: string;
  scratch_pool?: number;
  scratch_dues_start_month?: string | null;
  updated_at: string;
};

export function rowToPlayer(
  row: PlayerRow,
  settings = getSettings(),
  db = getDb(),
): Player {
  const usedAverage = resolveUsedAverage({
    averageMode: row.average_mode,
    leagueAverage: row.league_average,
    manualAverage: row.manual_average,
    fixedAverage: row.fixed_average,
  });
  const aliases = (
    db
      .prepare("SELECT alias FROM aliases WHERE player_id = ? ORDER BY alias")
      .all(row.id) as Array<{ alias: string }>
  ).map((a) => a.alias);
  const handicap =
    usedAverage === null ? null : calculateHandicap(usedAverage, settings);
  return {
    id: row.id,
    displayName: row.display_name,
    leagueName: row.league_name,
    aliases,
    averageMode: row.average_mode,
    leagueAverage: row.league_average,
    manualAverage: row.manual_average,
    fixedAverage: row.fixed_average,
    usedAverage,
    handicap,
    projectedHandicapScore:
      usedAverage === null || handicap === null ? null : usedAverage + handicap,
    pdfHandicap: row.pdf_handicap,
    games: row.games,
    pins: row.pins,
    teamNumber: row.team_number,
    teamName: row.team_name,
    active: Boolean(row.active),
    archived: Boolean(row.archived),
    notes: row.notes,
    scratchPool:
      Boolean(row.scratch_pool) &&
      (!row.scratch_dues_start_month ||
        `${row.scratch_dues_start_month}-09` <= pacificYmd()),
    updatedAt: row.updated_at,
  };
}

export function listPlayers(includeArchived = true, db = getDb()): Player[] {
  const rows = db
    .prepare(
      `SELECT * FROM players ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY display_name COLLATE NOCASE`,
    )
    .all() as PlayerRow[];
  const settings = getSettings(db);
  return rows.map((row) => rowToPlayer(row, settings, db));
}

export function addAverageHistory(
  playerId: number,
  source: string,
  importId?: number,
  db = getDb(),
): void {
  const row = db
    .prepare("SELECT * FROM players WHERE id = ?")
    .get(playerId) as PlayerRow;
  const used = resolveUsedAverage({
    averageMode: row.average_mode,
    leagueAverage: row.league_average,
    manualAverage: row.manual_average,
    fixedAverage: row.fixed_average,
  });
  db.prepare(
    `INSERT INTO average_history(player_id, league_average, manual_average, fixed_average, used_average, source, import_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    playerId,
    row.league_average,
    row.manual_average,
    row.fixed_average,
    used,
    source,
    importId ?? null,
  );
}
