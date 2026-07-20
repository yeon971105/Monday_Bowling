import type {
  BalancingMode,
  FairnessMetrics,
  GeneratedTeam,
  GenerationResult,
  GeneratorPlayer,
  SkillTier,
  TeamMetrics,
} from "./types";

type PairCounts = Map<string, number>;
const TIERS: SkillTier[] = ["A", "B", "C", "D"];

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function assignSkillTiers(
  players: GeneratorPlayer[],
): GeneratorPlayer[] {
  const ranked = [...players].sort(
    (a, b) => b.usedAverage - a.usedAverage || a.name.localeCompare(b.name),
  );
  const tierById = new Map<string, SkillTier>();
  ranked.forEach((player, index) => {
    tierById.set(
      player.id,
      TIERS[Math.min(3, Math.floor((index * 4) / ranked.length))],
    );
  });
  return players.map((player) => ({
    ...player,
    tier: tierById.get(player.id)!,
  }));
}

function desiredSizes(count: number, teamCount: number): number[] {
  const base = Math.floor(count / teamCount);
  const extra = count % teamCount;
  return Array.from(
    { length: teamCount },
    (_, i) => base + (i < extra ? 1 : 0),
  );
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function teamMetrics(players: GeneratorPlayer[]): TeamMetrics {
  const scratchTotal = players.reduce((sum, p) => sum + p.usedAverage, 0);
  const handicapTotal = players.reduce((sum, p) => sum + p.handicap, 0);
  const projectedTotal = players.reduce((sum, p) => sum + p.projectedScore, 0);
  const divisor = players.length || 1;
  const tierCounts = Object.fromEntries(
    TIERS.map((tier) => [tier, players.filter((p) => p.tier === tier).length]),
  ) as Record<SkillTier, number>;
  return {
    scratchTotal,
    handicapTotal,
    projectedTotal,
    scratchPerPlayer: scratchTotal / divisor,
    projectedPerPlayer: projectedTotal / divisor,
    tierCounts,
  };
}

function repeatCount(teams: GeneratorPlayer[][], pairs: PairCounts): number {
  let count = 0;
  for (const team of teams) {
    for (let i = 0; i < team.length; i++) {
      for (let j = i + 1; j < team.length; j++)
        count += pairs.get(pairKey(team[i].id, team[j].id)) ?? 0;
    }
  }
  return count;
}

export function scoreTeams(
  teams: GeneratorPlayer[][],
  pairs: PairCounts = new Map(),
  includeRepeats = true,
): FairnessMetrics {
  const metrics = teams.map(teamMetrics);
  const sizes = teams.map((team) => team.length);
  const scratch = metrics.map((m) => m.scratchPerPlayer);
  const projected = metrics.map((m) => m.projectedPerPlayer);
  const tierDistribution = Object.fromEntries(
    TIERS.map((tier) => [tier, metrics.map((m) => m.tierCounts[tier])]),
  ) as Record<SkillTier, number[]>;
  const tierSpread = (tier: SkillTier) =>
    Math.max(...tierDistribution[tier]) - Math.min(...tierDistribution[tier]);
  const repeatedPairs = repeatCount(teams, pairs);
  const sizeSpread = Math.max(...sizes) - Math.min(...sizes);
  const scratchSpread = Math.max(...scratch) - Math.min(...scratch);
  const projectedSpread = Math.max(...projected) - Math.min(...projected);
  const score =
    sizeSpread * 100000 +
    Math.max(0, tierSpread("A") - 1) * 20000 +
    Math.max(0, tierSpread("D") - 1) * 16000 +
    Math.max(0, tierSpread("B") - 1) * 7000 +
    Math.max(0, tierSpread("C") - 1) * 7000 +
    tierSpread("A") * 800 +
    tierSpread("D") * 600 +
    scratchSpread * 12 +
    projectedSpread * 7 +
    (includeRepeats ? repeatedPairs * 125 : 0);
  return {
    score: Math.round(score * 10) / 10,
    scratchLow: Math.min(...scratch),
    scratchHigh: Math.max(...scratch),
    scratchSpread,
    projectedLow: Math.min(...projected),
    projectedHigh: Math.max(...projected),
    projectedSpread,
    repeatedPairs,
    unequalSizes: sizeSpread > 0,
    tierDistribution,
  };
}

function stratifiedStart(
  players: GeneratorPlayer[],
  sizes: number[],
  random: () => number,
): GeneratorPlayer[][] {
  const teams = sizes.map(() => [] as GeneratorPlayer[]);
  for (const tier of TIERS) {
    const group = shuffle(
      players.filter((p) => p.tier === tier),
      random,
    );
    let cursor = Math.floor(random() * teams.length);
    let direction = random() < 0.5 ? 1 : -1;
    for (const player of group) {
      let attempts = 0;
      while (teams[cursor].length >= sizes[cursor] && attempts++ < teams.length)
        cursor = (cursor + direction + teams.length) % teams.length;
      teams[cursor].push(player);
      cursor = (cursor + direction + teams.length) % teams.length;
      if (cursor === 0 || cursor === teams.length - 1) direction *= -1;
    }
  }
  const overflow = teams.flatMap((team, i) => team.splice(sizes[i]));
  for (const player of overflow) {
    const index = teams.findIndex((team, i) => team.length < sizes[i]);
    teams[index].push(player);
  }
  return teams;
}

function improve(
  teams: GeneratorPlayer[][],
  pairs: PairCounts,
  includeRepeats: boolean,
  random: () => number,
): GeneratorPlayer[][] {
  let best = teams.map((team) => [...team]);
  let bestScore = scoreTeams(best, pairs, includeRepeats).score;
  for (let iteration = 0; iteration < 500; iteration++) {
    const a = Math.floor(random() * best.length);
    let b = Math.floor(random() * best.length);
    if (a === b) b = (b + 1) % best.length;
    const ai = Math.floor(random() * best[a].length);
    const bi = Math.floor(random() * best[b].length);
    const candidate = best.map((team) => [...team]);
    [candidate[a][ai], candidate[b][bi]] = [candidate[b][bi], candidate[a][ai]];
    const candidateScore = scoreTeams(candidate, pairs, includeRepeats).score;
    if (
      candidateScore < bestScore ||
      (candidateScore === bestScore && random() < 0.08)
    ) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  return best;
}

function diversifyNearOptimal(
  teams: GeneratorPlayer[][],
  pairs: PairCounts,
  includeRepeats: boolean,
  random: () => number,
): GeneratorPlayer[][] {
  let varied = teams.map((team) => [...team]);
  const baseline = scoreTeams(varied, pairs, includeRepeats).score;
  const limit = baseline + Math.max(12, baseline * 0.005);
  // Swap within skill tiers only: this preserves the high/low distribution
  // while offering different teammate combinations for different seeds.
  for (let attempt = 0; attempt < 60; attempt++) {
    const tier = TIERS[Math.floor(random() * TIERS.length)];
    const eligible = varied
      .map((team, teamIndex) => ({
        teamIndex,
        indices: team
          .map((p, index) => (p.tier === tier ? index : -1))
          .filter((index) => index >= 0),
      }))
      .filter((entry) => entry.indices.length > 0);
    if (eligible.length < 2) continue;
    const first = eligible[Math.floor(random() * eligible.length)];
    let second = eligible[Math.floor(random() * eligible.length)];
    if (first.teamIndex === second.teamIndex)
      second = eligible[(eligible.indexOf(second) + 1) % eligible.length];
    const candidate = varied.map((team) => [...team]);
    const firstIndex =
      first.indices[Math.floor(random() * first.indices.length)];
    const secondIndex =
      second.indices[Math.floor(random() * second.indices.length)];
    [
      candidate[first.teamIndex][firstIndex],
      candidate[second.teamIndex][secondIndex],
    ] = [
      candidate[second.teamIndex][secondIndex],
      candidate[first.teamIndex][firstIndex],
    ];
    if (scoreTeams(candidate, pairs, includeRepeats).score <= limit)
      varied = candidate;
  }
  return varied;
}

export function generateTeams(options: {
  players: GeneratorPlayer[];
  teamCount?: number;
  targetTeamSize?: number;
  mode?: BalancingMode;
  seed: string;
  repeatPairs?: Record<string, number>;
}): GenerationResult {
  if (options.players.length < 2)
    throw new Error("Select at least two players");
  const teamCount =
    options.teamCount ??
    Math.max(
      2,
      Math.round(options.players.length / (options.targetTeamSize ?? 3)),
    );
  if (teamCount < 2 || teamCount > options.players.length)
    throw new Error("Team count must be between 2 and the participant count");
  const sizes = desiredSizes(options.players.length, teamCount);
  const players = assignSkillTiers(options.players);
  const pairs = new Map(Object.entries(options.repeatPairs ?? {}));
  const mode = options.mode ?? "BALANCED";
  const random = mulberry32(hashSeed(options.seed));
  let selected: GeneratorPlayer[][];

  if (mode === "RANDOM") {
    const shuffled = shuffle(players, random);
    selected = [];
    let cursor = 0;
    for (const size of sizes)
      selected.push(shuffled.slice(cursor, (cursor += size)));
  } else {
    const candidates: { teams: GeneratorPlayer[][]; score: number }[] = [];
    for (let start = 0; start < 40; start++) {
      const initial = stratifiedStart(players, sizes, random);
      const teams = improve(
        initial,
        pairs,
        mode === "BALANCED_REPEATS",
        random,
      );
      candidates.push({
        teams,
        score: scoreTeams(teams, pairs, mode === "BALANCED_REPEATS").score,
      });
    }
    candidates.sort((a, b) => a.score - b.score);
    // Keep enough equally fair candidates that changing a seed produces a
    // genuinely different reshuffle. Tier and size penalties remain dominant,
    // while this broader window admits small scratch-score tradeoffs.
    const tolerance = Math.max(400, candidates[0].score * 0.2);
    const nearOptimal = candidates
      .filter((candidate) => candidate.score <= candidates[0].score + tolerance)
      .slice(0, 10);
    selected = diversifyNearOptimal(
      nearOptimal[Math.floor(random() * nearOptimal.length)].teams,
      pairs,
      mode === "BALANCED_REPEATS",
      random,
    );
  }

  const fairness = scoreTeams(selected, pairs, mode === "BALANCED_REPEATS");
  const teams: GeneratedTeam[] = selected.map((team, index) => ({
    name: `Team ${index + 1}`,
    players: team,
    metrics: teamMetrics(team),
  }));
  return { seed: options.seed, teams, fairness };
}

export function recalculateTeams(
  teams: GeneratedTeam[],
  repeatPairs: Record<string, number> = {},
): Pick<GenerationResult, "teams" | "fairness"> {
  const normalized = teams.map((team) => ({
    ...team,
    metrics: teamMetrics(team.players),
  }));
  return {
    teams: normalized,
    fairness: scoreTeams(
      normalized.map((team) => team.players),
      new Map(Object.entries(repeatPairs)),
    ),
  };
}

export function buildRepeatPairs(
  sessions: Array<{ teams: Array<{ players: Array<{ id: string }> }> }>,
): Record<string, number> {
  const pairs: Record<string, number> = {};
  for (const session of sessions) {
    for (const team of session.teams) {
      for (let i = 0; i < team.players.length; i++) {
        for (let j = i + 1; j < team.players.length; j++) {
          const key = pairKey(team.players[i].id, team.players[j].id);
          pairs[key] = (pairs[key] ?? 0) + 1;
        }
      }
    }
  }
  return pairs;
}
