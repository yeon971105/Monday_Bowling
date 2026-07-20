export const GAMES_PER_SESSION = 3;
export const LANE_FEE_PER_GAME = 5;
export const HANDICAP_PERCENT = 0.9;

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
  return teams.every((team) =>
    team.playerIds.every((playerId) => {
      const value = scores[playerId]?.[gameIndex];
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
  const lines: TeamGameLine[] = input.teams.map((team, index) => {
    const scratch = complete
      ? team.playerIds.reduce(
          (sum, playerId) =>
            sum + (input.scores[playerId]?.[input.gameIndex] ?? 0),
          0,
        )
      : 0;
    const handicap = handicaps[index];
    return {
      teamName: team.name,
      scratch,
      handicap,
      total: complete ? scratch + handicap : 0,
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
  const soleFirst =
    ranked.filter((line) => line.total === best).length === 1;
  const soleLast =
    ranked.filter((line) => line.total === worst).length === 1;

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
      (a, b) => b.finalTotal - a.finalTotal || a.teamName.localeCompare(b.teamName),
    );
    ranked.forEach((line, index) => {
      const target = results.find((entry) => entry.teamName === line.teamName);
      if (target) target.place = index + 1;
    });
    const best = ranked[0]?.finalTotal ?? 0;
    if (ranked.filter((line) => line.finalTotal === best).length === 1) {
      const winner = results.find((entry) => entry.teamName === ranked[0].teamName);
      if (winner) winner.won = true;
    }
  }

  return results;
}

/** Convert series results into the shape History already stores. */
export function toSessionTeamResults(
  series: TeamSeriesResult[],
): Array<{
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

export function computeMoneySettlement(input: {
  teams: Array<{
    name: string;
    averageSum: number;
    players: Array<{ id: string; name: string }>;
  }>;
  scores: ScoreMap;
  gameCount?: number;
}): MoneyLine[] {
  const gameCount = input.gameCount ?? GAMES_PER_SESSION;
  const scoringTeams: TeamForScoring[] = input.teams.map((team) => ({
    name: team.name,
    playerIds: team.players.map((player) => player.id),
    averageSum: team.averageSum,
  }));
  const games = Array.from({ length: gameCount }, (_, gameIndex) =>
    computeGameResult({
      teams: scoringTeams,
      scores: input.scores,
      gameIndex,
    }),
  );

  const lines: MoneyLine[] = input.teams.flatMap((team) =>
    team.players.map((player) => ({
      playerId: player.id,
      name: player.name,
      teamName: team.name,
      seriesTotal: playerSeriesTotal(input.scores[player.id]),
      laneFee: 0,
      betPaid: 0,
      betReceived: 0,
      netDue: 0,
    })),
  );

  for (const game of games) {
    if (!game.complete) continue;
    const winners = game.winnerName
      ? lines.filter((line) => line.teamName === game.winnerName)
      : [];
    const losers = game.lastName
      ? lines.filter((line) => line.teamName === game.lastName)
      : [];

    // Everyone owes their own lane fee for the game…
    for (const line of lines) line.laneFee += LANE_FEE_PER_GAME;

    // …but last place covers first place's lane fees that game.
    if (
      game.winnerName &&
      game.lastName &&
      game.winnerName !== game.lastName &&
      winners.length &&
      losers.length
    ) {
      const coverTotal = winners.length * LANE_FEE_PER_GAME;
      const payEach = coverTotal / losers.length;
      for (const loser of losers) loser.betPaid += payEach;
      for (const winner of winners) winner.betReceived += LANE_FEE_PER_GAME;
    }
  }

  return lines.map((line) => ({
    ...line,
    laneFee: Math.round(line.laneFee * 100) / 100,
    betPaid: Math.round(line.betPaid * 100) / 100,
    betReceived: Math.round(line.betReceived * 100) / 100,
    netDue:
      Math.round((line.laneFee + line.betPaid - line.betReceived) * 100) / 100,
  }));
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
