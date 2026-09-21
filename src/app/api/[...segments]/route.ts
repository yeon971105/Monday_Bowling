import { NextRequest, NextResponse } from "next/server";
import pdf from "pdf-parse";
import {
  addAverageHistory,
  clearSavedLineup,
  getDb,
  getSavedLineup,
  getSettings,
  listPlayers,
  persistDb,
  rowToPlayer,
  saveLineup,
} from "@/lib/db";
import { assertSettings, normalizeName, validateAverage } from "@/lib/bowling";
import { buildRepeatPairs, generateTeams } from "@/lib/generator";
import {
  applyImportDecisions,
  buildReview,
  defaultDecisionsForReview,
  type ImportDecision,
  type ImportReview,
} from "@/lib/import-review";
import {
  DEFAULT_LEAGUE_REPORT_URL,
  downloadLeagueSheet,
  fetchLeagueReportSheets,
  pickLatestSheet,
} from "@/lib/league-sync";
import { parseLineupInput } from "@/lib/lineup";
import { parseBlsText } from "@/lib/pdf-parser";
import {
  buildStoredGameResults,
  computeLastGamePrize,
  computeScratchWinners,
  computeSeriesResults,
  GAMES_PER_SESSION,
  LAST_GAME_INDEX,
  toSessionTeamResults,
  type MoneyTeam,
  type TeamForScoring,
} from "@/lib/scoring";
import {
  computePlayerStats,
  parseSessionResults,
  parseSessionScores,
  refreshManualAveragesFromHistory,
} from "@/lib/stats";
import {
  deleteScratchPayout,
  getScratchMoney,
  pacificYmd,
  recordLastGamePrize,
  recordScratchPayouts,
  recordScratchTickets,
  removeScratchTicketsForSession,
  setScratchPoolMember,
} from "@/lib/money";
import type { AverageMode, ParsedLeaguePdf } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ segments: string[] }> };
const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status });
const fail = (error: unknown, status = 400) =>
  json(
    { error: error instanceof Error ? error.message : String(error) },
    status,
  );

function getLeagueReportUrl(db = getDb()): string {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get("leagueReportUrl") as { value: string } | undefined;
  if (!row) return DEFAULT_LEAGUE_REPORT_URL;
  try {
    const value = JSON.parse(row.value);
    return typeof value === "string" && value.trim()
      ? value.trim()
      : DEFAULT_LEAGUE_REPORT_URL;
  } catch {
    return DEFAULT_LEAGUE_REPORT_URL;
  }
}

function storeImport(
  filename: string,
  buffer: Buffer,
  parsed: ParsedLeaguePdf,
  review: ImportReview,
) {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO imports(source_filename, source_blob, league_name, league_date, week_number, parsed_json, errors_json) VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      filename,
      buffer,
      parsed.leagueName,
      parsed.leagueDate,
      parsed.weekNumber,
      JSON.stringify(review),
      JSON.stringify(parsed.errors),
    );
  return Number(result.lastInsertRowid);
}

function summarizeSync(
  review: ImportReview,
  applied: { updated: number; created: number; protectedUsedAverage: number },
  meta: {
    skipped: boolean;
    reason: string | null;
    importId: number;
    filename: string;
    weekNumber: number | null;
    leagueDate: string | null;
  },
  history: { updated: number; unlocked: number } = { updated: 0, unlocked: 0 },
) {
  const matched = review.reviewRows
    .filter((row) => row.category === "EXACT" || row.category === "ALIAS")
    .map((row) => ({
      playerId: row.playerId,
      displayName: row.playerName ?? row.printedName,
      printedName: row.printedName,
      oldAverage: row.oldAverage,
      currentAverage: row.currentAverage,
      changed: row.changed,
      usedAverageProtected: row.usedAverageProtected,
    }));
  return {
    ok: true as const,
    ...meta,
    ...applied,
    historyAveragesUpdated: history.updated,
    historyUnlocked: history.unlocked,
    matched,
    notFound: review.existingNotFound,
    leagueAvailable: review.reviewRows
      .filter((row) => row.category === "NEW")
      .map((row) => ({
        printedName: row.printedName,
        currentAverage: row.currentAverage,
        teamName: row.teamName,
      })),
  };
}

