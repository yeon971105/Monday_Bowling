export type AverageMode = "AUTO" | "MANUAL" | "FIXED";
export type BalancingMode =
  "RANDOM" | "BALANCED" | "BALANCED_REPEATS" | "MANUAL";
export type SkillTier = "A" | "B" | "C" | "D";

export interface LeagueSettings {
  handicapBase: number;
  handicapPercentage: number;
  handicapRounding: "floor" | "round" | "ceil";
  targetTeamSize: number;
  repeatWindow: number;
}

export interface Player {
  id: number;
  displayName: string;
  leagueName: string | null;
  aliases: string[];
  averageMode: AverageMode;
  leagueAverage: number | null;
  manualAverage: number | null;
  fixedAverage: number | null;
  usedAverage: number | null;
  handicap: number | null;
  projectedHandicapScore: number | null;
  pdfHandicap: number | null;
  games: number | null;
  pins: number | null;
  teamNumber: number | null;
  teamName: string | null;
  active: boolean;
  archived: boolean;
  notes: string;
  scratchPool: boolean;
  updatedAt: string;
}

export interface GeneratorPlayer {
  id: string;
  name: string;
  usedAverage: number;
  averageMode: AverageMode;
  handicap: number;
  projectedScore: number;
  guest?: boolean;
  tier?: SkillTier;
}

export interface TeamMetrics {
  scratchTotal: number;
  handicapTotal: number;
  projectedTotal: number;
  scratchPerPlayer: number;
  projectedPerPlayer: number;
  tierCounts: Record<SkillTier, number>;
}

export interface GeneratedTeam {
  name: string;
  players: GeneratorPlayer[];
  metrics: TeamMetrics;
}

export interface FairnessMetrics {
  score: number;
  scratchLow: number;
  scratchHigh: number;
  scratchSpread: number;
  projectedLow: number;
  projectedHigh: number;
  projectedSpread: number;
  repeatedPairs: number;
  unequalSizes: boolean;
  tierDistribution: Record<SkillTier, number[]>;
}

export interface GenerationResult {
  seed: string;
  teams: GeneratedTeam[];
  fairness: FairnessMetrics;
}

export type PlayerScores = [number | null, number | null, number | null];

export interface SessionTeamResult {
  teamName: string;
  gameTotals: number[];
  scratchTotal: number;
  handicapTotal: number;
  finalTotal: number;
  handicapPerGame: number;
  won: boolean;
}

export interface PlayerStat {
  id: number;
  displayName: string;
  averageMode: AverageMode;
  sessions: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number | null;
  mondayAverage: number | null;
  gamesPlayed: number;
  totalPins: number;
  scratchTickets: number;
  scratchPool: boolean;
  usedAverage: number | null;
  handicapAverage: number | null;
  handicap: number | null;
}

export interface ParsedPdfPlayer {
  printedName: string;
  currentAverage: number | null;
  pdfHandicap: number | null;
  games: number | null;
  pins: number | null;
  teamNumber: number | null;
  teamName: string | null;
  temporarySubstitute: boolean;
  raw: string;
  error?: string;
}

export interface ParsedLeaguePdf {
  leagueName: string | null;
  bowlingCenter: string | null;
  leagueDate: string | null;
  weekNumber: number | null;
  players: ParsedPdfPlayer[];
  errors: string[];
}

export type ScratchLedgerKind =
  "dues" | "ticket" | "payout" | "last_game_fee" | "last_game_ticket";

export type ScratchLedgerEntry = {
  id: number;
  date: string;
  kind: ScratchLedgerKind;
  playerId: number | null;
  playerName: string;
  amount: number;
  sessionId: number | null;
  monthKey: string | null;
  note: string;
  balanceAfter: number;
};

export type ScratchPoolMember = {
  id: number;
  name: string;
};

export type ScratchMoneySnapshot = {
  balance: number;
  duesAmount: number;
  ticketAmount: number;
  duesDay: number;
  today: string;
  nextDuesDate: string;
  nextDuesCount: number;
  nextDuesTotal: number;
  members: ScratchPoolMember[];
  entries: ScratchLedgerEntry[];
};

export type SavedLineup = {
  teams: GenerationResult["teams"];
  savedAt: string;
};
