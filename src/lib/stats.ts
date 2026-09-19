import { getDb, getSettings, listPlayers, addAverageHistory } from "./db";
import { calculateHandicap } from "./bowling";
import {
  gameWinCounts,
  mondayAverageFromScores,
  SCRATCH_WINS_NEEDED,
  type ScoreMap,
  type StoredGameResult,
} from "./scoring";
import type { PlayerStat, SessionTeamResult } from "./types";

type SessionRow = {
  id: number;
  session_date: string;
  mode: string;
  team_count: number;
  final_teams_json: string;
  scores_json: string | null;
  results_json: string | null;
  game_results_json?: string | null;
  lottery_ids_json?: string | null;
  scratch_winners_json?: string | null;
  game_count: number | null;
};

export function parseSessionScores(raw: string | null): ScoreMap {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ScoreMap;
  } catch {
    return {};
  }
}

export function parseSessionResults(raw: string | null): SessionTeamResult[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed[0]?.gameTotals) return parsed;
    if (parsed?.series && Array.isArray(parsed.series)) return parsed.series;
    return [];
  } catch {
    return [];
  }
}

export function parseStoredGameResults(
  raw: string | null | undefined,
): StoredGameResult[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && typeof parsed[0]?.gameIndex === "number")
      return parsed as StoredGameResult[];
    if (Array.isArray(parsed?.games)) return parsed.games as StoredGameResult[];
    return [];
  } catch {
    return [];
  }
}

export function listSessionRows(db = getDb()): SessionRow[] {
  return db
    .prepare(
      `SELECT id, session_date, mode, team_count, final_teams_json, scores_json,
              results_json, game_results_json, lottery_ids_json, scratch_winners_json, game_count
       FROM sessions ORDER BY session_date DESC, id DESC`,
    )
    .all() as SessionRow[];
}

function tallyFromStoredGames(
  id: string,
  games: StoredGameResult[],
): { wins: number; losses: number; ties: number; played: boolean } {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let played = false;
  for (const game of games) {
    const mine = game.teams.find((team) =>
      team.playerIds.some((playerId) => String(playerId) === id),
    );
    if (!mine) continue;
    played = true;
    if (mine.won) wins += 1;
    else if (game.winnerName && game.lastName === mine.teamName) losses += 1;
    else if (!game.winnerName && mine.place === 1) ties += 1;
  }
  return { wins, losses, ties, played };
}

function tallyFromLegacyResults(
  id: string,
  teams: Array<{ name: string; players: Array<{ id: string }> }>,
  results: SessionTeamResult[],
): { wins: number; losses: number; ties: number; played: boolean } {
  const team = teams.find((entry) =>
    entry.players.some((member) => String(member.id) === id),
  );
  if (!team) return { wins: 0, losses: 0, ties: 0, played: false };
  const myResult = results.find((result) => result.teamName === team.name);
  let wins = 0;
  let losses = 0;
  let ties = 0;
  if (results.length && myResult?.gameTotals?.length) {
    const gameCount = Math.max(
      ...results.map((result) => result.gameTotals?.length ?? 0),
      0,
    );
    for (let gameIndex = 0; gameIndex < gameCount; gameIndex += 1) {
      const totals = results.map((result) => ({
        teamName: result.teamName,
        total: result.gameTotals?.[gameIndex] ?? 0,
      }));
      if (totals.every((entry) => entry.total === 0)) continue;
      const best = Math.max(...totals.map((entry) => entry.total));
      const worst = Math.min(...totals.map((entry) => entry.total));
      const leaders = totals.filter((entry) => entry.total === best);
      const mine = totals.find((entry) => entry.teamName === team.name);
      if (!mine) continue;
      if (leaders.length > 1 && mine.total === best) ties += 1;
      else if (mine.total === best) wins += 1;
      else if (mine.total === worst && best !== worst) losses += 1;
    }
  }
  return { wins, losses, ties, played: true };
}

function parseIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((id) => String(id));
  } catch {
    return [];
  }
}

function playerWonScratch(
  id: string,
  session: SessionRow,
  storedGames: StoredGameResult[],
  legacyWins: number,
): boolean {
  try {
    const stored = session.scratch_winners_json
      ? JSON.parse(session.scratch_winners_json)
      : null;
    if (Array.isArray(stored) && stored.length) {
      return stored.some(
        (row: { playerId?: string | number }) => String(row.playerId) === id,
      );
    }
  } catch {
    /* fall through */
  }
  const lottery = parseIdList(session.lottery_ids_json);
  if (!lottery.length || !lottery.includes(id)) return false;
  if (storedGames.length)
    return (gameWinCounts(storedGames).get(id) ?? 0) >= SCRATCH_WINS_NEEDED;
  return legacyWins >= SCRATCH_WINS_NEEDED;
}

