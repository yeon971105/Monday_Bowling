export const GAMES_PER_SESSION = 3;
export const LAST_GAME_INDEX = GAMES_PER_SESSION - 1;

export function clampGameIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(LAST_GAME_INDEX, Math.trunc(index)));
}

/** Next game index, or null if already on the last game. Does not chain on double-tap. */
export function nextGameIndex(current: number): number | null {
  const index = clampGameIndex(current);
  if (index >= LAST_GAME_INDEX) return null;
  return index + 1;
}

export const LANE_FEE_PER_GAME = 5;
export const HANDICAP_PERCENT = 0.9;
export const MAX_TEAMS = 6;
export const MIN_TEAMS = 2;
/** Lane fees go to Jewon — he does not pay himself. */
export const FEE_COLLECTOR_PATTERN = /jewon/i;

export function isFeeCollector(name: string): boolean {
  return FEE_COLLECTOR_PATTERN.test(name);
}

export type PlayerScores = [number | null, number | null, number | null];
export type ScoreMap = Record<string, PlayerScores>;

export interface TeamForScoring {
  name: string;
  playerIds: string[];
  /** Sum of used averages for handicap comparison. */
  averageSum: number;
}

export interface TeamGameLine {
  teamName: string;
  scratch: number;
  handicap: number;
  total: number;
  place: number | null;
  won: boolean;
}

export interface GameResult {
  gameIndex: number;
  complete: boolean;
  teams: TeamGameLine[];
  winnerName: string | null;
  lastName: string | null;
  /** Pin difference between 1st and 2nd when there is a sole winner. */
  margin: number | null;
}

export interface LiveStanding {
  teamName: string;
  total: number;
  place: number;
  leading: boolean;
  tied: boolean;
  /** Pins ahead of 2nd when this team is the sole leader. */
  leadBy: number;
  /** Pins behind the current leader. */
  behindBy: number;
  /** Pins needed to become the sole leader (0 if already leading alone). */
  toLead: number;
}

/** Live race from current handicap totals — works before the game is complete. */
export function computeLiveStandings(
  teams: Array<{ teamName: string; total: number }>,
): LiveStanding[] {
  if (!teams.length) return [];
  const ranked = [...teams].sort(
    (a, b) => b.total - a.total || a.teamName.localeCompare(b.teamName),
  );
  const best = ranked[0]?.total ?? 0;
  const second = ranked[1]?.total ?? best;
  const leadCount = ranked.filter((team) => team.total === best).length;
  const placeByName = new Map<string, number>();
  ranked.forEach((team, index) => placeByName.set(team.teamName, index + 1));
  return teams.map((team) => {
    const leading = leadCount === 1 && team.total === best;
    const tied = leadCount > 1 && team.total === best;
    return {
      teamName: team.teamName,
      total: team.total,
      place: placeByName.get(team.teamName) ?? 0,
      leading,
      tied,
      leadBy: leading ? team.total - second : 0,
      behindBy: team.total === best ? 0 : best - team.total,
      toLead: leading ? 0 : best - team.total + 1,
    };
  });
}

export interface TeamSeriesResult {
  teamName: string;
  averageSum: number;
  handicapPerGame: number;
  gameTotals: number[];
  scratchTotal: number;
  handicapTotal: number;
  finalTotal: number;
  wins: number;
  won: boolean;
  place: number | null;
}

export interface MoneyLine {
  playerId: string;
  name: string;
  teamName: string;
  seriesTotal: number;
  laneFee: number;
  betPaid: number;
  betReceived: number;
  wins: number;
  losses: number;
  /** Positive = owes money overall; negative = receives. */
  netDue: number;
}

