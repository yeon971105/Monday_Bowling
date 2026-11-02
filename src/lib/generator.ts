import type {
  BalancingMode,
  FairnessMetrics,
  GeneratedTeam,
  GenerationResult,
  GeneratorPlayer,
  SkillTier,
  TeamMetrics,
} from "./types";

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

export function scoreTeams(teams: GeneratorPlayer[][]): FairnessMetrics {
  const metrics = teams.map(teamMetrics);
  const sizes = teams.map((team) => team.length);
  const scratch = metrics.map((m) => m.scratchPerPlayer);
  const projected = metrics.map((m) => m.projectedPerPlayer);
  const tierDistribution = Object.fromEntries(
    TIERS.map((tier) => [tier, metrics.map((m) => m.tierCounts[tier])]),
  ) as Record<SkillTier, number[]>;
  const tierSpread = (tier: SkillTier) =>
    Math.max(...tierDistribution[tier]) - Math.min(...tierDistribution[tier]);
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
    projectedSpread * 7;
  return {
    score: Math.round(score * 10) / 10,
    scratchLow: Math.min(...scratch),
    scratchHigh: Math.max(...scratch),
    scratchSpread,
    projectedLow: Math.min(...projected),
    projectedHigh: Math.max(...projected),
    projectedSpread,
    repeatedPairs: 0,
    unequalSizes: sizeSpread > 0,
    tierDistribution,
  };
}

const AVERAGE_SPLIT = 160;

/** Shuffle <160 and ≥160 pools, then snake-deal each onto teams. */
function balancedByAverageSplit(
  players: GeneratorPlayer[],
  sizes: number[],
  random: () => number,
): GeneratorPlayer[][] {
  const highs = shuffle(
    players.filter((player) => player.usedAverage >= AVERAGE_SPLIT),
    random,
  );
  const lows = shuffle(
    players.filter((player) => player.usedAverage < AVERAGE_SPLIT),
    random,
  );
  const teams = sizes.map(() => [] as GeneratorPlayer[]);
  const payingCount = players.filter((player) => player.payingMember).length;
  const base = Math.floor(payingCount / teams.length);
  const payingSlots = sizes.map(() => base);
  const extra = payingCount % teams.length;
  if (extra) {
    const eligible = shuffle(
      sizes
        .map((size, index) => ({ size, index }))
        .filter(({ size }) => size > base),
      random,
    );
    for (const { index } of eligible.slice(0, extra)) payingSlots[index]++;
  }
  const payingPlaced = sizes.map(() => 0);
  const canPlace = (index: number, player: GeneratorPlayer) =>
    player.payingMember
      ? payingPlaced[index] < payingSlots[index]
      : teams[index].length - payingPlaced[index] <
        sizes[index] - payingSlots[index];

  const snakeDeal = (pool: GeneratorPlayer[]) => {
    let index = 0;
    let direction = 1;
    for (const player of pool) {
      let attempts = 0;
      while (!canPlace(index, player) && attempts++ < teams.length * 2) {
        index += direction;
        if (index >= teams.length) {
          index = teams.length - 1;
          direction = -1;
        } else if (index < 0) {
          index = 0;
          direction = 1;
        }
      }
      if (!canPlace(index, player)) throw new Error("Cannot place player");
      teams[index].push(player);
      if (player.payingMember) payingPlaced[index]++;
      if (teams.length === 1) continue;
      index += direction;
      if (index >= teams.length) {
        index = teams.length - 1;
        direction = -1;
      } else if (index < 0) {
        index = 0;
        direction = 1;
      }
    }
  };

  snakeDeal(highs);
  snakeDeal(lows);

  return teams;
}

export function generateTeams(options: {
  players: GeneratorPlayer[];
  attendanceCount?: number;
  teamCount?: number;
  targetTeamSize?: number;
  mode?: BalancingMode;
  seed: string;
}): GenerationResult {
  if (options.players.length < 2)
    throw new Error("Select at least two players");
  if (
    options.attendanceCount !== undefined &&
    options.attendanceCount !== options.players.length
  )
    throw new Error(
      "Every checked-in player needs an average before generating teams.",
    );
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
    const lowestAverage = Math.min(
      ...players.map((player) => player.usedAverage),
    );
    const lowestPlayers = players.filter(
      (player) => player.usedAverage === lowestAverage,
    );
    const heldOut =
      players.length % 2 === 1
        ? lowestPlayers[Math.floor(random() * lowestPlayers.length)]
        : undefined;
    const dealPlayers = heldOut
      ? players.filter((player) => player.id !== heldOut.id)
      : players;
    const dealSizes = desiredSizes(dealPlayers.length, teamCount);
    const averageLimit = heldOut ? 120 : 80;
    const candidates: GeneratorPlayer[][][] = [];
    // shortcut: Search at most 1024 deals; use exhaustive search if valid teams are routinely missed.
    for (let attempt = 0; attempt < 1024 && candidates.length < 32; attempt++) {
      const candidate = balancedByAverageSplit(dealPlayers, dealSizes, random);
      const totals = candidate.map((team) =>
        team.reduce((sum, player) => sum + player.usedAverage, 0),
      );
      if (Math.max(...totals) - Math.min(...totals) >= averageLimit) continue;
      if (heldOut) {
        const lowestTotal = Math.min(...totals);
        const weakest = totals
          .map((sum, index) => ({ sum, index }))
          .filter(({ sum }) => sum === lowestTotal);
        const index = weakest[Math.floor(random() * weakest.length)].index;
        candidate[index].push(heldOut);
        const finalSizes = candidate.map((team) => team.length);
        const payingCounts = candidate.map(
          (team) => team.filter((player) => player.payingMember).length,
        );
        if (
          Math.max(...finalSizes) - Math.min(...finalSizes) > 1 ||
          Math.max(...payingCounts) - Math.min(...payingCounts) > 1
        )
          continue;
      }
      candidates.push(candidate);
    }
    if (!candidates.length)
      throw new Error(
        `No teams found with balanced sizes and paying members and an average-total gap below ${averageLimit}${heldOut ? " before adding the lowest-average player" : ""} in 1024 shuffles. Shuffle again or use manual teams.`,
      );
    selected = candidates[Math.floor(random() * candidates.length)];
  }

  const fairness = scoreTeams(selected);
  const teams: GeneratedTeam[] = selected.map((team, index) => ({
    name: `Team ${index + 1}`,
    players: team,
    metrics: teamMetrics(team),
  }));
  return { seed: options.seed, teams, fairness };
}

export function recalculateTeams(
  teams: GeneratedTeam[],
): Pick<GenerationResult, "teams" | "fairness"> {
  const normalized = teams.map((team) => ({
    ...team,
    metrics: teamMetrics(team.players),
  }));
  return {
    teams: normalized,
    fairness: scoreTeams(normalized.map((team) => team.players)),
  };
}