export function computePlayerStats(db = getDb()): PlayerStat[] {
  const players = listPlayers(true, db);
  const sessions = listSessionRows(db);
  const settings = getSettings(db);
  return players
    .filter((player) => !player.archived)
    .map((player) => {
      const id = String(player.id);
      let sessionsPlayed = 0;
      let wins = 0;
      let losses = 0;
      let ties = 0;
      let scratchTickets = 0;
      const games: number[] = [];

      for (const session of sessions) {
        const storedGames = parseStoredGameResults(session.game_results_json);
        let tally: {
          wins: number;
          losses: number;
          ties: number;
          played: boolean;
        };
        if (storedGames.length) {
          tally = tallyFromStoredGames(id, storedGames);
        } else {
          const teams = JSON.parse(session.final_teams_json) as Array<{
            name: string;
            players: Array<{ id: string }>;
          }>;
          const results = parseSessionResults(session.results_json);
          tally = tallyFromLegacyResults(id, teams, results);
        }
        if (!tally.played) {
          const scoresOnly = parseSessionScores(session.scores_json)[id];
          const hasPins = scoresOnly?.some(
            (value) => typeof value === "number" && Number.isFinite(value),
          );
          if (!hasPins) continue;
        }
        sessionsPlayed += 1;
        wins += tally.wins;
        losses += tally.losses;
        ties += tally.ties;
        if (playerWonScratch(id, session, storedGames, tally.wins))
          scratchTickets += 1;
        const scores = parseSessionScores(session.scores_json)[id];
        if (scores)
          for (const score of scores)
            if (typeof score === "number" && Number.isFinite(score))
              games.push(score);
      }

      const totalPins = games.reduce((sum, value) => sum + value, 0);
      const mondayAverage = mondayAverageFromScores(games);
      const handicapAverage =
        games.length > 10 ? mondayAverage : player.usedAverage;
      const decided = wins + losses;
      return {
        id: player.id,
        displayName: player.displayName,
        averageMode: player.averageMode,
        sessions: sessionsPlayed,
        wins,
        losses,
        ties,
        winRate: decided ? wins / decided : null,
        mondayAverage,
        gamesPlayed: games.length,
        totalPins,
        scratchTickets,
        scratchPool: Boolean(player.scratchPool),
        usedAverage: player.usedAverage,
        handicapAverage,
        handicap:
          handicapAverage == null
            ? null
            : calculateHandicap(handicapAverage, settings),
      };
    });
}

/** Minimum Monday nights before history average replaces a locked guest average. */
export const HISTORY_AVG_MIN_SESSIONS = 3;
export const MONDAY_AVG_MIN_GAMES = 11;

/** After 10 games, Monday history becomes the used average and any lock is removed. */
export function refreshManualAveragesFromHistory(db = getDb()): {
  updated: number;
  unlocked: number;
} {
  const stats = computePlayerStats(db);
  let updated = 0;
  let unlocked = 0;
  const players = listPlayers(true, db);
  for (const stat of stats) {
    if (stat.mondayAverage == null) continue;
    const player = players.find((entry) => entry.id === stat.id);
    if (!player || player.archived) continue;

    if (stat.gamesPlayed >= MONDAY_AVG_MIN_GAMES) {
      const changed =
        player.averageMode !== "MANUAL" ||
        player.manualAverage !== stat.mondayAverage ||
        player.fixedAverage !== null;
      if (!changed) continue;
      if (player.averageMode === "FIXED") unlocked += 1;
      db.prepare(
        `UPDATE players SET average_mode='MANUAL', manual_average=?, fixed_average=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      ).run(stat.mondayAverage, player.id);
      addAverageHistory(player.id, "MONDAY_HISTORY_AUTO", undefined, db);
      updated += 1;
      continue;
    }

    // Unlocked guests keep tracking Monday history before the automatic threshold.
    if (player.leagueAverage == null) {
      if (stat.sessions < HISTORY_AVG_MIN_SESSIONS) continue;
      if (player.averageMode === "MANUAL") {
        if (player.manualAverage === stat.mondayAverage) continue;
        db.prepare(
          `UPDATE players SET manual_average=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        ).run(stat.mondayAverage, player.id);
        addAverageHistory(player.id, "MONDAY_HISTORY", undefined, db);
        updated += 1;
      }
      continue;
    }

    // League members on MANUAL still track Monday history average.
    if (player.averageMode !== "MANUAL") continue;
    if (player.manualAverage === stat.mondayAverage) continue;
    db.prepare(
      `UPDATE players SET manual_average=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    ).run(stat.mondayAverage, player.id);
    addAverageHistory(player.id, "MONDAY_HISTORY", undefined, db);
    updated += 1;
  }
  return { updated, unlocked };
}