export function averageOf(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function emptyScores(playerIds: string[]): ScoreMap {
  return Object.fromEntries(
    playerIds.map((id) => [id, [null, null, null] as PlayerScores]),
  );
}

export function sumDefined(scores: Array<number | null | undefined>): number {
  return scores.reduce<number>(
    (sum, value) => sum + (typeof value === "number" ? value : 0),
    0,
  );
}

export function playerSeriesTotal(scores: PlayerScores | undefined): number {
  if (!scores) return 0;
  return sumDefined(scores);
}

/** 90% of (strongest team average-sum − this team), floored. */
export function teamHandicapPerGame(
  teams: Array<{ averageSum: number }>,
): number[] {
  const maxSum = Math.max(...teams.map((team) => team.averageSum), 0);
  return teams.map((team) =>
    Math.floor((maxSum - team.averageSum) * HANDICAP_PERCENT),
  );
}

export function isGameComplete(
  teams: TeamForScoring[],
  scores: ScoreMap,
  gameIndex: number,
): boolean {
  if (teams.length < 2) return false;
  if (teams.some((team) => team.playerIds.length === 0)) return false;
  return teams.every((team) =>
    team.playerIds.every((playerId) => {
      const value = scores[String(playerId)]?.[gameIndex];
      return typeof value === "number" && Number.isFinite(value);
    }),
  );
}

export function computeGameResult(input: {
  teams: TeamForScoring[];
  scores: ScoreMap;
  gameIndex: number;
}): GameResult {
  const handicaps = teamHandicapPerGame(input.teams);
  const complete = isGameComplete(input.teams, input.scores, input.gameIndex);
  // Scratch/total update live as scores are typed; win/loss only when complete.
  const lines: TeamGameLine[] = input.teams.map((team, index) => {
    const scratch = team.playerIds.reduce((sum, playerId) => {
      const value = input.scores[String(playerId)]?.[input.gameIndex];
      return sum + (typeof value === "number" ? value : 0);
    }, 0);
    const handicap = handicaps[index];
    return {
      teamName: team.name,
      scratch,
      handicap,
      total: scratch + handicap,
      place: null,
      won: false,
    };
  });

  if (!complete) {
    return {
      gameIndex: input.gameIndex,
      complete: false,
      teams: lines,
      winnerName: null,
      lastName: null,
      margin: null,
    };
  }

  const ranked = [...lines].sort(
    (a, b) => b.total - a.total || a.teamName.localeCompare(b.teamName),
  );
  const placeByName = new Map<string, number>();
  ranked.forEach((line, index) => placeByName.set(line.teamName, index + 1));
  const best = ranked[0]?.total ?? 0;
  const second = ranked[1]?.total ?? best;
  const worst = ranked[ranked.length - 1]?.total ?? 0;
  const soleFirst = ranked.filter((line) => line.total === best).length === 1;
  const soleLast = ranked.filter((line) => line.total === worst).length === 1;

  const teams = lines.map((line) => ({
    ...line,
    place: placeByName.get(line.teamName) ?? null,
    won: soleFirst && line.total === best,
  }));

  return {
    gameIndex: input.gameIndex,
    complete: true,
    teams,
    winnerName: soleFirst ? ranked[0].teamName : null,
    lastName: soleLast ? ranked[ranked.length - 1].teamName : null,
    margin: soleFirst ? best - second : null,
  };
}

export function computeSeriesResults(input: {
  teams: TeamForScoring[];
  scores: ScoreMap;
  gameCount?: number;
}): TeamSeriesResult[] {
  const gameCount = input.gameCount ?? GAMES_PER_SESSION;
  const handicaps = teamHandicapPerGame(input.teams);
  const games = Array.from({ length: gameCount }, (_, gameIndex) =>
    computeGameResult({ ...input, gameIndex }),
  );

  const results = input.teams.map((team, index) => {
    const handicapPerGame = handicaps[index];
    const gameTotals = games.map((game) => {
      const line = game.teams.find((entry) => entry.teamName === team.name);
      return game.complete ? (line?.total ?? 0) : 0;
    });
    const scratchTotal = games.reduce((sum, game) => {
      if (!game.complete) return sum;
      const line = game.teams.find((entry) => entry.teamName === team.name);
      return sum + (line?.scratch ?? 0);
    }, 0);
    const completedGames = games.filter((game) => game.complete).length;
    const handicapTotal = handicapPerGame * completedGames;
    const wins = games.filter(
      (game) =>
        game.complete &&
        game.teams.find((entry) => entry.teamName === team.name)?.won,
    ).length;
    return {
      teamName: team.name,
      averageSum: team.averageSum,
      handicapPerGame,
      gameTotals,
      scratchTotal,
      handicapTotal,
      finalTotal: scratchTotal + handicapTotal,
      wins,
      won: false,
      place: null as number | null,
    };
  });

  const allGamesDone = games.every((game) => game.complete);
  if (allGamesDone) {
    const ranked = [...results].sort(
      (a, b) =>
        b.finalTotal - a.finalTotal || a.teamName.localeCompare(b.teamName),
    );
    ranked.forEach((line, index) => {
      const target = results.find((entry) => entry.teamName === line.teamName);
      if (target) target.place = index + 1;
    });
    const best = ranked[0]?.finalTotal ?? 0;
    if (ranked.filter((line) => line.finalTotal === best).length === 1) {
      const winner = results.find(
        (entry) => entry.teamName === ranked[0].teamName,
      );
      if (winner) winner.won = true;
    }
  }

  return results;
}

/** Convert series results into the shape History already stores. */
export function toSessionTeamResults(series: TeamSeriesResult[]): Array<{
  teamName: string;
  gameTotals: number[];
  scratchTotal: number;
  handicapTotal: number;
  finalTotal: number;
  handicapPerGame: number;
  won: boolean;
}> {
  return series.map((team) => ({
    teamName: team.teamName,
    gameTotals: team.gameTotals,
    scratchTotal: team.scratchTotal,
    handicapTotal: team.handicapTotal,
    finalTotal: team.finalTotal,
    handicapPerGame: team.handicapPerGame,
    won: team.won,
  }));
}

export type MoneyTeam = {
  name: string;
  averageSum: number;
  players: Array<{ id: string; name: string }>;
};

export type StoredGameTeamLine = {
  teamName: string;
  playerIds: string[];
  scratch: number;
  handicap: number;
  total: number;
  place: number | null;
  won: boolean;
};

/** Per-game snapshot so mid-night team changes keep correct W-L / money. */
export type StoredGameResult = {
  gameIndex: number;
  teams: StoredGameTeamLine[];
  winnerName: string | null;
  lastName: string | null;
  margin: number | null;
};

export function toStoredGameResult(
  game: GameResult,
  teams: MoneyTeam[],
): StoredGameResult {
  return {
    gameIndex: game.gameIndex,
    winnerName: game.winnerName,
    lastName: game.lastName,
    margin: game.margin,
    teams: game.teams.map((line) => {
      const source = teams.find((team) => team.name === line.teamName);
      return {
        teamName: line.teamName,
        playerIds: (source?.players ?? []).map((player) => String(player.id)),
        scratch: line.scratch,
        handicap: line.handicap,
        total: line.total,
        place: line.place,
        won: line.won,
      };
    }),
  };
}

export function buildStoredGameResults(input: {
  teamsByGame: Array<MoneyTeam[] | null | undefined>;
  scores: ScoreMap;
  gameCount: number;
}): StoredGameResult[] {
  const results: StoredGameResult[] = [];
  for (let gameIndex = 0; gameIndex < input.gameCount; gameIndex += 1) {
    const teams =
      input.teamsByGame[gameIndex] ??
      input.teamsByGame.find((entry) => entry && entry.length) ??
      null;
    if (!teams?.length) continue;
    const scoringTeams: TeamForScoring[] = teams.map((team) => ({
      name: team.name,
      playerIds: team.players.map((player) => String(player.id)),
      averageSum: team.averageSum,
    }));
    const game = computeGameResult({
      teams: scoringTeams,
      scores: input.scores,
      gameIndex,
    });
    if (!game.complete) continue;
    results.push(toStoredGameResult(game, teams));
  }
  return results;
}

export const SCRATCH_WINS_NEEDED = 2;

export type ScratchWinner = {
  playerId: string;
  name: string;
  wins: number;
};

export const LAST_GAME_ENTRY_DOLLARS = 1;
export const LAST_GAME_TICKET_DOLLARS = 5;

export type LastGamePrizeWinner = {
  playerId: string;
  name: string;
  score: number;
  usedAverage: number;
  improvement: number;
};

export type LastGamePrize = {
  participantCount: number;
  contribution: number;
  ticketCount: number;
  payout: number;
  clubPotAdded: number;
  winners: LastGamePrizeWinner[];
};

/** One $5 ticket per five bowlers, ranked by Game 3 score minus used average. */
export function computeLastGamePrize(input: {
  players: Array<{
    id: string | number;
    name: string;
    usedAverage: number;
  }>;
  scores: ScoreMap;
}): LastGamePrize {
  const players = [
    ...new Map(
      input.players.map((player) => [String(player.id), player]),
    ).values(),
  ];
  const ticketCount = Math.floor(players.length / 5);
  const ranked = players
    .map((player) => {
      const score = input.scores[String(player.id)]?.[LAST_GAME_INDEX];
      if (typeof score !== "number" || !Number.isFinite(score)) return null;
      return {
        playerId: String(player.id),
        name: player.name,
        score,
        usedAverage: player.usedAverage,
        improvement: score - player.usedAverage,
      };
    })
    .filter((player): player is LastGamePrizeWinner => player !== null)
    .sort(
      (a, b) =>
        b.improvement - a.improvement ||
        b.score - a.score ||
        a.name.localeCompare(b.name),
    );
  const winners = ranked.slice(0, ticketCount);
  const contribution = players.length * LAST_GAME_ENTRY_DOLLARS;
  const payout = winners.length * LAST_GAME_TICKET_DOLLARS;
  return {
    participantCount: players.length,
    contribution,
    ticketCount: winners.length,
    payout,
    clubPotAdded: contribution - payout,
    winners,
  };
}

export function gameWinCounts(games: StoredGameResult[]): Map<string, number> {
  const wins = new Map<string, number>();
  for (const game of games) {
    const winner =
      game.teams.find((team) => team.won) ??
      (game.winnerName
        ? game.teams.find((team) => team.teamName === game.winnerName)
        : undefined);
    if (!winner) continue;
    for (const id of winner.playerIds) {
      const key = String(id);
      wins.set(key, (wins.get(key) ?? 0) + 1);
    }
  }
  return wins;
}

/** 2+ team-game wins among lottery entrants (best of 3, or a late join with 2 wins). */
export function computeScratchWinners(input: {
  games: StoredGameResult[];
  players: Array<{ id: string | number; name: string }>;
  lotteryIds: Iterable<string | number>;
}): ScratchWinner[] {
  const allowed = new Set([...input.lotteryIds].map((id) => String(id)));
  if (!allowed.size) return [];
  const wins = gameWinCounts(input.games);
  const nameById = new Map(
    input.players.map((player) => [String(player.id), player.name]),
  );
  return [...allowed]
    .filter((id) => (wins.get(id) ?? 0) >= SCRATCH_WINS_NEEDED)
    .map((id) => ({
      playerId: id,
      name: nameById.get(id) ?? id,
      wins: wins.get(id) ?? 0,
    }))
    .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name));
}