async function syncLeagueFromReport() {
  const db = getDb();
  const reportUrl = getLeagueReportUrl(db);
  const sheets = await fetchLeagueReportSheets(reportUrl);
  const sheet = pickLatestSheet(sheets);
  if (!sheet)
    throw new Error("No league sheet PDFs were found on the report page");

  const existing = db
    .prepare(
      "SELECT id, status, week_number weekNumber FROM imports WHERE source_filename = ? ORDER BY id DESC LIMIT 1",
    )
    .get(sheet.filename) as
    { id: number; status: string; weekNumber: number | null } | undefined;

  if (existing?.status === "APPLIED") {
    const stored = JSON.parse(
      (
        db
          .prepare("SELECT parsed_json FROM imports WHERE id=?")
          .get(existing.id) as { parsed_json: string }
      ).parsed_json,
    ) as ImportReview;
    const parsed = {
      leagueName: stored.leagueName,
      bowlingCenter: stored.bowlingCenter,
      leagueDate: stored.leagueDate,
      weekNumber: stored.weekNumber,
      players: stored.players,
      errors: stored.errors ?? [],
    };
    const review = buildReview(parsed);
    const applied = applyImportDecisions(
      existing.id,
      defaultDecisionsForReview(review),
      review,
    );
    const after = buildReview(parsed);
    const history = refreshManualAveragesFromHistory(db);
    return summarizeSync(
      after,
      applied,
      {
        skipped:
          applied.updated === 0 &&
          applied.created === 0 &&
          history.updated === 0,
        reason:
          applied.updated === 0 && history.updated === 0
            ? "already_applied"
            : null,
        importId: existing.id,
        filename: sheet.filename,
        weekNumber: existing.weekNumber ?? sheet.weekNumber,
        leagueDate: stored.leagueDate ?? sheet.dateLabel,
      },
      history,
    );
  }

  const buffer = await downloadLeagueSheet(sheet);
  let parsed: ParsedLeaguePdf;
  try {
    parsed = parseBlsText((await pdf(buffer)).text);
  } catch (error) {
    throw new Error(
      `The PDF could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const review = buildReview(parsed);
  const importId =
    existing?.status === "REVIEW"
      ? existing.id
      : storeImport(sheet.filename, buffer, parsed, review);

  if (existing?.status === "REVIEW") {
    db.prepare(
      "UPDATE imports SET source_blob=?, league_name=?, league_date=?, week_number=?, parsed_json=?, errors_json=?, status='REVIEW', decisions_json=NULL, applied_at=NULL WHERE id=?",
    ).run(
      buffer,
      parsed.leagueName,
      parsed.leagueDate,
      parsed.weekNumber,
      JSON.stringify(review),
      JSON.stringify(parsed.errors),
      importId,
    );
  }

  const autoDecisions = defaultDecisionsForReview(review);
  const applied = applyImportDecisions(importId, autoDecisions, review);
  const after = buildReview(parsed);
  const history = refreshManualAveragesFromHistory(db);
  return summarizeSync(
    after,
    applied,
    {
      skipped: false,
      reason: null,
      importId,
      filename: sheet.filename,
      weekNumber: parsed.weekNumber ?? sheet.weekNumber,
      leagueDate: parsed.leagueDate ?? sheet.dateLabel,
    },
    history,
  );
}

function dashboard() {
  const db = getDb();
  const activePlayers = (
    db
      .prepare(
        "SELECT COUNT(*) count FROM players WHERE active=1 AND archived=0",
      )
      .get() as { count: number }
  ).count;
  const lastImport =
    db
      .prepare(
        "SELECT id, source_filename sourceFilename, league_date leagueDate, week_number weekNumber, status, created_at createdAt FROM imports ORDER BY id DESC LIMIT 1",
      )
      .get() ?? null;
  const lastSession =
    db
      .prepare(
        "SELECT id, session_date sessionDate, seed, created_at createdAt FROM sessions ORDER BY session_date DESC, id DESC LIMIT 1",
      )
      .get() ?? null;
  const changed = db
    .prepare(
      "SELECT COUNT(*) count FROM average_history WHERE source='PDF_IMPORT' AND created_at >= datetime('now','-14 days')",
    )
    .get() as { count: number };
  return {
    activePlayers,
    lastImport,
    lastSession,
    recentAverageChanges: changed.count,
  };
}

export async function GET(_request: NextRequest, context: Context) {
  try {
    const s = (await context.params).segments;
    const db = getDb();
    if (s[0] === "lineup" && s.length === 1) {
      return json({ lineup: getSavedLineup(db) });
    }
    if (s[0] === "league" && s[1] === "available") {
      const record = db
        .prepare(
          "SELECT id, parsed_json, week_number weekNumber, league_date leagueDate FROM imports WHERE status='APPLIED' ORDER BY id DESC LIMIT 1",
        )
        .get() as
        | {
            id: number;
            parsed_json: string;
            weekNumber: number | null;
            leagueDate: string | null;
          }
        | undefined;
      if (!record)
        return json({
          weekNumber: null,
          leagueDate: null,
          players: [] as Array<{
            printedName: string;
            currentAverage: number | null;
            teamName: string | null;
          }>,
        });
      const stored = JSON.parse(record.parsed_json) as ImportReview;
      const review = buildReview({
        leagueName: stored.leagueName,
        bowlingCenter: stored.bowlingCenter,
        leagueDate: stored.leagueDate,
        weekNumber: stored.weekNumber,
        players: stored.players,
        errors: stored.errors ?? [],
      });
      return json({
        importId: record.id,
        weekNumber: record.weekNumber,
        leagueDate: record.leagueDate,
        players: review.reviewRows
          .filter((row) => row.category === "NEW")
          .map((row) => ({
            printedName: row.printedName,
            currentAverage: row.currentAverage,
            teamName: row.teamName,
          })),
      });
    }
    if (s[0] === "dashboard") return json(dashboard());
    if (s[0] === "players" && s.length === 1)
      return json({ players: listPlayers(true), settings: getSettings() });
    if (s[0] === "players" && s[2] === "history") {
      const id = Number(s[1]);
      const averages = db
        .prepare(
          "SELECT * FROM average_history WHERE player_id=? ORDER BY id DESC",
        )
        .all(id);
      const sessions = db
        .prepare(
          "SELECT id, session_date sessionDate, final_teams_json finalTeams FROM sessions ORDER BY session_date DESC",
        )
        .all() as Array<{
        id: number;
        sessionDate: string;
        finalTeams: string;
      }>;
      const teammates: Array<{
        sessionId: number;
        sessionDate: string;
        teammate: string;
      }> = [];
      for (const session of sessions)
        for (const team of JSON.parse(session.finalTeams))
          if (team.players.some((p: { id: string }) => p.id === String(id)))
            for (const p of team.players)
              if (p.id !== String(id))
                teammates.push({
                  sessionId: session.id,
                  sessionDate: session.sessionDate,
                  teammate: p.name,
                });
      return json({ averages, teammates });
    }
    if (s[0] === "settings") return json(getSettings());
    if (s[0] === "imports") {
      if (s.length === 1)
        return json(
          db
            .prepare(
              "SELECT id, source_filename sourceFilename, league_name leagueName, league_date leagueDate, week_number weekNumber, status, errors_json errors, created_at createdAt, applied_at appliedAt FROM imports ORDER BY id DESC",
            )
            .all(),
        );
      const record = db
        .prepare("SELECT * FROM imports WHERE id=?")
        .get(Number(s[1])) as Record<string, unknown> | undefined;
      if (!record) return fail("Import not found", 404);
      return json({
        ...record,
        parsed: JSON.parse(record.parsed_json as string),
        decisions: record.decisions_json
          ? JSON.parse(record.decisions_json as string)
          : null,
        errors: JSON.parse(record.errors_json as string),
      });
    }
    if (s[0] === "stats") return json({ players: computePlayerStats() });
    if (s[0] === "sessions") {
      if (s.length === 1)
        return json(
          db
            .prepare(
              `SELECT id, session_date sessionDate, mode, team_count teamCount,
                seed, fairness_json fairness, final_teams_json finalTeams,
                attendees_json attendees, scores_json scores, results_json results,
                game_rosters_json gameRosters, game_results_json gameResults,
                lottery_ids_json lotteryIds, scratch_winners_json scratchWinners,
                last_game_prize_json lastGamePrize,
                game_count gameCount, created_at createdAt
               FROM sessions ORDER BY session_date DESC, id DESC`,
            )
            .all()
            .map((r: any) => ({
              id: r.id,
              sessionDate: r.sessionDate,
              mode: r.mode,
              teamCount: r.teamCount,
              seed: r.seed,
              fairness: JSON.parse(r.fairness),
              finalTeams: JSON.parse(r.finalTeams),
              attendees: JSON.parse(r.attendees),
              scores: parseSessionScores(r.scores),
              results: parseSessionResults(r.results),
              gameRosters: r.gameRosters ? JSON.parse(r.gameRosters) : null,
              gameResults: r.gameResults ? JSON.parse(r.gameResults) : null,
              lotteryIds: r.lotteryIds ? JSON.parse(r.lotteryIds) : [],
              scratchWinners: r.scratchWinners
                ? JSON.parse(r.scratchWinners)
                : [],
              lastGamePrize: r.lastGamePrize
                ? JSON.parse(r.lastGamePrize)
                : null,
              gameCount: r.gameCount ?? GAMES_PER_SESSION,
              createdAt: r.createdAt,
            })),
        );
      const record = db
        .prepare("SELECT * FROM sessions WHERE id=?")
        .get(Number(s[1])) as Record<string, unknown> | undefined;
      if (!record) return fail("Session not found", 404);
      return json(
        Object.fromEntries(
          Object.entries(record).map(([key, value]) => [
            key,
            key.endsWith("_json") && typeof value === "string"
              ? JSON.parse(value)
              : value,
          ]),
        ),
      );
    }
    if (s[0] === "money") return json(getScratchMoney());
    if (s[0] === "backup") {
      const tables = [
        "settings",
        "players",
        "aliases",
        "average_history",
        "imports",
        "sessions",
        "scratch_ledger",
      ];
      const data = Object.fromEntries(
        tables.map((table) => [
          table,
          db.prepare(`SELECT * FROM ${table}`).all(),
        ]),
      );
      return new NextResponse(
        JSON.stringify(
          {
            format: "monday-bowling-backup",
            version: 1,
            exportedAt: new Date().toISOString(),
            data,
          },
          null,
          2,
        ),
        {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="monday-bowling-backup-${new Date().toISOString().slice(0, 10)}.json"`,
          },
        },
      );
    }
    return fail("Not found", 404);
  } catch (error) {
    return fail(error, 500);
  }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const s = (await context.params).segments;
    const db = getDb();
    if (s[0] === "players" && s.length === 1) {
      const body = await request.json();
      const displayName = String(body.displayName ?? "").trim();
      if (!displayName) throw new Error("Player name is required");
      const mode = (body.averageMode ?? "MANUAL") as AverageMode;
      const league = validateAverage(body.leagueAverage);
      const manual = validateAverage(body.manualAverage);
      const fixed = validateAverage(body.fixedAverage);
      if (mode === "MANUAL" && manual === null)
        throw new Error("MANUAL players need a manual average");
      if (mode === "FIXED" && fixed === null)
        throw new Error("FIXED players need a locked average");
      if (
        mode === "AUTO" &&
        league === null &&
        !String(body.leagueName ?? "").trim()
      )
        throw new Error(
          "AUTO players need a league average, or a PDF/league name so Sync can fill it",
        );
      const result = db
        .prepare(
          `INSERT INTO players(display_name, league_name, average_mode, league_average, manual_average, fixed_average, active, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          displayName,
          body.leagueName?.trim() || null,
          mode,
          league,
          manual,
          fixed,
          body.active === false ? 0 : 1,
          String(body.notes ?? ""),
        );
      const id = Number(result.lastInsertRowid);
      for (const alias of body.aliases ?? [])
        if (String(alias).trim())
          db.prepare(
            "INSERT OR IGNORE INTO aliases(player_id,alias) VALUES (?,?)",
          ).run(id, String(alias).trim());
      addAverageHistory(id, "MANUAL_EDIT");
      const player = listPlayers(true).find((p) => p.id === id);
      return json(player, 201);
    }
    if (s[0] === "players" && s[1] === "from-league") {
      const body = await request.json();
      const printedName = String(body.printedName ?? "").trim();
      if (!printedName) throw new Error("Choose a league name");
      const record = db
        .prepare(
          "SELECT id, parsed_json FROM imports WHERE status='APPLIED' ORDER BY id DESC LIMIT 1",
        )
        .get() as { id: number; parsed_json: string } | undefined;
      if (!record)
        throw new Error(
          "Sync a league sheet first, then add from the league list",
        );
      const stored = JSON.parse(record.parsed_json) as ImportReview;
      const row = (stored.players ?? []).find(
        (player) =>
          normalizeName(player.printedName) === normalizeName(printedName),
      );
      if (!row)
        throw new Error(
          `${printedName} was not found on the last synced sheet`,
        );
      if (row.currentAverage === null)
        throw new Error(`${printedName} has no average on the league sheet`);
      const existing = listPlayers(true).find(
        (player) =>
          normalizeName(player.displayName) === normalizeName(printedName) ||
          normalizeName(player.leagueName ?? "") ===
            normalizeName(printedName) ||
          player.aliases.some(
            (alias) => normalizeName(alias) === normalizeName(printedName),
          ),
      );
      if (existing)
        throw new Error(
          `${existing.displayName} is already on the Monday roster`,
        );
      const created = db
        .prepare(
          `INSERT INTO players(display_name, league_name, average_mode, league_average, pdf_handicap, games, pins, team_number, team_name, last_import_id) VALUES (?,?, 'AUTO', ?,?,?,?,?,?,?)`,
        )
        .run(
          row.printedName,
          row.printedName,
          row.currentAverage,
          row.pdfHandicap,
          row.games,
          row.pins,
          row.teamNumber,
          row.teamName,
          record.id,
        );
      const id = Number(created.lastInsertRowid);
      addAverageHistory(id, "PDF_IMPORT", record.id, db);
      return json(
        listPlayers(true).find((player) => player.id === id),
        201,
      );
    }
    if (s[0] === "settings") {
      const body = assertSettings(await request.json());
      const stmt = db.prepare(
        "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      );
      for (const [key, value] of Object.entries(body))
        stmt.run(key, JSON.stringify(value));
      return json(body);
    }
    if (s[0] === "sync" && s[1] === "league") {
      return json(await syncLeagueFromReport());
    }
    if (s[0] === "imports" && s.length === 1) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("Choose a PDF file");
      if (!file.name.toLowerCase().endsWith(".pdf"))
        throw new Error("Only PDF files are supported");
      const buffer = Buffer.from(await file.arrayBuffer());
      let parsed: ParsedLeaguePdf;
      try {
        parsed = parseBlsText((await pdf(buffer)).text);
      } catch (error) {
        throw new Error(
          `The PDF could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const review = buildReview(parsed);
      const id = storeImport(file.name, buffer, parsed, review);
      return json({ id, ...review }, 201);
    }
    if (s[0] === "imports" && s[2] === "refresh") {
      const record = db
        .prepare("SELECT * FROM imports WHERE id=?")
        .get(Number(s[1])) as any;
      if (!record?.source_blob)
        throw new Error("Original PDF data is unavailable");
      const parsed = parseBlsText(
        (await pdf(record.source_blob as Buffer)).text,
      );
      const review = buildReview(parsed);
      db.prepare(
        "UPDATE imports SET parsed_json=?, errors_json=?, status='REVIEW', decisions_json=NULL, applied_at=NULL WHERE id=?",
      ).run(
        JSON.stringify(review),
        JSON.stringify(parsed.errors),
        Number(s[1]),
      );
      return json({ id: Number(s[1]), ...review });
    }
    if (s[0] === "imports" && s[2] === "apply") {
      const id = Number(s[1]);
      const body = await request.json();
      const record = db
        .prepare("SELECT * FROM imports WHERE id=?")
        .get(id) as any;
      if (!record) return fail("Import not found", 404);
      const stored = JSON.parse(record.parsed_json) as ImportReview;
      const review = buildReview({
        leagueName: stored.leagueName,
        bowlingCenter: stored.bowlingCenter,
        leagueDate: stored.leagueDate,
        weekNumber: stored.weekNumber,
        players: stored.players,
        errors: stored.errors ?? [],
      });
      const decisions = body.decisions as ImportDecision[];
      const applied = applyImportDecisions(id, decisions, review);
      db.prepare("UPDATE imports SET parsed_json=? WHERE id=?").run(
        JSON.stringify(review),
        id,
      );
      return json({ ok: true, ...applied, players: listPlayers(true) });
    }
    if (s[0] === "generate") {
      const body = await request.json();
      const teamCount = Number(body.teamCount);
      if (teamCount < 2 || teamCount > 6)
        throw new Error("Choose 2 to 6 teams");
      const settings = getSettings();
      const recent = db
        .prepare(
          "SELECT final_teams_json finalTeams FROM sessions ORDER BY session_date DESC, id DESC LIMIT ?",
        )
        .all(settings.repeatWindow) as Array<{ finalTeams: string }>;
      const repeatPairs = buildRepeatPairs(
        recent.map((r) => ({ teams: JSON.parse(r.finalTeams) })),
      );
      return json(
        generateTeams({
          ...body,
          teamCount,
          mode: body.mode === "RANDOM" ? "RANDOM" : "BALANCED",
          targetTeamSize: body.targetTeamSize ?? settings.targetTeamSize,
          repeatPairs,
        }),
      );
    }
    if (s[0] === "sessions") {
      const body = await request.json();
      if (!Array.isArray(body.teams) || body.teams.length < 2)
        throw new Error("Generated teams are required");
      const sessionDate = pacificYmd();
      const activeIds = (
        db
          .prepare("SELECT id FROM players WHERE active=1 AND archived=0")
          .all() as Array<{ id: number }>
      ).map((r) => r.id);
      const attendeeIds = body.attendees
        .filter((p: any) => !p.guest)
        .map((p: any) => Number(p.id));
      const absent = activeIds.filter((id) => !attendeeIds.includes(id));
      const gameCount = Number(body.gameCount ?? GAMES_PER_SESSION);
      const lastGameTeams =
        gameCount >= GAMES_PER_SESSION
          ? (body.gameRosters?.[LAST_GAME_INDEX] ?? body.teams)
          : [];
      const lastGamePrize = computeLastGamePrize({
        players: lastGameTeams.flatMap((team: any) => team.players ?? []),
        scores: body.scores ?? {},
      });
      const result = db
        .prepare(
          `INSERT INTO sessions(
            session_date,mode,team_count,target_team_size,seed,
            handicap_settings_json,attendees_json,absent_ids_json,
            generated_teams_json,final_teams_json,fairness_json,
            scores_json,results_json,game_rosters_json,game_results_json,
            lottery_ids_json,scratch_winners_json,last_game_prize_json,game_count
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          sessionDate,
          body.mode,
          body.teams.length,
          body.targetTeamSize ?? 3,
          body.seed,
          JSON.stringify(getSettings()),
          JSON.stringify(body.attendees),
          JSON.stringify(absent),
          JSON.stringify(body.generatedTeams ?? body.teams),
          JSON.stringify(body.teams),
          JSON.stringify(body.fairness ?? {}),
          JSON.stringify(body.scores ?? {}),
          JSON.stringify(body.results ?? []),
          JSON.stringify(body.gameRosters ?? null),
          JSON.stringify(body.gameResults ?? null),
          JSON.stringify(body.lotteryIds ?? []),
          JSON.stringify(body.scratchWinners ?? []),
          JSON.stringify(lastGamePrize),
          gameCount,
        );
      const sessionId = Number(result.lastInsertRowid);
      recordScratchTickets({
        sessionId,
        sessionDate,
        winners: body.scratchWinners ?? [],
      });
      recordLastGamePrize({ sessionId, sessionDate, prize: lastGamePrize });
      const manualUpdated = refreshManualAveragesFromHistory(db);
      clearSavedLineup(db);
      return json(
        {
          id: sessionId,
          sessionDate,
          lastGamePrize,
          manualAveragesUpdated: manualUpdated.updated,
          historyUnlocked: manualUpdated.unlocked,
        },
        201,
      );
    }
    if (s[0] === "money" && s[1] === "members") {
      const body = await request.json();
      const playerId = Number(body.playerId);
      if (!Number.isFinite(playerId)) throw new Error("Player is required");
      setScratchPoolMember(playerId, Boolean(body.inPool));
      return json(getScratchMoney());
    }
    if (s[0] === "money" && s[1] === "payouts") {
      const body = await request.json();
      return json(
        recordScratchPayouts({
          date: String(body.date ?? ""),
          amount: Number(body.amount),
          playerIds: Array.isArray(body.playerIds) ? body.playerIds : [],
          note: typeof body.note === "string" ? body.note : "",
        }),
      );
    }
    if (s[0] === "backup" && s[1] === "restore") {
      const backup = await request.json();
      if (
        backup?.format !== "monday-bowling-backup" ||
        backup?.version !== 1 ||
        !backup?.data?.players ||
        !backup?.data?.settings
      )
        throw new Error("This is not a valid Dopamine Bowling backup");
      const tables = [
        "settings",
        "players",
        "aliases",
        "average_history",
        "imports",
        "sessions",
        "scratch_ledger",
      ];
      for (const table of [...tables].reverse())
        db.prepare(`DELETE FROM ${table}`).run();
      for (const table of tables)
        for (const row of backup.data[table] ?? []) {
          const keys = Object.keys(row);
          const placeholders = keys.map(() => "?").join(",");
          const values = keys.map((key) => {
            const value = row[key];
            if (
              key.endsWith("_json") &&
              value !== null &&
              typeof value !== "string"
            )
              return JSON.stringify(value);
            if (
              key === "source_blob" &&
              value?.type === "Buffer" &&
              Array.isArray(value.data)
            )
              return Buffer.from(value.data);
            return value;
          });
          db.prepare(
            `INSERT INTO ${table}(${keys.join(",")}) VALUES (${placeholders})`,
          ).run(...values);
        }
      return json({ ok: true });
    }
    return fail("Not found", 404);
  } catch (error) {
    return fail(error);
  } finally {
    persistDb();
  }
}

export async function PUT(request: NextRequest, context: Context) {
  try {
    const s = (await context.params).segments;
    const db = getDb();
    if (s[0] === "lineup" && s.length === 1) {
      const teams = parseLineupInput(await request.json());
      return json({ lineup: saveLineup(teams, db) });
    }
    if (s[0] === "sessions" && s[1]) {
      const id = Number(s[1]);
      const existing = db
        .prepare("SELECT * FROM sessions WHERE id=?")
        .get(id) as any;
      if (!existing) return fail("Session not found", 404);
      const body = await request.json();
      const sessionDate = existing.session_date;
      const scores = body.scores ?? parseSessionScores(existing.scores_json);
      const teams = JSON.parse(existing.final_teams_json) as Array<{
        name: string;
        players: Array<{ id: string; name: string; usedAverage: number }>;
      }>;
      const scoringTeams: TeamForScoring[] = teams.map((team) => ({
        name: team.name,
        playerIds: team.players.map((player) => player.id),
        averageSum: team.players.reduce(
          (sum, player) => sum + (player.usedAverage ?? 0),
          0,
        ),
      }));
      const series = computeSeriesResults({
        teams: scoringTeams,
        scores,
        gameCount: existing.game_count ?? GAMES_PER_SESSION,
      });
      const results = toSessionTeamResults(series);
      const storedRosters = existing.game_rosters_json
        ? (JSON.parse(existing.game_rosters_json) as Array<Array<{
            name: string;
            players: Array<{ id: string; name: string; usedAverage: number }>;
          }> | null>)
        : [];
      const fallbackRosters = Array.from(
        { length: existing.game_count ?? GAMES_PER_SESSION },
        () => teams,
      );
      const rosters = storedRosters.length ? storedRosters : fallbackRosters;
      const moneyTeamsByGame: Array<MoneyTeam[] | null> = rosters.map((rows) =>
        rows
          ? rows.map((team) => ({
              name: team.name,
              averageSum: team.players.reduce(
                (sum, player) => sum + (player.usedAverage ?? 0),
                0,
              ),
              players: team.players.map((player) => ({
                id: String(player.id),
                name: player.name,
              })),
            }))
          : null,
      );
      const gameResults = buildStoredGameResults({
        teamsByGame: moneyTeamsByGame,
        scores,
        gameCount: existing.game_count ?? GAMES_PER_SESSION,
      });
      const nightPlayers = Array.from(
        new Map(
          rosters.flatMap((rows) =>
            (rows ?? []).flatMap((team) =>
              team.players.map((player) => [
                String(player.id),
                { id: String(player.id), name: player.name },
              ]),
            ),
          ),
        ).values(),
      );
      const lotteryIds = existing.lottery_ids_json
        ? JSON.parse(existing.lottery_ids_json)
        : [];
      const scratchWinners = computeScratchWinners({
        games: gameResults,
        players: nightPlayers,
        lotteryIds,
      });
      const lastRoster =
        (existing.game_count ?? GAMES_PER_SESSION) >= GAMES_PER_SESSION
          ? (rosters[LAST_GAME_INDEX] ?? teams)
          : [];
      const lastGamePrize = computeLastGamePrize({
        players: lastRoster.flatMap((team) => team.players),
        scores,
      });
      db.prepare(
        `UPDATE sessions SET scores_json=?, results_json=?, game_results_json=?,
          scratch_winners_json=?, last_game_prize_json=?, updated_at=CURRENT_TIMESTAMP
         WHERE id=?`,
      ).run(
        JSON.stringify(scores),
        JSON.stringify(results),
        JSON.stringify(gameResults),
        JSON.stringify(scratchWinners),
        JSON.stringify(lastGamePrize),
        id,
      );
      removeScratchTicketsForSession(id);
      recordScratchTickets({
        sessionId: id,
        sessionDate,
        winners: scratchWinners,
      });
      recordLastGamePrize({ sessionId: id, sessionDate, prize: lastGamePrize });
      refreshManualAveragesFromHistory(db);
      return json({
        id,
        sessionDate,
        scores,
        results,
        scratchWinners,
        lastGamePrize,
        finalTeams: teams,
      });
    }
    if (s[0] !== "players" || !s[1]) return fail("Not found", 404);
    const id = Number(s[1]);
    const body = await request.json();
    const existing = db
      .prepare("SELECT * FROM players WHERE id=?")
      .get(id) as any;
    if (!existing) return fail("Player not found", 404);
    const displayName = String(
      body.displayName ?? existing.display_name,
    ).trim();
    const mode = (body.averageMode ?? existing.average_mode) as AverageMode;
    const league = validateAverage(
      body.leagueAverage ?? existing.league_average,
    );
    const manual = validateAverage(
      body.manualAverage ?? existing.manual_average,
    );
    let fixed = validateAverage(
      Object.prototype.hasOwnProperty.call(body, "fixedAverage")
        ? body.fixedAverage
        : existing.fixed_average,
    );
    if (mode === "FIXED" && fixed === null)
      fixed = validateAverage(
        body.usedAverage ??
          (existing.average_mode === "AUTO"
            ? existing.league_average
            : existing.manual_average),
        false,
      );
    if (mode !== "FIXED") fixed = null;
    if (mode === "AUTO" && league === null)
      throw new Error(
        "AUTO players need a league average (Sync first, or enter one)",
      );
    if (mode === "MANUAL" && manual === null)
      throw new Error("MANUAL players need a manual average");
    db.prepare(
      `UPDATE players SET display_name=?, league_name=?, average_mode=?, league_average=?, manual_average=?, fixed_average=?, active=?, archived=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    ).run(
      displayName,
      body.leagueName ?? existing.league_name,
      mode,
      league,
      manual,
      fixed,
      (body.active ?? Boolean(existing.active)) ? 1 : 0,
      (body.archived ?? Boolean(existing.archived)) ? 1 : 0,
      body.notes ?? existing.notes,
      id,
    );
    if (Array.isArray(body.aliases)) {
      db.prepare("DELETE FROM aliases WHERE player_id=?").run(id);
      for (const alias of body.aliases)
        if (String(alias).trim())
          db.prepare(
            "INSERT OR IGNORE INTO aliases(player_id,alias) VALUES (?,?)",
          ).run(id, String(alias).trim());
    }
    addAverageHistory(id, "MANUAL_EDIT");
    refreshManualAveragesFromHistory(db);
    const row = db.prepare("SELECT * FROM players WHERE id=?").get(id) as any;
    return json(rowToPlayer(row));
  } catch (error) {
    return fail(error);
  } finally {
    persistDb();
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    const s = (await context.params).segments;
    const db = getDb();
    if (s[0] === "lineup" && s.length === 1) {
      clearSavedLineup(db);
      return json({ ok: true });
    }
    if (s[0] === "money" && s[1] === "entries" && s[2]) {
      return json(deleteScratchPayout(Number(s[2])));
    }
    if (s[0] === "sessions" && s[1]) {
      const id = Number(s[1]);
      const existing = db
        .prepare("SELECT id FROM sessions WHERE id=?")
        .get(id) as { id: number } | undefined;
      if (!existing) return fail("Session not found", 404);
      removeScratchTicketsForSession(id);
      db.prepare("DELETE FROM sessions WHERE id=?").run(id);
      refreshManualAveragesFromHistory(db);
      return json({ ok: true });
    }
    if (s[0] !== "players" || !s[1]) return fail("Not found", 404);
    const id = Number(s[1]);
    const body = await request.json();
    const player = db
      .prepare("SELECT display_name FROM players WHERE id=?")
      .get(id) as { display_name: string } | undefined;
    if (!player) return fail("Player not found", 404);
    if (body.confirmName !== player.display_name)
      throw new Error("Type the exact player name to permanently delete");
    db.prepare("DELETE FROM players WHERE id=?").run(id);
    return json({ ok: true });
  } catch (error) {
    return fail(error);
  } finally {
    persistDb();
  }
}
