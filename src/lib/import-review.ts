import {
  addAverageHistory,
  getDb,
  getSettings,
  listPlayers,
} from "./db";
import { calculateHandicap, normalizeName, validateAverage } from "./bowling";
import type { ParsedLeaguePdf } from "./types";

export type ReviewCategory =
  | "EXACT"
  | "ALIAS"
  | "PROBABLE"
  | "AMBIGUOUS"
  | "NEW";

export type ImportDecision = {
  rowIndex: number;
  action: "UPDATE" | "NEW" | "IGNORE";
  playerId?: number;
  saveAlias?: boolean;
};

export type ReviewRow = ParsedLeaguePdf["players"][number] & {
  rowIndex: number;
  category: ReviewCategory;
  playerId: number | null;
  playerName: string | null;
  oldAverage: number | null;
  changed: boolean;
  averageMode: string | null;
  usedAverage: number | null;
  incomingChangesUsedAverage: boolean;
  usedAverageProtected: boolean;
  calculatedIncomingHandicap: number | null;
  pdfHandicapDiscrepancy: boolean;
  candidates: Array<{ id: number; displayName: string }>;
  recommendedAction: "UPDATE" | "REVIEW";
};

export type ImportReview = ParsedLeaguePdf & {
  reviewRows: ReviewRow[];
  existingPlayers: Array<{ id: number; displayName: string }>;
  existingNotFound: Array<{ id: number; displayName: string }>;
};

function editDistance(a: string, b: string): number {
  const matrix = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return matrix[a.length][b.length];
}

export function buildReview(parsed: ParsedLeaguePdf): ImportReview {
  const players = listPlayers(true);
  const settings = getSettings();
  const matchedIds = new Set<number>();
  const rows = parsed.players.map((row, rowIndex) => {
    const normalized = normalizeName(row.printedName);
    const exact = players.find((p) =>
      [p.displayName, p.leagueName]
        .filter(Boolean)
        .some((name) => normalizeName(name!) === normalized),
    );
    const alias = players.find((p) =>
      p.aliases.some((name) => normalizeName(name) === normalized),
    );
    let category: ReviewCategory = "NEW";
    let candidates: typeof players = [];
    let player = exact ?? alias;
    if (player) category = exact ? "EXACT" : "ALIAS";
    else {
      candidates = players
        .map((p) => ({
          p,
          distance: Math.min(
            ...[p.displayName, p.leagueName, ...p.aliases]
              .filter(Boolean)
              .map((name) => editDistance(normalized, normalizeName(name!))),
          ),
        }))
        .filter(
          ({ p, distance }) =>
            distance <= 2 ||
            normalizeName(p.displayName).startsWith(normalized) ||
            normalized.startsWith(normalizeName(p.displayName)),
        )
        .sort((a, b) => a.distance - b.distance)
        .map(({ p }) => p);
      if (candidates.length === 1) {
        category = "PROBABLE";
        player = candidates[0];
      } else if (candidates.length > 1) category = "AMBIGUOUS";
    }
    if (player) matchedIds.add(player.id);
    return {
      rowIndex,
      ...row,
      category,
      playerId: player?.id ?? null,
      playerName: player?.displayName ?? null,
      oldAverage: player?.leagueAverage ?? null,
      changed: Boolean(player && row.currentAverage !== player.leagueAverage),
      averageMode: player?.averageMode ?? null,
      usedAverage: player?.usedAverage ?? null,
      incomingChangesUsedAverage: Boolean(
        player &&
          player.averageMode === "AUTO" &&
          row.currentAverage !== player.usedAverage,
      ),
      usedAverageProtected: Boolean(player && player.averageMode !== "AUTO"),
      calculatedIncomingHandicap:
        row.currentAverage === null
          ? null
          : calculateHandicap(row.currentAverage, settings),
      pdfHandicapDiscrepancy:
        row.currentAverage === null || row.pdfHandicap === null
          ? false
          : row.pdfHandicap !== calculateHandicap(row.currentAverage, settings),
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        displayName: candidate.displayName,
      })),
      recommendedAction:
        category === "EXACT" || category === "ALIAS" ? "UPDATE" : "REVIEW",
    } satisfies ReviewRow;
  });
  return {
    ...parsed,
    reviewRows: rows,
    existingPlayers: players
      .filter((player) => !player.archived)
      .map((player) => ({ id: player.id, displayName: player.displayName })),
    existingNotFound: players
      .filter((p) => !p.archived && !matchedIds.has(p.id))
      .map((p) => ({ id: p.id, displayName: p.displayName })),
  };
}