export function moneyTeamsSignature(teams: MoneyTeam[]): string {
  return teams
    .map(
      (team) =>
        `${team.name}:${team.players
          .map((player) => String(player.id))
          .sort()
          .join(",")}`,
    )
    .sort()
    .join("|");
}

/** True when membership changed between games (Reset for next game). */
export function teamsChangedDuringNight(
  teamsByGame: Array<MoneyTeam[] | null | undefined>,
  gameCount: number,
): boolean {
  const signatures: string[] = [];
  for (let gameIndex = 0; gameIndex < gameCount; gameIndex += 1) {
    const teams = teamsByGame[gameIndex];
    if (teams?.length) signatures.push(moneyTeamsSignature(teams));
  }
  if (signatures.length <= 1) return false;
  return signatures.some((signature) => signature !== signatures[0]);
}

export function computeMoneySettlement(input: {
  teams?: MoneyTeam[];
  teamsByGame?: Array<MoneyTeam[] | null | undefined>;
  scores: ScoreMap;
  gameCount?: number;
}): MoneyLine[] {
  const gameCount = input.gameCount ?? GAMES_PER_SESSION;
  const fallback = input.teams ?? [];
  const teamsByGame: MoneyTeam[][] = Array.from(
    { length: gameCount },
    (_, gameIndex) => {
      const specific = input.teamsByGame?.[gameIndex];
      if (specific?.length) return specific;
      return fallback;
    },
  );

  const byId = new Map<string, MoneyLine>();
  const ensure = (player: { id: string; name: string }, teamName: string) => {
    const id = String(player.id);
    let line = byId.get(id);
    if (!line) {
      line = {
        playerId: id,
        name: player.name,
        teamName,
        seriesTotal: playerSeriesTotal(input.scores[id]),
        laneFee: 0,
        betPaid: 0,
        betReceived: 0,
        wins: 0,
        losses: 0,
        netDue: 0,
      };
      byId.set(id, line);
    } else {
      line.teamName = teamName;
    }
    return line;
  };

  for (const teams of teamsByGame) {
    for (const team of teams)
      for (const player of team.players) ensure(player, team.name);
  }

  for (let gameIndex = 0; gameIndex < gameCount; gameIndex += 1) {
    const teams = teamsByGame[gameIndex];
    if (!teams.length) continue;
    const scoringTeams: TeamForScoring[] = teams.map((team) => ({
      name: team.name,
      playerIds: team.players.map((player) => String(player.id)),
      averageSum: team.averageSum,
    }));
    const game = computeGameResult({
      teams: scoringTeams,
      scores: input.scores,
      gameIndex,
    });
    if (!game.complete) continue;

    for (const team of teams)
      for (const player of team.players) {
        const line = ensure(player, team.name);
        line.laneFee += LANE_FEE_PER_GAME;
        if (game.winnerName === team.name) line.wins += 1;
        if (game.lastName === team.name && game.winnerName !== team.name)
          line.losses += 1;
      }
  }

  return [...byId.values()].map((line) => {
    const laneFee = Math.round(line.laneFee * 100) / 100;
    return {
      ...line,
      seriesTotal: playerSeriesTotal(input.scores[line.playerId]),
      laneFee,
      betPaid: 0,
      betReceived: 0,
      netDue: isFeeCollector(line.name) ? 0 : laneFee,
    };
  });
}

