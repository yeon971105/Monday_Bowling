import { getDb, listPlayers, addAverageHistory } from "./db";
import { mondayAverageFromScores, type ScoreMap } from "./scoring";
import type { PlayerStat, SessionTeamResult } from "./types";

type SessionRow = {
  id: number;
  session_date: string;
  mode: string;
  team_count: number;
  final_teams_json: string;
  scores_json: string | null;
  results_json: string | null;
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
    return JSON.parse(raw) as SessionTeamResult[];
  } catch {
    return [];
  }
}

export function listSessionRows(db = getDb()): SessionRow[] {
  return db
    .prepare(
      `SELECT id, session_date, mode, team_count, final_teams_json, scores_json, results_json, game_count
       FROM sessions ORDER BY session_date DESC, id DESC`,
    )
    .all() as SessionRow[];
}

export function computePlayerStats(db = getDb()): PlayerStat[] {
  const players = listPlayers(true, db);
  const sessions = listSessionRows(db);
  return players
    .filter((player) => !player.archived)
    .map((player) => {
      const id = String(player.id);
      let sessionsPlayed = 0;
      let wins = 0;
      let losses = 0;
      let ties = 0;
      const games: number[] = [];

      for (const session of sessions) {
        const teams = JSON.parse(session.final_teams_json) as Array<{
          name: string;
          players: Array<{ id: string }>;
        }>;
        const team = teams.find((entry) =>
          entry.players.some((member) => member.id === id),
        );
        if (!team) continue;
        sessionsPlayed += 1;
        const results = parseSessionResults(session.results_json);
        if (results.length) {
          const winners = results.filter((result) => result.won);
          const myResult = results.find((result) => result.teamName === team.name);
          if (winners.length === 0) ties += 1;
          else if (myResult?.won) wins += 1;
          else losses += 1;
        }
        const scores = parseSessionScores(session.scores_json)[id];
        if (scores)
          for (const score of scores)
            if (typeof score === "number" && Number.isFinite(score))
              games.push(score);
      }

      const totalPins = games.reduce((sum, value) => sum + value, 0);
      const mondayAverage = mondayAverageFromScores(games);
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
        usedAverage: player.usedAverage,
      };
    });
}

/** Refresh MANUAL averages from all recorded Monday games. */
export function refreshManualAveragesFromHistory(db = getDb()): number {
  const stats = computePlayerStats(db);
  let updated = 0;
  const players = listPlayers(true, db);
  for (const stat of stats) {
    if (stat.mondayAverage == null) continue;
    const player = players.find((entry) => entry.id === stat.id);
    if (!player || player.averageMode !== "MANUAL") continue;
    if (player.manualAverage === stat.mondayAverage) continue;
    db.prepare(
      `UPDATE players SET manual_average=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    ).run(stat.mondayAverage, player.id);
    addAverageHistory(player.id, "MONDAY_HISTORY", undefined, db);
    updated += 1;
  }
  return updated;
}
