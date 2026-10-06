import { getDb, pacificYmd } from "./db";
export { pacificYmd } from "./db";
import {
  LAST_GAME_TICKET_DOLLARS,
  type LastGamePrize,
  type ScratchWinner,
} from "./scoring";
import type {
  ScratchLedgerKind,
  ScratchMoneySnapshot,
  ScratchPoolMember,
} from "./types";

export const SCRATCH_DUES_DOLLARS = 20;
export const SCRATCH_TICKET_DOLLARS = 10;
export const SCRATCH_DUES_DAY = 9;
export const SCRATCH_LEDGER_START_MONTH = "2026-09";

type SqliteDb = ReturnType<typeof getDb>;

export function monthKeyFromYmd(ymd: string): string {
  return ymd.slice(0, 7);
}

export function nextMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  const next = month === 12 ? [year + 1, 1] : [year, month + 1];
  return `${next[0]}-${String(next[1]).padStart(2, "0")}`;
}

export function duesDateForMonth(monthKey: string): string {
  return `${monthKey}-${String(SCRATCH_DUES_DAY).padStart(2, "0")}`;
}

/** Months whose 9th has already arrived (Pacific), from the feature start. */
export function duesMonthKeysDue(
  todayYmd: string,
  startMonth = SCRATCH_LEDGER_START_MONTH,
): string[] {
  const keys: string[] = [];
  let monthKey = startMonth;
  while (monthKey <= monthKeyFromYmd(todayYmd)) {
    if (duesDateForMonth(monthKey) <= todayYmd) keys.push(monthKey);
    monthKey = nextMonthKey(monthKey);
  }
  return keys;
}

export function nextDuesDate(todayYmd: string): string {
  const monthKey = monthKeyFromYmd(todayYmd);
  const thisMonth = duesDateForMonth(monthKey);
  return thisMonth > todayYmd
    ? thisMonth
    : duesDateForMonth(nextMonthKey(monthKey));
}

export function formatScratchMoney(amount: number, signed = false): string {
  const abs = Math.abs(amount);
  const text = `$${abs}`;
  if (amount < 0) return `-${text}`;
  if (signed && amount > 0) return `+${text}`;
  return text;
}

export function withRunningBalances<T extends { amount: number }>(
  oldestFirst: T[],
): Array<T & { balanceAfter: number }> {
  let balance = 0;
  return oldestFirst.map((entry) => {
    balance += entry.amount;
    return { ...entry, balanceAfter: balance };
  });
}

type LedgerRow = {
  id: number;
  entry_date: string;
  kind: ScratchLedgerKind;
  player_id: number | null;
  player_name: string;
  amount: number;
  session_id: number | null;
  month_key: string | null;
  note: string;
};

type PoolMember = ScratchPoolMember & { duesStartMonth: string | null };

function poolMembers(db: SqliteDb, onDate: string): PoolMember[] {
  return (
    db
      .prepare(
        `SELECT id, display_name name, scratch_dues_start_month duesStartMonth FROM players
         WHERE scratch_pool = 1 AND active = 1 AND archived = 0
           AND (scratch_dues_start_month IS NULL OR scratch_dues_start_month || '-09' <= ?)
         ORDER BY display_name COLLATE NOCASE`,
      )
      .all(onDate) as Array<{
      id: number;
      name: string;
      duesStartMonth: string | null;
    }>
  ).map((row) => ({
    id: Number(row.id),
    name: row.name,
    duesStartMonth: row.duesStartMonth,
  }));
}

function insertDues(
  db: SqliteDb,
  member: ScratchPoolMember,
  monthKey: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO scratch_ledger(
      entry_date, kind, player_id, player_name, amount, session_id, month_key, note
    ) VALUES (?, 'dues', ?, ?, ?, NULL, ?, ?)`,
  ).run(
    duesDateForMonth(monthKey),
    member.id,
    member.name,
    SCRATCH_DUES_DOLLARS,
    monthKey,
    `Monthly scratch dues ${monthKey}`,
  );
}

export function recordScratchTickets(
  input: {
    sessionId: number;
    sessionDate: string;
    winners: ScratchWinner[];
  },
  db = getDb(),
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO scratch_ledger(
      entry_date, kind, player_id, player_name, amount, session_id, month_key, note
    ) VALUES (?, 'ticket', ?, ?, ?, ?, NULL, ?)`,
  );
  for (const winner of input.winners) {
    const parsed = Number(winner.playerId);
    const playerId = Number.isFinite(parsed) ? parsed : null;
    insert.run(
      input.sessionDate,
      playerId,
      winner.name,
      -SCRATCH_TICKET_DOLLARS,
      input.sessionId,
      `Scratch ticket · ${winner.wins} win${winner.wins === 1 ? "" : "s"}`,
    );
  }
}