export function gameMargins(
  results: Array<{ teamName: string; gameTotals: number[]; won?: boolean }>,
): Array<{
  gameIndex: number;
  winnerName: string | null;
  margin: number | null;
  totals: Array<{ teamName: string; total: number }>;
}> {
  const gameCount = Math.max(
    0,
    ...results.map((result) => result.gameTotals?.length ?? 0),
  );
  return Array.from({ length: gameCount }, (_, gameIndex) => {
    const totals = results.map((result) => ({
      teamName: result.teamName,
      total: result.gameTotals?.[gameIndex] ?? 0,
    }));
    if (!totals.length || totals.every((entry) => entry.total === 0))
      return {
        gameIndex,
        winnerName: null,
        margin: null,
        totals,
      };
    const ranked = [...totals].sort((a, b) => b.total - a.total);
    const best = ranked[0];
    const second = ranked[1];
    const soleLead =
      ranked.filter((entry) => entry.total === best.total).length === 1;
    return {
      gameIndex,
      winnerName: soleLead ? best.teamName : null,
      margin:
        soleLead && second
          ? best.total - second.total
          : soleLead
            ? best.total
            : null,
      totals,
    };
  });
}

export function mondayAverageFromScores(
  allGames: Array<number | null | undefined>,
): number | null {
  const pins = allGames.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  if (!pins.length) return null;
  return Math.round(averageOf(pins));
}