export function defaultDecisionsForReview(
  review: ImportReview,
): ImportDecision[] {
  return review.reviewRows.map((row) => {
    if (row.category === "EXACT" || row.category === "ALIAS")
      return {
        rowIndex: row.rowIndex,
        action: "UPDATE" as const,
        playerId: row.playerId ?? undefined,
        saveAlias: row.category === "ALIAS",
      };
    return { rowIndex: row.rowIndex, action: "IGNORE" as const };
  });
}

export function applyImportDecisions(
  importId: number,
  decisions: ImportDecision[],
  review: ImportReview,
): { updated: number; created: number; protectedUsedAverage: number } {
  const db = getDb();
  let updated = 0;
  let created = 0;
  let protectedUsedAverage = 0;

  for (const decision of decisions) {
      const row = review.reviewRows.find(
        (candidate) => candidate.rowIndex === decision.rowIndex,
      );
      if (!row || decision.action === "IGNORE") continue;
      if (row.currentAverage !== null) validateAverage(row.currentAverage, false);
      let playerId = decision.playerId ?? row.playerId ?? undefined;
      let importChanged = false;
      if (decision.action === "NEW") {
        const createdRow = db
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
            importId,
          );
        playerId = Number(createdRow.lastInsertRowid);
        importChanged = true;
        created += 1;
      } else {
        if (!playerId)
          throw new Error(`Choose a player for ${row.printedName}`);
        const before = db
          .prepare(
            "SELECT league_average, pdf_handicap, games, pins, team_number, team_name, league_name, average_mode FROM players WHERE id=?",
          )
          .get(playerId) as {
          league_average: number | null;
          pdf_handicap: number | null;
          games: number | null;
          pins: number | null;
          team_number: number | null;
          team_name: string | null;
          league_name: string | null;
          average_mode: string;
        };
        if (before.average_mode === "FIXED") {
          protectedUsedAverage += 1;
          continue;
        }
        importChanged =
          before.league_average !== row.currentAverage ||
          before.pdf_handicap !== row.pdfHandicap ||
          before.games !== row.games ||
          before.pins !== row.pins ||
          before.team_number !== row.teamNumber ||
          before.team_name !== row.teamName ||
          (before.league_name === null && row.printedName !== null);
        if (before.average_mode !== "AUTO") protectedUsedAverage += 1;
        db.prepare(
          `UPDATE players SET league_average=?, pdf_handicap=?, games=?, pins=?, team_number=?, team_name=?, league_name=COALESCE(league_name,?), last_import_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        ).run(
          row.currentAverage,
          row.pdfHandicap,
          row.games,
          row.pins,
          row.teamNumber,
          row.teamName,
          row.printedName,
          importId,
          playerId,
        );
        if (importChanged) updated += 1;
      }
      if (decision.saveAlias && playerId)
        db.prepare(
          "INSERT OR IGNORE INTO aliases(player_id,alias) VALUES (?,?)",
        ).run(playerId, row.printedName);
      if (playerId && importChanged)
        addAverageHistory(playerId, "PDF_IMPORT", importId, db);
  }
  db.prepare(
    "UPDATE imports SET status='APPLIED', decisions_json=?, applied_at=CURRENT_TIMESTAMP WHERE id=?",
  ).run(JSON.stringify(decisions), importId);
  return { updated, created, protectedUsedAverage };
}