export function recordLastGamePrize(
  input: {
    sessionId: number;
    sessionDate: string;
    prize: LastGamePrize;
  },
  db = getDb(),
): void {
  if (input.prize.contribution <= 0) return;
  db.prepare(
    `INSERT OR IGNORE INTO scratch_ledger(
      entry_date, kind, player_id, player_name, amount, session_id, month_key, note
    ) VALUES (?, 'last_game_fee', NULL, 'Last game side pot', ?, ?, NULL, ?)`,
  ).run(
    input.sessionDate,
    input.prize.contribution,
    input.sessionId,
    `$1 × ${input.prize.participantCount} players · ${formatScratchMoney(input.prize.clubPotAdded)} to club pot`,
  );
  const insertTicket = db.prepare(
    `INSERT OR IGNORE INTO scratch_ledger(
      entry_date, kind, player_id, player_name, amount, session_id, month_key, note
    ) VALUES (?, 'last_game_ticket', ?, ?, ?, ?, NULL, ?)`,
  );
  for (const winner of input.prize.winners) {
    const parsed = Number(winner.playerId);
    insertTicket.run(
      input.sessionDate,
      Number.isFinite(parsed) ? parsed : null,
      winner.name,
      -LAST_GAME_TICKET_DOLLARS,
      input.sessionId,
      `Last game prize · ${winner.score} (${winner.improvement >= 0 ? "+" : ""}${winner.improvement} vs avg)`,
    );
  }
}

function backfillSessionTickets(db: SqliteDb): void {
  const rows = db
    .prepare(
      `SELECT id, session_date sessionDate, scratch_winners_json winnersJson
       FROM sessions
       WHERE scratch_winners_json IS NOT NULL AND scratch_winners_json != ''`,
    )
    .all() as Array<{ id: number; sessionDate: string; winnersJson: string }>;
  for (const row of rows) {
    let winners: ScratchWinner[] = [];
    try {
      const parsed = JSON.parse(row.winnersJson);
      winners = Array.isArray(parsed) ? parsed : [];
    } catch {
      continue;
    }
    recordScratchTickets(
      {
        sessionId: row.id,
        sessionDate: row.sessionDate,
        winners,
      },
      db,
    );
  }
}

export function syncScratchMoney(now = new Date(), db = getDb()): void {
  backfillSessionTickets(db);
  const today = pacificYmd(now);
  const members = poolMembers(db, today);
  for (const member of members) {
    for (const monthKey of duesMonthKeysDue(
      today,
      member.duesStartMonth ?? SCRATCH_LEDGER_START_MONTH,
    )) {
      insertDues(db, member, monthKey);
    }
  }
}

export function removeScratchTicketsForSession(
  sessionId: number,
  db = getDb(),
): void {
  const session = db
    .prepare(
      `SELECT session_date sessionDate, scratch_winners_json winnersJson
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as
    { sessionDate: string; winnersJson: string | null } | undefined;
  db.prepare("DELETE FROM scratch_ledger WHERE session_id = ?").run(sessionId);
  if (!session) return;
  let winners: ScratchWinner[] = [];
  try {
    const parsed = session.winnersJson ? JSON.parse(session.winnersJson) : [];
    winners = Array.isArray(parsed) ? parsed : [];
  } catch {
    winners = [];
  }
  const del = db.prepare(
    `DELETE FROM scratch_ledger
     WHERE kind = 'ticket' AND entry_date = ?
       AND (player_id = ? OR player_name = ?)`,
  );
  for (const winner of winners) {
    const parsed = Number(winner.playerId);
    const playerId = Number.isFinite(parsed) ? parsed : null;
    del.run(session.sessionDate, playerId, winner.name);
  }
}

const LEDGER_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isLedgerDate(value: string): boolean {
  if (!LEDGER_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function recordScratchPayouts(
  input: {
    date: string;
    amount: number;
    playerIds: number[];
    note?: string;
  },
  db = getDb(),
): ScratchMoneySnapshot {
  if (!isLedgerDate(input.date)) throw new Error("Pick a valid date.");
  const amount = Math.round(Number(input.amount));
  if (!Number.isFinite(amount) || amount < 1 || amount > 9999)
    throw new Error("Amount must be $1–$9999.");
  const ids = [
    ...new Set(
      input.playerIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  ];
  if (!ids.length) throw new Error("Check who received the money.");
  const note = (input.note ?? "").trim().slice(0, 120);
  const insert = db.prepare(
    `INSERT INTO scratch_ledger(
      entry_date, kind, player_id, player_name, amount, session_id, month_key, note
    ) VALUES (?, 'payout', ?, ?, ?, NULL, NULL, ?)`,
  );
  for (const id of ids) {
    const player = db
      .prepare("SELECT id, display_name name FROM players WHERE id = ?")
      .get(id) as { id: number; name: string } | undefined;
    if (!player) throw new Error("Player not found");
    insert.run(
      input.date,
      player.id,
      player.name,
      -amount,
      note || `Paid out ${formatScratchMoney(amount)}`,
    );
  }
  return getScratchMoney(new Date(), db);
}

export function deleteScratchPayout(
  id: number,
  db = getDb(),
): ScratchMoneySnapshot {
  const row = db
    .prepare("SELECT id, kind FROM scratch_ledger WHERE id = ?")
    .get(id) as { id: number; kind: string } | undefined;
  if (!row) throw new Error("Entry not found");
  if (row.kind !== "payout")
    throw new Error("Only manual payouts can be removed.");
  db.prepare("DELETE FROM scratch_ledger WHERE id = ?").run(id);
  return getScratchMoney(new Date(), db);
}

export function setScratchPoolMember(
  playerId: number,
  inPool: boolean,
  db = getDb(),
): void {
  const player = db
    .prepare("SELECT id, scratch_pool inPool FROM players WHERE id = ?")
    .get(playerId) as { id: number; inPool: number } | undefined;
  if (!player) throw new Error("Player not found");
  if (Boolean(player.inPool) === inPool) return;
  db.prepare(
    "UPDATE players SET scratch_pool = ?, scratch_dues_start_month = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(
    inPool ? 1 : 0,
    inPool ? nextDuesDate(pacificYmd()).slice(0, 7) : null,
    playerId,
  );
}

export function getScratchMoney(
  now = new Date(),
  db = getDb(),
): ScratchMoneySnapshot {
  syncScratchMoney(now, db);
  const today = pacificYmd(now);
  const members = poolMembers(db, today);
  const nextMembers = poolMembers(db, nextDuesDate(today));
  const rows = db
    .prepare(
      `SELECT id, entry_date, kind, player_id, player_name, amount, session_id, month_key, note
       FROM scratch_ledger
       ORDER BY entry_date ASC, id ASC`,
    )
    .all() as LedgerRow[];
  const withBalance = withRunningBalances(
    rows.map((row) => ({
      id: row.id,
      date: row.entry_date,
      kind: row.kind,
      playerId: row.player_id,
      playerName: row.player_name,
      amount: row.amount,
      sessionId: row.session_id,
      monthKey: row.month_key,
      note: row.note,
    })),
  );
  const balance = withBalance.at(-1)?.balanceAfter ?? 0;
  return {
    balance,
    duesAmount: SCRATCH_DUES_DOLLARS,
    ticketAmount: SCRATCH_TICKET_DOLLARS,
    duesDay: SCRATCH_DUES_DAY,
    today,
    nextDuesDate: nextDuesDate(today),
    nextDuesCount: nextMembers.length,
    nextDuesTotal: nextMembers.length * SCRATCH_DUES_DOLLARS,
    members: members.map(({ id, name }) => ({ id, name })),
    entries: [...withBalance].reverse(),
  };
}
