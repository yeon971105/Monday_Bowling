"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildStoredGameResults,
  clampGameIndex,
  computeGameResult,
  computeLiveStandings,
  computeScratchWinners,
  computeSeriesResults,
  emptyScores,
  GAMES_PER_SESSION,
  MAX_TEAMS,
  MIN_TEAMS,
  nextGameIndex,
  playerSeriesTotal,
  toSessionTeamResults,
  type MoneyTeam,
  type ScoreMap,
  type ScratchWinner,
  type TeamForScoring,
} from "@/lib/scoring";
import { recalculateTeams, teamMetrics } from "@/lib/generator";
import type {
  BalancingMode,
  GenerationResult,
  GeneratorPlayer,
  Player,
  PlayerStat,
  ScratchLedgerEntry,
  ScratchMoneySnapshot,
  SessionTeamResult,
} from "@/lib/types";

type Tab = "play" | "club" | "history";
type PlayStep = "setup" | "game" | "reset" | "summary";

const toMoneyTeams = (
  teams: GenerationResult["teams"],
): MoneyTeam[] =>
  teams.map((team) => ({
    name: team.name,
    averageSum: team.players.reduce(
      (sum, player) => sum + player.usedAverage,
      0,
    ),
    players: team.players.map((player) => ({
      id: String(player.id),
      name: player.name,
    })),
  }));

type SyncResult = {
  ok: boolean;
  skipped: boolean;
  reason: string | null;
  weekNumber: number | null;
  leagueDate: string | null;
  updated: number;
  historyAveragesUpdated?: number;
  historyUnlocked?: number;
  notFound: Array<{ id: number; displayName: string }>;
};

type LeagueOption = {
  printedName: string;
  currentAverage: number | null;
  teamName: string | null;
};

type SavedSession = {
  id: number;
  sessionDate: string;
  mode: string;
  teamCount: number;
  finalTeams: GenerationResult["teams"];
  attendees?: Array<{ id?: string | number; name?: string }>;
  scores: ScoreMap;
  results: SessionTeamResult[];
  lotteryIds?: Array<string | number>;
  scratchWinners?: ScratchWinner[];
  gameCount: number;
};

const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
};

const fmt = (value: number | null | undefined, digits = 0) =>
  value == null ? "—" : value.toFixed(digits);

function ScratchMark({ on }: { on?: boolean }) {
  if (!on) return null;
  return (
    <span className="scratch-mark" title="Club member" aria-label="Club member">
      S
    </span>
  );
}

function NameWithScratch({ name, on }: { name: string; on?: boolean }) {
  return (
    <span className="roster-name-line">
      <strong>{name}</strong>
      <ScratchMark on={on} />
    </span>
  );
}

const newSeed = () => crypto.getRandomValues(new Uint32Array(3)).join("-");

const localDateInputValue = (now = new Date()) => {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

const NIGHT_DRAFT_KEY = "monday-bowling-night-draft-v1";

type NightDraft = {
  v: 1;
  step: PlayStep;
  gameIndex: number;
  gameCount: number;
  date: string;
  mode: BalancingMode;
  teamCount: number;
  seed: string;
  selected: number[];
  lotteryIds: number[];
  result: GenerationResult;
  teamsByGame: Array<GenerationResult["teams"] | null>;
  scores: ScoreMap;
  scratchWinners: ScratchWinner[];
  savedOnce: boolean;
};

const readNightDraft = (): NightDraft | null => {
  try {
    const raw = localStorage.getItem(NIGHT_DRAFT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as NightDraft;
    if (data?.v !== 1 || !data.result?.teams?.length) return null;
    return data;
  } catch {
    return null;
  }
};

const writeNightDraft = (draft: NightDraft) => {
  try {
    localStorage.setItem(NIGHT_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* ignore quota / private mode */
  }
};

const clearNightDraft = () => {
  try {
    localStorage.removeItem(NIGHT_DRAFT_KEY);
  } catch {
    /* ignore */
  }
};

function blurActiveInput() {
  const el = document.activeElement;
  if (el instanceof HTMLElement) el.blur();
}

function syncBannerText(result: SyncResult): string {
  const week = result.weekNumber ? `Week ${result.weekNumber}` : "Latest sheet";
  const extras: string[] = [];
  if (result.historyUnlocked)
    extras.push(
      `unlocked ${result.historyUnlocked} guest avg${result.historyUnlocked === 1 ? "" : "s"}`,
    );
  if (
    (result.historyAveragesUpdated ?? 0) >
    (result.historyUnlocked ?? 0)
  )
    extras.push(
      `history avg ×${(result.historyAveragesUpdated ?? 0) - (result.historyUnlocked ?? 0)}`,
    );
  const suffix = extras.length ? ` · ${extras.join(", ")}` : "";
  if (result.skipped && !(result.historyAveragesUpdated ?? 0))
    return `${week} already up to date.`;
  if (result.skipped)
    return `${week} sheet unchanged${suffix}.`;
  return `${week}: updated ${result.updated} Monday member average${result.updated === 1 ? "" : "s"}${suffix}.`;
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("play");
  const [refreshKey, setRefreshKey] = useState(0);
  const [syncStatus, setSyncStatus] = useState<SyncResult | null>(null);
  const [syncError, setSyncError] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const syncStarted = useRef(false);
  const refresh = () => setRefreshKey((key) => key + 1);

  const runSync = useCallback(async () => {
    setSyncBusy(true);
    setSyncError("");
    try {
      const result = await api<SyncResult>("/api/sync/league", {
        method: "POST",
      });
      setSyncStatus(result);
      if (result.updated || result.historyAveragesUpdated) refresh();
      return result;
    } catch (error: any) {
      setSyncError(error.message);
      throw error;
    } finally {
      setSyncBusy(false);
    }
  }, []);

  useEffect(() => {
    if (syncStarted.current) return;
    syncStarted.current = true;
    runSync().catch(() => undefined);
  }, [runSync]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="ball" />
          <div>
            <h1>San Jose Korean Bowling</h1>
            <small>Play · Club · History</small>
          </div>
        </div>
        <nav className="nav">
          <button
            className={tab === "play" ? "active" : ""}
            onClick={() => setTab("play")}
          >
            Play
          </button>
          <button
            className={tab === "club" ? "active" : ""}
            onClick={() => setTab("club")}
          >
            Club
          </button>
          <button
            className={tab === "history" ? "active" : ""}
            onClick={() => setTab("history")}
          >
            History
          </button>
        </nav>
      </header>
      <main className="main">
        {(syncBusy || syncStatus || syncError) && (
          <div
            className={`notice ${syncError ? "error" : syncStatus && !syncStatus.skipped && syncStatus.updated ? "success" : ""}`}
          >
            {syncBusy
              ? "Syncing Ohana averages from 4th Street…"
              : syncError
                ? `Sync failed: ${syncError}`
                : syncStatus
                  ? syncBannerText(syncStatus)
                  : null}
          </div>
        )}
        <div hidden={tab !== "play"}>
          <PlayTab
            refreshKey={refreshKey}
            syncBusy={syncBusy}
            onSync={runSync}
            onSaved={refresh}
          />
        </div>
        <div hidden={tab !== "club"}>
          <ClubTab refreshKey={refreshKey} onChanged={refresh} />
        </div>
        <div hidden={tab !== "history"}>
          <HistoryTab refreshKey={refreshKey} onChanged={refresh} />
        </div>
      </main>
    </div>
  );
}

function PlayTab({
  refreshKey,
  syncBusy,
  onSync,
  onSaved,
}: {
  refreshKey: number;
  syncBusy: boolean;
  onSync: () => Promise<unknown>;
  onSaved: () => void;
}) {
  const [step, setStep] = useState<PlayStep>("setup");
  const [gameIndex, setGameIndex] = useState(0);
  const [gameCount, setGameCount] = useState(GAMES_PER_SESSION);
  const [players, setPlayers] = useState<Player[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [teamCount, setTeamCount] = useState(2);
  const [mode, setMode] = useState<BalancingMode>("BALANCED");
  const [date, setDate] = useState(localDateInputValue);
  const [seed, setSeed] = useState(newSeed());
  const [result, setResult] = useState<GenerationResult>();
  const [teamsByGame, setTeamsByGame] = useState<
    Array<GenerationResult["teams"] | null>
  >([null, null, null]);
  const [resetTargetGame, setResetTargetGame] = useState(0);
  const [scores, setScores] = useState<ScoreMap>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [leagueOptions, setLeagueOptions] = useState<LeagueOption[]>([]);
  const [pickLeague, setPickLeague] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualAvg, setManualAvg] = useState("");
  const [avgDraft, setAvgDraft] = useState<Record<number, string>>({});
  const [rosterSort, setRosterSort] = useState<"avg-desc" | "avg-asc" | "name">(
    "avg-desc",
  );
  const [rosterEditing, setRosterEditing] = useState(false);
  const [removeIds, setRemoveIds] = useState<Set<number>>(new Set());
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateFromReset, setGenerateFromReset] = useState(false);
  const [generateReshuffle, setGenerateReshuffle] = useState(false);
  const [gameEditing, setGameEditing] = useState(false);
  const [addToTeamName, setAddToTeamName] = useState<string | null>(null);
  const [teamGuestName, setTeamGuestName] = useState("");
  const [teamGuestAvg, setTeamGuestAvg] = useState("");
  const [scratchWinners, setScratchWinners] = useState<ScratchWinner[]>([]);
  const [savedOnce, setSavedOnce] = useState(false);
  const draftReady = useRef(false);
  const skipNextDraftSave = useRef(false);

  const scratchIds = useMemo(
    () =>
      new Set(
        players.filter((player) => player.scratchPool).map((player) => player.id),
      ),
    [players],
  );

  const load = useCallback(async () => {
    const data = await api<{ players: Player[] }>("/api/players");
    const roster = data.players.filter(
      (player) => player.active && !player.archived,
    );
    setPlayers(roster);
    setAvgDraft(
      Object.fromEntries(
        roster.map((player) => [
          player.id,
          player.usedAverage != null ? String(player.usedAverage) : "",
        ]),
      ),
    );
    setSelected((prev) => (prev.size ? prev : new Set()));
    const available = await api<{ players: LeagueOption[] }>(
      "/api/league/available",
    );
    setLeagueOptions(available.players);
  }, []);

  useEffect(() => {
    load().catch((error) => setMessage(error.message));
  }, [load, refreshKey]);

  useEffect(() => {
    if (draftReady.current) return;
    draftReady.current = true;
    const draft = readNightDraft();
    if (!draft) return;
    skipNextDraftSave.current = true;
    setStep(draft.step === "reset" ? "game" : draft.step);
    setGameIndex(clampGameIndex(draft.gameIndex));
    setGameCount(draft.gameCount);
    setDate(draft.date);
    setMode(draft.mode);
    setTeamCount(draft.teamCount);
    setSeed(draft.seed);
    setSelected(new Set(draft.selected));
    setResult(draft.result);
    setTeamsByGame(draft.teamsByGame);
    setScores(draft.scores);
    setScratchWinners(draft.scratchWinners ?? []);
    setSavedOnce(Boolean(draft.savedOnce));
    setMessage("Restored your in-progress night.");
  }, []);

  useEffect(() => {
    const next = clampGameIndex(gameIndex);
    if (next !== gameIndex) setGameIndex(next);
  }, [gameIndex]);

  useEffect(() => {
    if (!draftReady.current) return;
    if (skipNextDraftSave.current) {
      skipNextDraftSave.current = false;
      return;
    }
    if (!result || (step !== "game" && step !== "summary" && step !== "reset"))
      return;
    const handle = window.setTimeout(() => {
      writeNightDraft({
        v: 1,
        step,
        gameIndex,
        gameCount,
        date,
        mode,
        teamCount,
        seed,
        selected: [...selected],
        lotteryIds: [...scratchIds],
        result,
        teamsByGame,
        scores,
        scratchWinners,
        savedOnce,
      });
    }, 250);
    return () => window.clearTimeout(handle);
  }, [
    step,
    gameIndex,
    gameCount,
    date,
    mode,
    teamCount,
    seed,
    selected,
    scratchIds,
    result,
    teamsByGame,
    scores,
    scratchWinners,
    savedOnce,
  ]);

  useEffect(() => {
    const flush = () => {
      if (!result || (step !== "game" && step !== "summary" && step !== "reset"))
        return;
      writeNightDraft({
        v: 1,
        step,
        gameIndex,
        gameCount,
        date,
        mode,
        teamCount,
        seed,
        selected: [...selected],
        lotteryIds: [...scratchIds],
        result,
        teamsByGame,
        scores,
        scratchWinners,
        savedOnce,
      });
    };
    window.addEventListener("pagehide", flush);
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("visibilitychange", onVis);
    };
  }, [
    step,
    gameIndex,
    gameCount,
    date,
    mode,
    teamCount,
    seed,
    selected,
    scratchIds,
    result,
    teamsByGame,
    scores,
    scratchWinners,
    savedOnce,
  ]);

  const attendees = useMemo(
    () =>
      players.filter(
        (player) => selected.has(player.id) && player.usedAverage != null,
      ),
    [players, selected],
  );

  const sortedPlayers = useMemo(() => {
    const draftAvg = (player: Player) => {
      const raw = avgDraft[player.id];
      if (raw !== undefined && raw !== "") {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) return parsed;
      }
      return player.usedAverage;
    };
    const rows = [...players];
    rows.sort((a, b) => {
      if (rosterSort === "name")
        return a.displayName.localeCompare(b.displayName, undefined, {
          sensitivity: "base",
        });
      const avgA = draftAvg(a);
      const avgB = draftAvg(b);
      if (avgA == null && avgB == null)
        return a.displayName.localeCompare(b.displayName, undefined, {
          sensitivity: "base",
        });
      if (avgA == null) return 1;
      if (avgB == null) return -1;
      const diff = rosterSort === "avg-asc" ? avgA - avgB : avgB - avgA;
      if (diff !== 0) return diff;
      return a.displayName.localeCompare(b.displayName, undefined, {
        sensitivity: "base",
      });
    });
    return rows;
  }, [players, avgDraft, rosterSort]);

  const participants = useMemo<GeneratorPlayer[]>(
    () =>
      attendees.map((player) => ({
        id: String(player.id),
        name: player.displayName,
        usedAverage: player.usedAverage!,
        averageMode: player.averageMode,
        handicap: player.handicap ?? 0,
        projectedScore: player.projectedHandicapScore ?? player.usedAverage!,
      })),
    [attendees],
  );

  const scoringTeams = useMemo<TeamForScoring[]>(() => {
    if (!result) return [];
    return result.teams.map((team) => ({
      name: team.name,
      // Always string keys — matches ScoreMap / input onChange.
      playerIds: team.players.map((player) => String(player.id)),
      averageSum: team.players.reduce(
        (sum, player) => sum + player.usedAverage,
        0,
      ),
    }));
  }, [result]);

  const gameResult = useMemo(() => {
    if (!scoringTeams.length) return null;
    return computeGameResult({
      teams: scoringTeams,
      scores,
      gameIndex: clampGameIndex(gameIndex),
    });
  }, [scoringTeams, scores, gameIndex]);

  const liveStandings = useMemo(
    () =>
      gameResult ? computeLiveStandings(gameResult.teams) : [],
    [gameResult],
  );

  const seriesResults = useMemo(() => {
    if (!scoringTeams.length) return [];
    return computeSeriesResults({
      teams: scoringTeams,
      scores,
      gameCount,
    });
  }, [scoringTeams, scores, gameCount]);

  const skipGameCount = gameResult?.complete
    ? clampGameIndex(gameIndex) + 1
    : clampGameIndex(gameIndex);

  const scoresNeeded = useMemo(() => {
    if (!result) return [];
    return result.teams.flatMap((team) =>
      team.players
        .filter((player) => {
          const value = scores[String(player.id)]?.[gameIndex];
          return typeof value !== "number" || !Number.isFinite(value);
        })
        .map((player) => player.name),
    );
  }, [result, scores, gameIndex]);

  const nightHasScores = useMemo(
    () =>
      Object.values(scores).some((games) =>
        games.some((value) => typeof value === "number" && Number.isFinite(value)),
      ),
    [scores],
  );

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const lockAverage = async (player: Player) => {
    const value = Number(avgDraft[player.id]);
    if (!Number.isFinite(value) || value < 0 || value > 300) {
      setMessage("Average must be between 0 and 300.");
      return;
    }
    setBusy(true);
    try {
      const updated = await api<Player>(`/api/players/${player.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...player,
          averageMode: "FIXED",
          fixedAverage: value,
          leagueAverage: player.leagueAverage,
          manualAverage: player.manualAverage,
        }),
      });
      setPlayers((prev) =>
        prev.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
      setAvgDraft((prev) => ({ ...prev, [updated.id]: String(value) }));
      setMessage(`${updated.displayName} average locked at ${value}.`);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const unlockAverage = async (player: Player) => {
    setBusy(true);
    try {
      const current =
        Number(avgDraft[player.id]) ||
        player.fixedAverage ||
        player.usedAverage;
      const nextMode =
        player.leagueAverage != null ? "AUTO" : ("MANUAL" as const);
      const updated = await api<Player>(`/api/players/${player.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...player,
          averageMode: nextMode,
          fixedAverage: null,
          manualAverage:
            nextMode === "MANUAL"
              ? current
              : player.manualAverage,
          leagueAverage: player.leagueAverage,
        }),
      });
      setPlayers((prev) =>
        prev.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
      setAvgDraft((prev) => ({
        ...prev,
        [updated.id]:
          updated.usedAverage != null ? String(updated.usedAverage) : "",
      }));
      setMessage(`${updated.displayName} average unlocked.`);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const removePlayer = async (player: Player) => {
    await api(`/api/players/${player.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmName: player.displayName }),
    });
    setPlayers((prev) => prev.filter((entry) => entry.id !== player.id));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(player.id);
      return next;
    });
    setAvgDraft((prev) => {
      const next = { ...prev };
      delete next[player.id];
      return next;
    });
  };

  const removeSelectedPlayers = async () => {
    const targets = players.filter((player) => removeIds.has(player.id));
    if (!targets.length) return;
    const label =
      targets.length === 1
        ? targets[0].displayName
        : `${targets.length} players`;
    if (
      !confirm(`Remove ${label} from the roster? This cannot be undone.`)
    )
      return;
    setBusy(true);
    setMessage("");
    try {
      for (const player of targets) await removePlayer(player);
      setRemoveIds(new Set());
      setMessage(
        targets.length === 1
          ? `${targets[0].displayName} removed.`
          : `${targets.length} players removed.`,
      );
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const enterRosterEdit = () => {
    setRemoveIds(new Set());
    setRosterEditing(true);
  };

  const exitRosterEdit = () => {
    setRemoveIds(new Set());
    setRosterEditing(false);
  };

  const toggleRemove = (id: number) => {
    setRemoveIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const generate = async (
    nextMode: BalancingMode,
    options?: {
      keepScores?: boolean;
      stayOnGame?: boolean;
      forGameIndex?: number;
      fromReset?: boolean;
      reshuffle?: boolean;
      playersOverride?: GeneratorPlayer[];
    },
  ) => {
    setBusy(true);
    setMessage("");
    try {
      const playerList = options?.playersOverride ?? participants;
      if (playerList.length < teamCount)
        throw new Error(`Select at least ${teamCount} players with averages`);
      const nextSeed = newSeed();
      setSeed(nextSeed);
      setMode(nextMode);
      const data = await api<GenerationResult>("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          players: playerList,
          teamCount,
          mode: nextMode,
          seed: nextSeed,
        }),
      });
      setResult(data);
      const targetGame = options?.forGameIndex ?? gameIndex;
      if (options?.reshuffle) {
        const ids = data.teams.flatMap((team) =>
          team.players.map((player) => String(player.id)),
        );
        setScores((prev) => {
          const next = { ...prev };
          for (const id of ids) {
            if (!next[id]) next[id] = [null, null, null];
          }
          return next;
        });
        setTeamsByGame((prev) => {
          const next = [...prev] as Array<GenerationResult["teams"] | null>;
          next[targetGame] = data.teams;
          return next;
        });
        setStep("game");
        setGameEditing(false);
        setMessage("Teams shuffled.");
      } else if (options?.fromReset || options?.keepScores) {
        const ids = data.teams.flatMap((team) =>
          team.players.map((player) => String(player.id)),
        );
        setScores((prev) => {
          const next = { ...prev };
          for (const id of ids) {
            if (!next[id]) next[id] = [null, null, null];
            else {
              const copy = [...next[id]] as ScoreMap[string];
              copy[targetGame] = null;
              next[id] = copy;
            }
          }
          return next;
        });
        setTeamsByGame((prev) => {
          const next = [...prev] as Array<GenerationResult["teams"] | null>;
          next[targetGame] = data.teams;
          return next;
        });
        setGameIndex(targetGame);
        setStep("game");
        setGameEditing(false);
        setMessage(
          options?.fromReset
            ? `Ready for Game ${targetGame + 1}.`
            : "Teams updated.",
        );
      } else {
        setScores(
          emptyScores(
            data.teams.flatMap((team) =>
              team.players.map((p) => String(p.id)),
            ),
          ),
        );
        setTeamsByGame([data.teams, null, null]);
        setGameIndex(0);
        setGameCount(GAMES_PER_SESSION);
        setSavedOnce(false);
        setScratchWinners([]);
        setGameEditing(false);
        if (!options?.stayOnGame) setStep("game");
        setMessage("");
      }
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const patchResultTeams = (
    nextTeams: GenerationResult["teams"],
  ) => {
    const recalculated = recalculateTeams(nextTeams);
    setResult((prev) =>
      prev
        ? { ...prev, teams: recalculated.teams, fairness: recalculated.fairness }
        : prev,
    );
    setTeamsByGame((prev) => {
      const next = [...prev] as Array<GenerationResult["teams"] | null>;
      next[gameIndex] = recalculated.teams;
      return next;
    });
    if (recalculated.teams.length >= MIN_TEAMS)
      setTeamCount(recalculated.teams.length);
  };

  const addTeam = () => {
    if (!result) return;
    if (result.teams.length >= MAX_TEAMS) {
      setMessage(`Max ${MAX_TEAMS} teams.`);
      return;
    }
    const used = new Set(result.teams.map((team) => team.name));
    let number = result.teams.length + 1;
    while (used.has(`Team ${number}`)) number += 1;
    const name = `Team ${number}`;
    patchResultTeams([
      ...result.teams,
      { name, players: [], metrics: teamMetrics([]) },
    ]);
    setAddToTeamName(name);
    setMessage(`${name} added — add players.`);
  };

  const removeTeam = (teamName: string) => {
    if (!result) return;
    if (result.teams.length <= MIN_TEAMS) {
      setMessage("Need at least two teams.");
      return;
    }
    const team = result.teams.find((entry) => entry.name === teamName);
    if (
      team?.players.length &&
      !confirm(`Remove ${teamName} and its ${team.players.length} player(s) from this game?`)
    )
      return;
    patchResultTeams(result.teams.filter((entry) => entry.name !== teamName));
    if (addToTeamName === teamName) setAddToTeamName(null);
    setMessage(`${teamName} removed.`);
  };

  const removeFromTeam = (teamName: string, playerId: string) => {
    if (!result) return;
    const team = result.teams.find((entry) => entry.name === teamName);
    if (!team) return;
    const nextTeams = result.teams.map((entry) =>
      entry.name !== teamName
        ? entry
        : {
            ...entry,
            players: entry.players.filter(
              (player) => String(player.id) !== playerId,
            ),
          },
    );
    patchResultTeams(nextTeams);
  };

  const addToTeam = (teamName: string, player: Player) => {
    if (!result || player.usedAverage == null) return;
    const already = result.teams.some((team) =>
      team.players.some((member) => String(member.id) === String(player.id)),
    );
    if (already) {
      setMessage(`${player.displayName} is already on a team.`);
      return;
    }
    const member: GeneratorPlayer = {
      id: String(player.id),
      name: player.displayName,
      usedAverage: player.usedAverage,
      averageMode: player.averageMode,
      handicap: player.handicap ?? 0,
      projectedScore: player.projectedHandicapScore ?? player.usedAverage,
    };
    const nextTeams = result.teams.map((entry) =>
      entry.name !== teamName
        ? entry
        : { ...entry, players: [...entry.players, member] },
    );
    setScores((prev) => ({
      ...prev,
      [member.id]: prev[member.id] ?? [null, null, null],
    }));
    setSelected((prev) => new Set(prev).add(player.id));
    patchResultTeams(nextTeams);
    setAddToTeamName(null);
  };

  const setTeamPlayerAverage = (
    teamName: string,
    playerId: string,
    raw: string,
  ) => {
    if (!result || raw.trim() === "") return;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 300) return;
    const nextTeams = result.teams.map((entry) =>
      entry.name !== teamName
        ? entry
        : {
            ...entry,
            players: entry.players.map((player) =>
              String(player.id) !== playerId
                ? player
                : {
                    ...player,
                    usedAverage: value,
                    projectedScore: value + (player.handicap || 0),
                  },
            ),
          },
    );
    const numericId = Number(playerId);
    if (Number.isFinite(numericId)) {
      setAvgDraft((prev) => ({ ...prev, [numericId]: String(value) }));
    }
    patchResultTeams(nextTeams);
  };

  const availableToAdd = useMemo(() => {
    if (!result) return [];
    const onTeams = new Set(
      result.teams.flatMap((team) =>
        team.players.map((player) => String(player.id)),
      ),
    );
    return players.filter(
      (player) =>
        player.usedAverage != null && !onTeams.has(String(player.id)),
    );
  }, [players, result]);

  const currentNightPlayers = useMemo(() => {
    if (!result) return participants;
    return result.teams.flatMap((team) => team.players);
  }, [result, participants]);

  const snapshotCurrentTeams = (index = gameIndex) => {
    if (!result) return;
    setTeamsByGame((prev) => {
      const next = [...prev] as Array<GenerationResult["teams"] | null>;
      next[index] = result.teams;
      return next;
    });
  };

  const goNextGame = () => {
    if (!gameResult?.complete) return;
    const nextIndex = nextGameIndex(gameIndex);
    if (nextIndex == null) return;
    blurActiveInput();
    snapshotCurrentTeams(gameIndex);
    setGameIndex(nextIndex);
  };

  const goPreviousGame = () => {
    if (gameIndex <= 0) return;
    blurActiveInput();
    setGameIndex(clampGameIndex(gameIndex - 1));
  };

  const setScore = (playerId: string, value: string) => {
    const id = String(playerId);
    const index = clampGameIndex(gameIndex);
    setScores((prev) => {
      const current = [...(prev[id] ?? [null, null, null])] as [
        number | null,
        number | null,
        number | null,
      ];
      current[index] =
        value === "" ? null : Math.max(0, Math.min(300, Number(value) || 0));
      return { ...prev, [id]: current };
    });
  };

  const finishNight = async (playedGames = gameCount) => {
    if (!result) return;
    setBusy(true);
    setMessage("");
    try {
      const count = Math.max(1, Math.min(GAMES_PER_SESSION, playedGames));
      const clearedScores: ScoreMap = {};
      for (const [playerId, games] of Object.entries(scores)) {
        const copy = [...games] as ScoreMap[string];
        for (let index = count; index < GAMES_PER_SESSION; index += 1) {
          copy[index] = null;
        }
        clearedScores[playerId] = copy;
      }
      setScores(clearedScores);
      setGameCount(count);

      const rosters = [...teamsByGame] as Array<
        GenerationResult["teams"] | null
      >;
      rosters[gameIndex] = result.teams;
      for (let i = 0; i < count; i += 1) {
        if (!rosters[i]) rosters[i] = result.teams;
      }
      setTeamsByGame(rosters);

      const moneyTeamsByGame = rosters
        .slice(0, count)
        .map((teams) => (teams ? toMoneyTeams(teams) : null));
      const series = computeSeriesResults({
        teams: scoringTeams,
        scores: clearedScores,
        gameCount: count,
      });
      const sessionResults = toSessionTeamResults(series);
      const gameResults = buildStoredGameResults({
        teamsByGame: moneyTeamsByGame,
        scores: clearedScores,
        gameCount: count,
      });
      const nightPlayers = Array.from(
        new Map(
          moneyTeamsByGame.flatMap((teams) =>
            (teams ?? []).flatMap((team) =>
              team.players.map((player) => [
                String(player.id),
                { id: String(player.id), name: player.name },
              ]),
            ),
          ),
        ).values(),
      );
      const winners = computeScratchWinners({
        games: gameResults,
        players: nightPlayers,
        lotteryIds: scratchIds,
      });
      setScratchWinners(winners);
      if (!savedOnce) {
        await api("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionDate: date,
            mode,
            targetTeamSize: Math.ceil(participants.length / teamCount),
            seed,
            attendees: participants,
            teams: result.teams,
            generatedTeams: result.teams,
            fairness: result.fairness,
            scores: clearedScores,
            results: sessionResults,
            gameRosters: rosters.slice(0, count),
            gameResults,
            lotteryIds: [...scratchIds],
            scratchWinners: winners,
            gameCount: count,
          }),
        });
        setSavedOnce(true);
        onSaved();
      }
      setStep("summary");
      setMessage("Night saved to History.");
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const skipRest = () => {
    const count = skipGameCount;
    if (count < 1) {
      setMessage("Finish at least one game before skipping the rest.");
      return;
    }
    if (
      !confirm(
        count === 1
          ? "Skip remaining games and finish after Game 1?"
          : `Skip remaining games and finish after Game ${count}?`,
      )
    )
      return;
    void finishNight(count);
  };

  const addFromLeague = async () => {
    if (!pickLeague) return;
    setBusy(true);
    try {
      await api("/api/players/from-league", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printedName: pickLeague }),
      });
      setPickLeague("");
      setAddOpen(false);
      await load();
      onSaved();
      setMessage(`${pickLeague} added from Ohana sheet.`);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const addManual = async () => {
    const name = manualName.trim();
    const average = Number(manualAvg);
    if (!name || !Number.isFinite(average)) {
      setMessage("Enter a name and average for non-league players.");
      return;
    }
    setBusy(true);
    try {
      const created = await api<Player>("/api/players", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: name,
          averageMode: "MANUAL",
          manualAverage: average,
          active: true,
        }),
      });
      setManualName("");
      setManualAvg("");
      setAddOpen(false);
      await load();
      setSelected((prev) => new Set(prev).add(created.id));
      onSaved();
      setMessage(`${name} added with MANUAL average ${average}.`);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const createGuestForTeam = async () => {
    if (!addToTeamName) return;
    const name = teamGuestName.trim();
    const average = Number(teamGuestAvg);
    if (!name || !Number.isFinite(average) || average < 0 || average > 300) {
      setMessage("Enter a name and average (0–300).");
      return;
    }
    setBusy(true);
    try {
      const created = await api<Player>("/api/players", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: name,
          averageMode: "MANUAL",
          manualAverage: average,
          active: true,
        }),
      });
      setTeamGuestName("");
      setTeamGuestAvg("");
      await load();
      addToTeam(addToTeamName, created);
      onSaved();
      setMessage(`${name} added to ${addToTeamName}.`);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const resetToSetup = () => {
    clearNightDraft();
    setStep("setup");
    setResult(undefined);
    setScores({});
    setTeamsByGame([null, null, null]);
    setGameIndex(0);
    setGameCount(GAMES_PER_SESSION);
    setScratchWinners([]);
    setSavedOnce(false);
    setGameEditing(false);
    setAddToTeamName(null);
    setTeamGuestName("");
    setTeamGuestAvg("");
    setGenerateReshuffle(false);
    setMessage("");
  };

  const leaveGameToSetup = () => {
    if (
      nightHasScores &&
      !window.confirm(
        "Back to setup? Tonight’s scores are not in History yet and will be lost.",
      )
    )
      return;
    resetToSetup();
  };

  return (
    <>
      {message && (
        <div
          className={`notice ${
            message.includes("saved") ||
            message.includes("added") ||
            message.includes("locked") ||
            message.includes("Restored") ||
            message.includes("reshuffled") ||
            message.includes("shuffled") ||
            message.includes("Ready for") ||
            message.includes("Night") ||
            message.includes("removed")
              ? "success"
              : "error"
          }`}
        >
          {message}
        </div>
      )}

      {step === "setup" && (
        <>
          <div className="page-title">
            <div>
              <h2>Play — Setup</h2>
              <p>Check who’s bowling.</p>
            </div>
            <div className="actions">
              <span className="badge selected-count">{selected.size} selected</span>
              <button
                className="button secondary"
                disabled={syncBusy || busy}
                onClick={() => onSync().catch(() => undefined)}
              >
                {syncBusy ? "Syncing…" : "Sync"}
              </button>
            </div>
          </div>

          <div className="card">
            <div className="play-controls">
              <div>
                <span className="label">Teams</span>
                <div className="segmented">
                  <button
                    className={teamCount === 2 ? "active" : ""}
                    onClick={() => setTeamCount(2)}
                  >
                    2 teams
                  </button>
                  <button
                    className={teamCount === 3 ? "active" : ""}
                    onClick={() => setTeamCount(3)}
                  >
                    3 teams
                  </button>
                </div>
              </div>
              <label className="field" style={{ minWidth: 160 }}>
                Date
                <input
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="page-title" style={{ marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>Who’s bowling</h3>
              <div className="actions">
                <label className="sort-field">
                  Sort
                  <select
                    value={rosterSort}
                    onChange={(event) =>
                      setRosterSort(
                        event.target.value as "avg-desc" | "avg-asc" | "name",
                      )
                    }
                  >
                    <option value="avg-desc">Avg high → low</option>
                    <option value="avg-asc">Avg low → high</option>
                    <option value="name">Name A → Z</option>
                  </select>
                </label>
                {rosterEditing ? (
                  <>
                    <button
                      className="button small secondary"
                      onClick={() => setAddOpen(true)}
                    >
                      + Add
                    </button>
                    <button
                      className="button small secondary"
                      disabled={busy || removeIds.size === 0}
                      onClick={() => void removeSelectedPlayers()}
                    >
                      Remove{removeIds.size ? ` (${removeIds.size})` : ""}
                    </button>
                    <button
                      className="button small"
                      onClick={exitRosterEdit}
                    >
                      Done
                    </button>
                  </>
                ) : (
                  <button
                    className="button small secondary"
                    onClick={enterRosterEdit}
                  >
                    Edit
                  </button>
                )}
              </div>
            </div>
            {rosterEditing ? (
              <p className="muted" style={{ marginTop: -4, marginBottom: 8 }}>
                Check players, then Remove — or + Add someone new.
              </p>
            ) : null}
            <div className="roster-list" style={{ marginTop: 12 }}>
              {sortedPlayers.length > 0 && (
                <div className="roster-row roster-select-all">
                  <input
                    type="checkbox"
                    checked={
                      sortedPlayers.length > 0 &&
                      (rosterEditing
                        ? sortedPlayers.every((player) =>
                            removeIds.has(player.id),
                          )
                        : sortedPlayers.every((player) =>
                            selected.has(player.id),
                          ))
                    }
                    ref={(el) => {
                      if (!el) return;
                      const set = rosterEditing ? removeIds : selected;
                      const some = sortedPlayers.some((player) =>
                        set.has(player.id),
                      );
                      const all = sortedPlayers.every((player) =>
                        set.has(player.id),
                      );
                      el.indeterminate = some && !all;
                    }}
                    onChange={() => {
                      if (rosterEditing) {
                        const allMarked = sortedPlayers.every((player) =>
                          removeIds.has(player.id),
                        );
                        setRemoveIds(
                          allMarked
                            ? new Set()
                            : new Set(
                                sortedPlayers.map((player) => player.id),
                              ),
                        );
                      } else {
                        const allSelected = sortedPlayers.every((player) =>
                          selected.has(player.id),
                        );
                        setSelected(
                          allSelected
                            ? new Set()
                            : new Set(
                                sortedPlayers.map((player) => player.id),
                              ),
                        );
                      }
                    }}
                    aria-label={
                      rosterEditing
                        ? "Select all to remove"
                        : "Select all players"
                    }
                  />
                  <span className="roster-name">
                    <strong>
                      {rosterEditing ? "Select to remove" : "Select all"}
                    </strong>
                  </span>
                </div>
              )}
              {sortedPlayers.map((player) => {
                const locked = player.averageMode === "FIXED";
                const checked = rosterEditing
                  ? removeIds.has(player.id)
                  : selected.has(player.id);
                return (
                <div
                  className={`roster-row roster-edit ${rosterEditing && checked ? "roster-mark-remove" : ""}`}
                  key={player.id}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      rosterEditing
                        ? toggleRemove(player.id)
                        : toggle(player.id)
                    }
                  />
                  <span className="roster-name">
                    <NameWithScratch
                      name={player.displayName}
                      on={player.scratchPool}
                    />
                    <small className="muted">
                      {locked ? "LOCKED" : player.averageMode}
                      {player.leagueAverage != null
                        ? ` · league ${player.leagueAverage}`
                        : ""}
                    </small>
                  </span>
                  <div className="avg-edit">
                    <input
                      type="number"
                      min={0}
                      max={300}
                      disabled={locked || busy}
                      value={avgDraft[player.id] ?? ""}
                      onChange={(event) =>
                        setAvgDraft((prev) => ({
                          ...prev,
                          [player.id]: event.target.value,
                        }))
                      }
                    />
                    <button
                      type="button"
                      className={`button small ghost-toggle ${locked ? "unlock-btn" : "lock-btn"}`}
                      disabled={busy}
                      onClick={() =>
                        locked ? unlockAverage(player) : lockAverage(player)
                      }
                    >
                      {locked ? "Unlock" : "Lock"}
                    </button>
                  </div>
                </div>
                );
              })}
            </div>
            <div className="roster-count">
              <strong>{selected.size}</strong> checked in
              {attendees.length !== selected.size ? (
                <span className="muted">
                  {" "}
                  · {attendees.length} ready (have average)
                </span>
              ) : null}
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h3>Generate teams</h3>
            <p className="muted">
              Confirm who’s checked in, then choose Balance or Random.
            </p>
            <div className="actions" style={{ marginTop: 12 }}>
              <button
                className="button"
                disabled={busy || attendees.length < teamCount}
                onClick={() => {
                  setGenerateFromReset(false);
                  setGenerateOpen(true);
                }}
              >
                Generate teams
              </button>
            </div>
          </div>
        </>
      )}

      {step === "reset" && (
        <>
          <div className="page-title">
            <div>
              <h2>Edit players · Game {resetTargetGame + 1}</h2>
              <p>
                Add or remove bowlers, change 2/3 teams, then generate. Earlier
                game scores stay.
              </p>
            </div>
            <button
              className="button secondary"
              onClick={() => setStep("game")}
            >
              Cancel
            </button>
          </div>

          <div className="card">
            <div className="play-controls">
              <div>
                <span className="label">Teams</span>
                <div className="segmented">
                  <button
                    className={teamCount === 2 ? "active" : ""}
                    onClick={() => setTeamCount(2)}
                  >
                    2 teams
                  </button>
                  <button
                    className={teamCount === 3 ? "active" : ""}
                    onClick={() => setTeamCount(3)}
                  >
                    3 teams
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="page-title" style={{ marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>Who’s bowling</h3>
              <div className="actions">
                {rosterEditing ? (
                  <>
                    <button
                      className="button small secondary"
                      onClick={() => setAddOpen(true)}
                    >
                      + Add
                    </button>
                    <button
                      className="button small secondary"
                      disabled={busy || removeIds.size === 0}
                      onClick={() => void removeSelectedPlayers()}
                    >
                      Remove{removeIds.size ? ` (${removeIds.size})` : ""}
                    </button>
                    <button
                      className="button small"
                      onClick={exitRosterEdit}
                    >
                      Done
                    </button>
                  </>
                ) : (
                  <button
                    className="button small secondary"
                    onClick={enterRosterEdit}
                  >
                    Edit
                  </button>
                )}
              </div>
            </div>
            {rosterEditing ? (
              <p className="muted" style={{ marginTop: -4, marginBottom: 8 }}>
                Check players, then Remove — or + Add someone new.
              </p>
            ) : null}
            <div className="roster-list" style={{ marginTop: 12 }}>
              {sortedPlayers.length > 0 && (
                <div className="roster-row roster-select-all">
                  <input
                    type="checkbox"
                    checked={
                      sortedPlayers.length > 0 &&
                      (rosterEditing
                        ? sortedPlayers.every((player) =>
                            removeIds.has(player.id),
                          )
                        : sortedPlayers.every((player) =>
                            selected.has(player.id),
                          ))
                    }
                    onChange={() => {
                      if (rosterEditing) {
                        const allMarked = sortedPlayers.every((player) =>
                          removeIds.has(player.id),
                        );
                        setRemoveIds(
                          allMarked
                            ? new Set()
                            : new Set(
                                sortedPlayers.map((player) => player.id),
                              ),
                        );
                      } else {
                        const allSelected = sortedPlayers.every((player) =>
                          selected.has(player.id),
                        );
                        setSelected(
                          allSelected
                            ? new Set()
                            : new Set(
                                sortedPlayers.map((player) => player.id),
                              ),
                        );
                      }
                    }}
                  />
                  <span className="roster-name">
                    <strong>
                      {rosterEditing ? "Select to remove" : "Select all"}
                    </strong>
                  </span>
                </div>
              )}
              {sortedPlayers.map((player) => {
                const locked = player.averageMode === "FIXED";
                const checked = rosterEditing
                  ? removeIds.has(player.id)
                  : selected.has(player.id);
                return (
                  <div
                    className={`roster-row roster-edit ${rosterEditing && checked ? "roster-mark-remove" : ""}`}
                    key={player.id}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        rosterEditing
                          ? toggleRemove(player.id)
                          : toggle(player.id)
                      }
                    />
                    <span className="roster-name">
                      <NameWithScratch
                        name={player.displayName}
                        on={player.scratchPool}
                      />
                      <small className="muted">
                        {locked ? "LOCKED" : player.averageMode}
                        {player.leagueAverage != null
                          ? ` · league ${player.leagueAverage}`
                          : ""}
                      </small>
                    </span>
                    <div className="avg-edit">
                      <input
                        type="number"
                        min={0}
                        max={300}
                        disabled={locked || busy}
                        value={avgDraft[player.id] ?? ""}
                        onChange={(event) =>
                          setAvgDraft((prev) => ({
                            ...prev,
                            [player.id]: event.target.value,
                          }))
                        }
                      />
                      <button
                        type="button"
                        className={`button small ghost-toggle ${locked ? "unlock-btn" : "lock-btn"}`}
                        disabled={busy}
                        onClick={() =>
                          locked ? unlockAverage(player) : lockAverage(player)
                        }
                      >
                        {locked ? "Unlock" : "Lock"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="roster-count">
              <strong>{selected.size}</strong> checked in
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h3>Generate teams for Game {resetTargetGame + 1}</h3>
            <p className="muted">
              Confirm who’s checked in, then choose Balance or Random.
            </p>
            <div className="actions" style={{ marginTop: 12 }}>
              <button
                className="button"
                disabled={busy || attendees.length < teamCount}
                onClick={() => {
                  setGenerateFromReset(true);
                  setGenerateOpen(true);
                }}
              >
                Generate teams
              </button>
            </div>
          </div>
        </>
      )}

      {step === "game" && result && gameResult && (
        <>
          <div className="page-title">
            <div>
              <h2>
                Game {clampGameIndex(gameIndex) + 1} of {GAMES_PER_SESSION}
              </h2>
              <p>Team totals update as you enter scores. Winner locks in when everyone has a number.</p>
            </div>
            <div className="actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setGenerateFromReset(false);
                  setGenerateReshuffle(true);
                  setGenerateOpen(true);
                }}
              >
                Shuffle
              </button>
              <button
                className={`button ${gameEditing ? "" : "secondary"}`}
                disabled={busy}
                onClick={() => {
                  setGameEditing((value) => !value);
                  setAddToTeamName(null);
                  setMessage("");
                }}
              >
                {gameEditing ? "Done editing" : "Edit players"}
              </button>
              <button className="button secondary" onClick={leaveGameToSetup}>
                Back to setup
              </button>
            </div>
          </div>

          {gameEditing && (
            <div
              className="actions"
              style={{ marginTop: -4, marginBottom: 12, alignItems: "center" }}
            >
              <p className="muted" style={{ margin: 0, flex: 1 }}>
                Add or remove teams and players, change averages — handicap
                updates automatically.
              </p>
              <button
                type="button"
                className="button"
                disabled={result.teams.length >= MAX_TEAMS}
                onClick={addTeam}
              >
                + Add team
              </button>
            </div>
          )}

          {liveStandings.length >= 2 ? (
            <div
              className={`card race-card ${gameResult.complete ? "final" : ""}`}
            >
              <div className="race-head">
                <strong>
                  {gameResult.complete
                    ? gameResult.winnerName
                      ? gameResult.margin != null
                        ? `${gameResult.winnerName} wins by ${gameResult.margin}`
                        : `${gameResult.winnerName} wins`
                      : "Tie game"
                    : (() => {
                        const leader = liveStandings.find((row) => row.leading);
                        const tied = liveStandings.filter((row) => row.tied);
                        if (leader)
                          return `${leader.teamName} leads by ${leader.leadBy}`;
                        if (tied.length)
                          return `${tied.map((row) => row.teamName).join(" / ")} tied`;
                        return "Live race";
                      })()}
                </strong>
                <span className="muted">
                  {gameResult.complete ? "Final · with HDC" : "Live · with HDC"}
                </span>
              </div>
              <div className="race-rows">
                {[...liveStandings]
                  .sort((a, b) => a.place - b.place)
                  .map((row) => (
                    <div
                      className={`race-row ${row.leading ? "lead" : ""} ${row.tied ? "tie" : ""}`}
                      key={row.teamName}
                    >
                      <span className="race-place">#{row.place}</span>
                      <span className="race-name">{row.teamName}</span>
                      <strong className="race-total">{row.total}</strong>
                      <span className="race-gap">
                        {row.leading
                          ? `+${row.leadBy}`
                          : row.tied
                            ? "need 1"
                            : `need ${row.toLead}`}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          ) : null}

          <div className="team-grid" key={clampGameIndex(gameIndex)}>
            {result.teams.map((team) => {
              const series = seriesResults.find(
                (entry) => entry.teamName === team.name,
              );
              const line = gameResult.teams.find(
                (entry) => entry.teamName === team.name,
              );
              // Live team totals from the same score map the inputs write to.
              const liveScratch = team.players.reduce((sum, player) => {
                const value = scores[String(player.id)]?.[gameIndex];
                return sum + (typeof value === "number" ? value : 0);
              }, 0);
              const liveHdc = series?.handicapPerGame ?? 0;
              const liveTotal = liveScratch + liveHdc;
              const standing = liveStandings.find(
                (row) => row.teamName === team.name,
              );
              const lost =
                gameResult.complete &&
                gameResult.lastName === team.name &&
                gameResult.winnerName !== team.name;
              const tiedLead =
                gameResult.complete &&
                !line?.won &&
                !lost &&
                !gameResult.winnerName &&
                (line?.total ?? 0) ===
                  Math.max(...gameResult.teams.map((entry) => entry.total));
              const placeBadge =
                line?.won
                  ? gameResult.margin != null
                    ? `WIN +${gameResult.margin}`
                    : "WIN"
                  : lost
                    ? gameResult.margin != null
                      ? `LOSS -${gameResult.margin}`
                      : "LOSS"
                    : tiedLead
                      ? "TIE"
                      : line?.place != null
                        ? `#${line.place}`
                        : null;
              return (
                <div
                  className={`card team-card ${line?.won ? "team-win" : ""} ${lost ? "team-loss" : ""}`}
                  key={team.name}
                >
                  <div className="team-head">
                    <div>
                      <h3>
                        {team.name}
                        <small className="muted">
                          avg {series?.averageSum ?? 0}
                        </small>
                      </h3>
                    </div>
                    <div className="team-head-actions">
                      {gameEditing ? (
                        <>
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => setAddToTeamName(team.name)}
                          >
                            + Add
                          </button>
                          <button
                            type="button"
                            className="button secondary"
                            disabled={result.teams.length <= MIN_TEAMS}
                            onClick={() => removeTeam(team.name)}
                          >
                            Remove team
                          </button>
                        </>
                      ) : null}
                      {gameResult.complete && placeBadge ? (
                        <span
                          className={`badge ${line?.won ? "AUTO" : lost ? "loss" : ""}`}
                        >
                          {placeBadge}
                        </span>
                      ) : standing?.leading ? (
                        <span className="badge AUTO">
                          Lead +{standing.leadBy}
                        </span>
                      ) : standing?.tied ? (
                        <span className="badge">Need 1</span>
                      ) : standing ? (
                        <span className="badge">Need {standing.toLead}</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="scoreboard single-game">
                    <div className="scoreboard-head single">
                      <span>Player</span>
                      <span>G{gameIndex + 1}</span>
                      <span>Series</span>
                    </div>
                    {team.players.length === 0 ? (
                      <div className="scoreboard-row single">
                        <span className="muted">No players yet — use + Add</span>
                      </div>
                    ) : null}
                    {team.players.map((player) => {
                      const id = String(player.id);
                      const games = scores[id] ?? [null, null, null];
                      return (
                        <div className="scoreboard-row single" key={id}>
                          <span className="player-cell">
                            {gameEditing ? (
                              <button
                                type="button"
                                className="icon-button row-remove"
                                aria-label={`Remove ${player.name}`}
                                onClick={() => removeFromTeam(team.name, id)}
                              >
                                −
                              </button>
                            ) : null}
                            <span className="player-meta">
                              <NameWithScratch
                                name={player.name}
                                on={scratchIds.has(Number(player.id))}
                              />
                              {gameEditing ? (
                                <label className="avg-inline">
                                  avg
                                  <input
                                    type="number"
                                    min={0}
                                    max={300}
                                    aria-label={`${player.name} average`}
                                    value={player.usedAverage}
                                    onChange={(event) =>
                                      setTeamPlayerAverage(
                                        team.name,
                                        id,
                                        event.target.value,
                                      )
                                    }
                                  />
                                </label>
                              ) : (
                                <small className="muted">
                                  avg {player.usedAverage}
                                </small>
                              )}
                            </span>
                          </span>
                          <input
                            key={`${id}-g${clampGameIndex(gameIndex)}`}
                            type="number"
                            min={0}
                            max={300}
                            inputMode="numeric"
                            aria-label={`${player.name} game ${gameIndex + 1}`}
                            value={games[clampGameIndex(gameIndex)] ?? ""}
                            onChange={(event) =>
                              setScore(id, event.target.value)
                            }
                          />
                          <strong className="series-cell">
                            {playerSeriesTotal(games) || "—"}
                          </strong>
                        </div>
                      );
                    })}
                  </div>

                  <div className="team-score-block">
                    <div>
                      <span className="muted">Scratch</span>
                      <strong>{liveScratch}</strong>
                    </div>
                    <div>
                      <span className="muted">HDC</span>
                      <strong>+{liveHdc}</strong>
                    </div>
                    <div className="team-score-total">
                      <span className="muted">Total</span>
                      <strong>{liveTotal}</strong>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="card nav-card" style={{ marginTop: 16 }}>
            <div className="game-nav">
              <button
                className="button secondary"
                disabled={gameIndex === 0}
                onClick={goPreviousGame}
              >
                Previous
              </button>
              <div className="game-nav-right">
                <button
                  className="button secondary"
                  disabled={busy || skipGameCount < 1}
                  onClick={skipRest}
                  title="Finish early without playing remaining games"
                >
                  Skip rest
                </button>
                {gameIndex < GAMES_PER_SESSION - 1 ? (
                  <button
                    className="button"
                    disabled={!gameResult.complete}
                    onClick={goNextGame}
                  >
                    Next game
                  </button>
                ) : (
                  <button
                    className="button"
                    disabled={!gameResult.complete || busy}
                    onClick={() => finishNight(GAMES_PER_SESSION)}
                  >
                    Final stats
                  </button>
                )}
              </div>
            </div>
            {!gameResult.complete ? (
              <p className="muted" style={{ margin: "10px 0 0" }}>
                {scoresNeeded.length
                  ? scoresNeeded.length <= 4
                    ? `Need scores for ${scoresNeeded.join(", ")}.`
                    : `Need scores for ${scoresNeeded.length} players.`
                  : "Enter every score to continue."}
              </p>
            ) : null}
          </div>
        </>
      )}

      {step === "summary" && result && (
        <>
          <div className="page-title">
            <div>
              <h2>Final stats</h2>
              <p>Saved to History.</p>
            </div>
            <button className="button secondary" onClick={resetToSetup}>
              New night
            </button>
          </div>

          <div className="team-grid">
            {seriesResults.map((team) => {
              const lost =
                team.place != null &&
                !team.won &&
                team.place === seriesResults.length;
              return (
                <div
                  className={`card team-card ${team.won ? "team-win" : ""} ${lost ? "team-loss" : ""}`}
                  key={team.teamName}
                >
                  <div className="team-head">
                    <h3>
                      {team.teamName}
                      <small className="muted">avg {team.averageSum}</small>
                    </h3>
                    <span
                      className={`badge ${team.won ? "AUTO" : lost ? "loss" : ""}`}
                    >
                      {team.won
                        ? "WIN"
                        : lost
                          ? "LOSS"
                          : team.place != null
                            ? `#${team.place}`
                            : "—"}
                    </span>
                  </div>
                  <div className="team-score-block big">
                    <div>
                      <span className="muted">Games won</span>
                      <strong>{team.wins}</strong>
                    </div>
                    <div>
                      <span className="muted">HDC</span>
                      <strong>+{team.handicapTotal}</strong>
                    </div>
                    <div className="team-score-total">
                      <span className="muted">Final</span>
                      <strong>{team.finalTotal}</strong>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h3>Scratch tickets · $10 each</h3>
            <p className="muted" style={{ marginTop: 4 }}>
              Best of 3: 2 wins gets a $10 ticket. Late join with 2 wins
              counts. Scratch members are set in Club.
            </p>
            {scratchWinners.length ? (
              <div className="player-stats-list" style={{ marginTop: 12 }}>
                {scratchWinners.map((winner) => (
                  <div className="player-stat-row" key={winner.playerId}>
                    <div className="player-stat-top">
                      <span>
                        <NameWithScratch name={winner.name} on />
                        <small className="muted">
                          {" "}
                          {winner.wins} win{winner.wins === 1 ? "" : "s"}
                        </small>
                      </span>
                      <strong className="due-pill">Ticket · $10</strong>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ marginTop: 12 }}>
                {scratchIds.size
                  ? "Nobody in membership reached 2 wins."
                  : "No scratch members."}
              </p>
            )}
            {scratchIds.size ? (
              <p className="muted" style={{ marginTop: 10 }}>
                Members:{" "}
                {players
                  .filter((player) => player.scratchPool)
                  .map((player, index) => (
                    <span key={player.id}>
                      {index ? " · " : null}
                      {player.displayName}
                      <ScratchMark on />
                    </span>
                  ))}
              </p>
            ) : null}
          </div>
        </>
      )}

      {generateOpen && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setGenerateOpen(false);
            setGenerateReshuffle(false);
          }}
        >
          <div
            className="card modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-head">
              <h3>{generateReshuffle ? "Shuffle teams?" : "Generate teams?"}</h3>
              <button
                className="icon-button"
                onClick={() => {
                  setGenerateOpen(false);
                  setGenerateReshuffle(false);
                }}
              >
                ×
              </button>
            </div>
            <p style={{ marginTop: 8, fontSize: 18, fontWeight: 650 }}>
              {generateReshuffle
                ? `${currentNightPlayers.length} on the lanes`
                : (
                  <>
                    {selected.size} checked in
                    {attendees.length !== selected.size ? (
                      <span className="muted" style={{ fontWeight: 500 }}>
                        {" "}
                        · {attendees.length} ready (have average)
                      </span>
                    ) : null}
                  </>
                )}
            </p>
            <p className="muted">
              {teamCount} teams ·{" "}
              {generateReshuffle
                ? `Game ${gameIndex + 1}`
                : generateFromReset
                  ? `Game ${resetTargetGame + 1}`
                  : "Game 1"}
            </p>
            <p className="muted" style={{ marginTop: 8 }}>
              Balance: avg 150+ / under 150 pools, then shuffle. Random: full
              shuffle.
            </p>
            <div className="actions" style={{ marginTop: 16 }}>
              <button
                className="button"
                disabled={
                  busy ||
                  (generateReshuffle
                    ? currentNightPlayers.length < teamCount
                    : attendees.length < teamCount)
                }
                onClick={() => {
                  setGenerateOpen(false);
                  const reshuffle = generateReshuffle;
                  const fromReset = generateFromReset;
                  setGenerateReshuffle(false);
                  void generate(
                    "BALANCED",
                    reshuffle
                      ? {
                          reshuffle: true,
                          forGameIndex: gameIndex,
                          playersOverride: currentNightPlayers,
                        }
                      : fromReset
                        ? {
                            fromReset: true,
                            forGameIndex: resetTargetGame,
                          }
                        : undefined,
                  );
                }}
              >
                Balance
              </button>
              <button
                className="button secondary"
                disabled={
                  busy ||
                  (generateReshuffle
                    ? currentNightPlayers.length < teamCount
                    : attendees.length < teamCount)
                }
                onClick={() => {
                  setGenerateOpen(false);
                  const reshuffle = generateReshuffle;
                  const fromReset = generateFromReset;
                  setGenerateReshuffle(false);
                  void generate(
                    "RANDOM",
                    reshuffle
                      ? {
                          reshuffle: true,
                          forGameIndex: gameIndex,
                          playersOverride: currentNightPlayers,
                        }
                      : fromReset
                        ? {
                            fromReset: true,
                            forGameIndex: resetTargetGame,
                          }
                        : undefined,
                  );
                }}
              >
                Random
              </button>
              <button
                className="button secondary"
                onClick={() => {
                  setGenerateOpen(false);
                  setGenerateReshuffle(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {addToTeamName && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setAddToTeamName(null);
            setTeamGuestName("");
            setTeamGuestAvg("");
          }}
        >
          <div
            className="card modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-head">
              <h3>Add to {addToTeamName}</h3>
              <button
                className="icon-button"
                onClick={() => {
                  setAddToTeamName(null);
                  setTeamGuestName("");
                  setTeamGuestAvg("");
                }}
              >
                ×
              </button>
            </div>
            <p className="muted" style={{ marginTop: 8 }}>
              Pick someone from the roster, or add a brand-new name + average.
            </p>
            <div className="form-grid" style={{ marginTop: 12 }}>
              <label className="field">
                New name
                <input
                  value={teamGuestName}
                  onChange={(event) => setTeamGuestName(event.target.value)}
                  placeholder="Guest or sub"
                />
              </label>
              <label className="field">
                Average
                <input
                  type="number"
                  min={0}
                  max={300}
                  value={teamGuestAvg}
                  onChange={(event) => setTeamGuestAvg(event.target.value)}
                />
              </label>
            </div>
            <button
              className="button"
              style={{ marginTop: 10 }}
              disabled={busy}
              onClick={() => void createGuestForTeam()}
            >
              Add new player to team
            </button>
            <hr style={{ margin: "18px 0", borderColor: "var(--line)" }} />
            {availableToAdd.length === 0 ? (
              <p className="muted">No roster players left to add.</p>
            ) : (
              <div className="add-team-list">
                {availableToAdd.map((player) => (
                  <button
                    key={player.id}
                    type="button"
                    className="button secondary add-team-item"
                    onClick={() => addToTeam(addToTeamName, player)}
                  >
                    <span className="roster-name-line">
                      <span>{player.displayName}</span>
                      <ScratchMark on={player.scratchPool} />
                    </span>
                    <span className="muted">avg {player.usedAverage}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {addOpen && (
        <div className="modal-backdrop" onClick={() => setAddOpen(false)}>
          <div
            className="card modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-head">
              <h3>Add player</h3>
              <button className="icon-button" onClick={() => setAddOpen(false)}>
                ×
              </button>
            </div>
            <p className="muted">
              On Ohana? Pick from the sheet. Not on the sheet? Enter a MANUAL
              average.
            </p>
            <label className="field" style={{ marginTop: 12 }}>
              From last Ohana sheet
              <select
                value={pickLeague}
                onChange={(event) => setPickLeague(event.target.value)}
              >
                <option value="">Choose…</option>
                {leagueOptions.map((option) => (
                  <option key={option.printedName} value={option.printedName}>
                    {option.printedName}
                    {option.currentAverage != null
                      ? ` · ${option.currentAverage}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button"
              style={{ marginTop: 10 }}
              disabled={!pickLeague || busy}
              onClick={addFromLeague}
            >
              Add from league
            </button>
            <hr style={{ margin: "18px 0", borderColor: "var(--line)" }} />
            <div className="form-grid">
              <label className="field">
                Name
                <input
                  value={manualName}
                  onChange={(event) => setManualName(event.target.value)}
                />
              </label>
              <label className="field">
                Manual average
                <input
                  type="number"
                  min={0}
                  max={300}
                  value={manualAvg}
                  onChange={(event) => setManualAvg(event.target.value)}
                />
              </label>
            </div>
            <button
              className="button secondary"
              style={{ marginTop: 10 }}
              disabled={busy}
              onClick={addManual}
            >
              Add non-league player
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function prettyMoneyDate(ymd: string) {
  const [year, month, day] = ymd.split("-").map(Number);
  if (!year || !month || !day) return ymd;
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatScratchMoney(amount: number, signed = false) {
  const text = `$${Math.abs(amount)}`;
  if (amount < 0) return `-${text}`;
  if (signed && amount > 0) return `+${text}`;
  return text;
}

function isDefaultOutNote(note: string) {
  return (
    !note ||
    note.startsWith("Paid out $") ||
    note.startsWith("Scratch ticket")
  );
}

function groupMoneyEntries(entries: ScratchLedgerEntry[]) {
  const groups: Array<{
    key: string;
    date: string;
    amount: number;
    note: string;
    entries: ScratchLedgerEntry[];
  }> = [];
  const index = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.date}|${entry.amount}`;
    const at = index.get(key);
    if (at == null) {
      index.set(key, groups.length);
      groups.push({
        key,
        date: entry.date,
        amount: entry.amount,
        note: entry.note,
        entries: [entry],
      });
    } else {
      groups[at].entries.push(entry);
      if (isDefaultOutNote(groups[at].note) && !isDefaultOutNote(entry.note))
        groups[at].note = entry.note;
    }
  }
  return groups;
}

function groupLedgerDays(entries: ScratchLedgerEntry[]) {
  const days: Array<{
    date: string;
    inAmount: number;
    outAmount: number;
  }> = [];
  const index = new Map<string, number>();
  for (const entry of entries) {
    const at = index.get(entry.date);
    if (at == null) {
      index.set(entry.date, days.length);
      days.push({
        date: entry.date,
        inAmount: entry.amount > 0 ? entry.amount : 0,
        outAmount: entry.amount < 0 ? -entry.amount : 0,
      });
    } else {
      if (entry.amount > 0) days[at].inAmount += entry.amount;
      if (entry.amount < 0) days[at].outAmount += -entry.amount;
    }
  }
  return days;
}

function ClubTab({
  refreshKey,
  onChanged,
}: {
  refreshKey: number;
  onChanged: () => void;
}) {
  const [data, setData] = useState<ScratchMoneySnapshot | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [payoutDate, setPayoutDate] = useState(localDateInputValue);
  const [payoutAmount, setPayoutAmount] = useState("");
  const [payoutNote, setPayoutNote] = useState("");
  const [payoutIds, setPayoutIds] = useState<Set<number>>(new Set());
  const [payoutEditing, setPayoutEditing] = useState(false);
  const [membersEditing, setMembersEditing] = useState(false);

  const loadMoney = useCallback(async () => {
    const [money, roster] = await Promise.all([
      api<ScratchMoneySnapshot>("/api/money"),
      api<{ players: Player[] }>("/api/players"),
    ]);
    setData(money);
    setPlayers(
      roster.players.filter((player) => player.active && !player.archived),
    );
  }, []);

  useEffect(() => {
    loadMoney().catch((err: Error) => setError(err.message));
  }, [loadMoney, refreshKey]);

  useEffect(() => {
    if (data?.today) setPayoutDate(data.today);
  }, [data?.today]);

  const setMember = async (playerId: number, inPool: boolean) => {
    setBusy(true);
    setError("");
    try {
      const money = await api<ScratchMoneySnapshot>("/api/money/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId, inPool }),
      });
      setData(money);
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const togglePayout = (playerId: number) => {
    setPayoutIds((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  };

  const savePayouts = async () => {
    setBusy(true);
    setError("");
    try {
      const money = await api<ScratchMoneySnapshot>("/api/money/payouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: payoutDate,
          amount: Number(payoutAmount),
          playerIds: [...payoutIds],
          note: payoutNote.trim(),
        }),
      });
      setData(money);
      setPayoutIds(new Set());
      setPayoutNote("");
      setPayoutEditing(false);
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const undoPayouts = async (ids: number[]) => {
    const label =
      ids.length === 1
        ? "Remove this payout from the ledger?"
        : `Remove ${ids.length} payouts from the ledger?`;
    if (!window.confirm(label)) return;
    setBusy(true);
    setError("");
    try {
      let money: ScratchMoneySnapshot | null = null;
      for (const id of ids) {
        money = await api<ScratchMoneySnapshot>(`/api/money/entries/${id}`, {
          method: "DELETE",
        });
      }
      if (money) setData(money);
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const memberIds = new Set(data?.members.map((member) => member.id) ?? []);
  const available = players.filter((player) => !memberIds.has(player.id));
  const payoutPeople = data?.members ?? [];
  const selectedPayouts = payoutPeople.filter((player) =>
    payoutIds.has(player.id),
  );
  const paidOut = groupMoneyEntries(
    (data?.entries ?? []).filter(
      (entry) => entry.kind === "ticket" || entry.kind === "payout",
    ),
  );
  const ledgerDays = groupLedgerDays(data?.entries ?? []);

  return (
    <>
      <div className="page-title">
        <div>
          <h2>Club members</h2>
          <p>
            ${data?.duesAmount ?? 20} on the 9th from members, $
            {data?.ticketAmount ?? 10} out per scratch ticket.
          </p>
        </div>
      </div>
      {error ? <div className="notice error">{error}</div> : null}

      <div className="money-hero card">
        <div>
          <span className="muted">Club pot remaining</span>
          <strong
            className={`money-balance ${
              (data?.balance ?? 0) < 0 ? "negative" : ""
            }`}
          >
            {data ? formatScratchMoney(data.balance) : "—"}
          </strong>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {data
            ? `Next collection ${prettyMoneyDate(data.nextDuesDate)} · ${
                data.nextDuesCount
              } people × ${formatScratchMoney(data.duesAmount)} = ${formatScratchMoney(
                data.nextDuesTotal,
              )}`
            : "Loading…"}
        </p>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="page-title" style={{ marginBottom: 0 }}>
          <div>
            <h3 style={{ margin: 0 }}>Members</h3>
            <p className="muted" style={{ margin: "4px 0 0" }}>
              Red S follows these names in Play, games, and History.
            </p>
          </div>
          <button
            type="button"
            className={`button small ${membersEditing ? "" : "secondary"}`}
            onClick={() => setMembersEditing((value) => !value)}
          >
            {membersEditing ? "Done" : "Edit"}
          </button>
        </div>
        {data?.members.length ? (
          membersEditing ? (
            <div className="player-stats-list" style={{ marginTop: 12 }}>
              {data.members.map((member) => (
                <div className="player-stat-row" key={member.id}>
                  <div className="player-stat-top" style={{ marginBottom: 0 }}>
                    <span>
                      <NameWithScratch name={member.name} on />
                    </span>
                    <button
                      type="button"
                      className="button small secondary"
                      disabled={busy}
                      onClick={() => void setMember(member.id, false)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="club-names">
              {data.members.map((member) => (
                <NameWithScratch key={member.id} name={member.name} on />
              ))}
            </div>
          )
        ) : (
          <p style={{ marginTop: 12 }}>
            {membersEditing
              ? "Nobody yet. Add a member below."
              : "Nobody yet. Edit to add members."}
          </p>
        )}
        {membersEditing && available.length ? (
          <label className="field" style={{ marginTop: 14, maxWidth: 360 }}>
            Add a member
            <select
              disabled={busy}
              defaultValue=""
              onChange={(event) => {
                const id = Number(event.target.value);
                event.target.value = "";
                if (Number.isFinite(id) && id) void setMember(id, true);
              }}
            >
              <option value="">Choose a player…</option>
              {available.map((player) => (
                <option key={player.id} value={player.id}>
                  {player.displayName}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="page-title" style={{ marginBottom: 0 }}>
          <div>
            <h3 style={{ margin: 0 }}>Paid out</h3>
            <p className="muted" style={{ margin: "4px 0 0" }}>
              {payoutEditing
                ? selectedPayouts.length
                  ? selectedPayouts.map((player) => player.name).join(" · ")
                  : "Check who received money, then save."
                : "$10 scratch tickets and money you recorded."}
            </p>
          </div>
          <button
            type="button"
            className={`button small ${payoutEditing ? "" : "secondary"}`}
            disabled={!payoutPeople.length}
            onClick={() => setPayoutEditing((value) => !value)}
          >
            {payoutEditing ? "Done" : "Edit"}
          </button>
        </div>
        {payoutEditing ? (
          <>
            <div className="play-controls" style={{ marginTop: 12 }}>
              <label className="field">
                Date
                <input
                  type="date"
                  value={payoutDate}
                  onChange={(event) => setPayoutDate(event.target.value)}
                />
              </label>
              <label className="field">
                Amount each
                <input
                  type="number"
                  min={1}
                  max={9999}
                  inputMode="numeric"
                  placeholder={String(data?.ticketAmount ?? 10)}
                  value={payoutAmount}
                  onChange={(event) => setPayoutAmount(event.target.value)}
                />
              </label>
              <label className="field" style={{ minWidth: 160 }}>
                Note
                <input
                  value={payoutNote}
                  maxLength={120}
                  placeholder="Optional"
                  onChange={(event) => setPayoutNote(event.target.value)}
                />
              </label>
            </div>
            <div className="roster-list" style={{ marginTop: 12 }}>
              <label className="roster-row roster-select-all">
                <input
                  type="checkbox"
                  checked={
                    payoutPeople.length > 0 &&
                    payoutPeople.every((player) => payoutIds.has(player.id))
                  }
                  onChange={() => {
                    const allOn = payoutPeople.every((player) =>
                      payoutIds.has(player.id),
                    );
                    setPayoutIds(
                      allOn
                        ? new Set()
                        : new Set(payoutPeople.map((player) => player.id)),
                    );
                  }}
                />
                <span className="roster-name">
                  <strong>Select all members</strong>
                </span>
              </label>
              {payoutPeople.map((player) => (
                <label className="roster-row" key={player.id}>
                  <input
                    type="checkbox"
                    checked={payoutIds.has(player.id)}
                    onChange={() => togglePayout(player.id)}
                  />
                  <span className="roster-name">
                    <NameWithScratch name={player.name} on />
                  </span>
                </label>
              ))}
            </div>
            <button
              className="button"
              style={{ marginTop: 12 }}
              disabled={busy || payoutIds.size === 0 || !payoutAmount}
              onClick={() => void savePayouts()}
            >
              Save payout
              {payoutIds.size && payoutAmount
                ? ` · ${payoutIds.size} × ${formatScratchMoney(Number(payoutAmount) || 0)}`
                : ""}
            </button>
          </>
        ) : null}
        {paidOut.length ? (
          <div className="player-stats-list" style={{ marginTop: 12 }}>
            {paidOut.map((group) => {
              const undoIds = group.entries
                .filter((entry) => entry.kind === "payout")
                .map((entry) => entry.id);
              return (
                <div className="player-stat-row" key={group.key}>
                  <div className="player-stat-top" style={{ marginBottom: 0 }}>
                    <div>
                      <strong>
                        {prettyMoneyDate(group.date)}
                        {!isDefaultOutNote(group.note)
                          ? ` · ${group.note}`
                          : ""}
                      </strong>
                      <div className="muted" style={{ marginTop: 2 }}>
                        {group.entries.length} ×{" "}
                        {formatScratchMoney(Math.abs(group.amount))}
                      </div>
                      <div className="club-group-names">
                        {group.entries.map((entry) => (
                          <NameWithScratch
                            key={entry.id}
                            name={entry.playerName}
                            on={memberIds.has(entry.playerId ?? -1)}
                          />
                        ))}
                      </div>
                    </div>
                    <span className="player-pay">
                      <strong className="due-amount">
                        {formatScratchMoney(
                          group.amount * group.entries.length,
                          true,
                        )}
                      </strong>
                      {payoutEditing && undoIds.length ? (
                        <button
                          type="button"
                          className="button small secondary"
                          disabled={busy}
                          onClick={() => void undoPayouts(undoIds)}
                        >
                          Undo
                        </button>
                      ) : null}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : payoutEditing ? null : (
          <p style={{ marginTop: 12 }}>
            Empty until a ticket is won, or you add one with Edit.
          </p>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Ledger</h3>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          In and out by day. Who got paid is in Paid out.
        </p>
        {ledgerDays.length ? (
          <div className="player-stats-list" style={{ marginTop: 12 }}>
            {ledgerDays.map((day) => (
              <div className="player-stat-row" key={day.date}>
                <div className="player-stat-top" style={{ marginBottom: 0 }}>
                  <div>
                    <strong>{prettyMoneyDate(day.date)}</strong>
                    <div className="muted" style={{ marginTop: 2 }}>
                      {day.inAmount
                        ? `In ${formatScratchMoney(day.inAmount)}`
                        : null}
                      {day.inAmount && day.outAmount ? " · " : null}
                      {day.outAmount
                        ? `Out ${formatScratchMoney(day.outAmount)}`
                        : null}
                    </div>
                  </div>
                  <strong className="due-amount">
                    {formatScratchMoney(day.inAmount - day.outAmount, true)}
                  </strong>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ marginTop: 12 }}>
            Empty until the 9th, or until a ticket is won.
          </p>
        )}
      </div>
    </>
  );
}

function HistoryTab({
  refreshKey,
  onChanged,
}: {
  refreshKey: number;
  onChanged: () => void;
}) {
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [stats, setStats] = useState<PlayerStat[]>([]);
  const [statsSort, setStatsSort] = useState<{
    key: "name" | "games" | "winRate" | "monday" | "used" | "scratch";
    dir: "asc" | "desc";
  }>({ key: "winRate", dir: "desc" });
  const [openId, setOpenId] = useState<number>();
  const [editingId, setEditingId] = useState<number>();
  const [editDate, setEditDate] = useState("");
  const [editScores, setEditScores] = useState<ScoreMap>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    return Promise.all([
      api<SavedSession[]>("/api/sessions"),
      api<{ players: PlayerStat[] }>("/api/stats"),
    ]).then(([sessionRows, statsPayload]) => {
      setSessions(sessionRows);
      setStats(statsPayload.players);
    });
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load, refreshKey]);

  const sortedStats = useMemo(() => {
    const rows = [...stats];
    const { key, dir } = statsSort;
    const sign = dir === "asc" ? 1 : -1;
    const cmpNullLast = (a: number | null, b: number | null) => {
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return (a - b) * sign;
    };
    rows.sort((a, b) => {
      if (key === "name") {
        return (
          a.displayName.localeCompare(b.displayName, undefined, {
            sensitivity: "base",
          }) * sign
        );
      }
      if (key === "games") return (a.gamesPlayed - b.gamesPlayed) * sign;
      if (key === "scratch")
        return (a.scratchTickets - b.scratchTickets) * sign;
      if (key === "winRate") return cmpNullLast(a.winRate, b.winRate);
      if (key === "monday")
        return cmpNullLast(a.mondayAverage, b.mondayAverage);
      return cmpNullLast(a.usedAverage, b.usedAverage);
    });
    return rows;
  }, [stats, statsSort]);

  const toggleStatsSort = (
    key: "name" | "games" | "winRate" | "monday" | "used" | "scratch",
  ) => {
    setStatsSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" ? "asc" : "desc" },
    );
  };

  const sortMark = (
    key: "name" | "games" | "winRate" | "monday" | "used" | "scratch",
  ) => {
    if (statsSort.key !== key) return "";
    return statsSort.dir === "asc" ? " ↑" : " ↓";
  };

  const clubIds = useMemo(
    () =>
      new Set(
        stats.filter((player) => player.scratchPool).map((player) => String(player.id)),
      ),
    [stats],
  );

  const startEdit = (session: SavedSession) => {
    setEditingId(session.id);
    setOpenId(session.id);
    setEditDate(session.sessionDate);
    setEditScores(
      structuredClone(session.scores ?? {}) as ScoreMap,
    );
  };

  const setEditScore = (
    playerId: string,
    gameIndex: number,
    value: string,
  ) => {
    setEditScores((prev) => {
      const current = [...(prev[playerId] ?? [null, null, null])] as [
        number | null,
        number | null,
        number | null,
      ];
      current[gameIndex] =
        value === "" ? null : Math.max(0, Math.min(300, Number(value) || 0));
      return { ...prev, [playerId]: current };
    });
  };

  const saveEdit = async (sessionId: number) => {
    setBusy(true);
    setMessage("");
    try {
      const updated = await api<{
        id: number;
        sessionDate: string;
        scores: ScoreMap;
        results: SessionTeamResult[];
        finalTeams: SavedSession["finalTeams"];
      }>(`/api/sessions/${sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionDate: editDate, scores: editScores }),
      });
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                sessionDate: updated.sessionDate,
                scores: updated.scores,
                results: updated.results,
              }
            : session,
        ),
      );
      setEditingId(undefined);
      setMessage("Session updated.");
      const statsPayload = await api<{ players: PlayerStat[] }>("/api/stats");
      setStats(statsPayload.players);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const removeSession = async (session: SavedSession) => {
    if (
      !confirm(
        `Delete session ${session.sessionDate}? Scratch tickets from that night will also come off the Club pot.`,
      )
    )
      return;
    setBusy(true);
    setMessage("");
    try {
      await api(`/api/sessions/${session.id}`, { method: "DELETE" });
      setSessions((prev) => prev.filter((entry) => entry.id !== session.id));
      if (openId === session.id) setOpenId(undefined);
      if (editingId === session.id) setEditingId(undefined);
      setMessage("Session deleted.");
      onChanged();
      const statsPayload = await api<{ players: PlayerStat[] }>("/api/stats");
      setStats(statsPayload.players);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-title">
        <div>
          <h2>History</h2>
          <p>Game wins/losses, scratch tickets, averages, and weekly sessions.</p>
        </div>
      </div>
      {error && <div className="notice error">{error}</div>}
      {message && <div className="notice success">{message}</div>}

      <div className="card">
        <h3>Player stats</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>
                  <button
                    type="button"
                    className={`sort-th ${statsSort.key === "name" ? "active" : ""}`}
                    onClick={() => toggleStatsSort("name")}
                  >
                    Player{sortMark("name")}
                  </button>
                </th>
                <th>Games W-L</th>
                <th>
                  <button
                    type="button"
                    className={`sort-th ${statsSort.key === "games" ? "active" : ""}`}
                    onClick={() => toggleStatsSort("games")}
                  >
                    Games{sortMark("games")}
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className={`sort-th ${statsSort.key === "scratch" ? "active" : ""}`}
                    onClick={() => toggleStatsSort("scratch")}
                  >
                    Scratch{sortMark("scratch")}
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className={`sort-th ${statsSort.key === "winRate" ? "active" : ""}`}
                    onClick={() => toggleStatsSort("winRate")}
                  >
                    Win %{sortMark("winRate")}
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className={`sort-th ${statsSort.key === "monday" ? "active" : ""}`}
                    onClick={() => toggleStatsSort("monday")}
                  >
                    Monday avg{sortMark("monday")}
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className={`sort-th ${statsSort.key === "used" ? "active" : ""}`}
                    onClick={() => toggleStatsSort("used")}
                  >
                    Used avg{sortMark("used")}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedStats.map((player) => (
                <tr key={player.id}>
                  <td>
                    <NameWithScratch
                      name={player.displayName}
                      on={player.scratchPool}
                    />
                    <br />
                    <small className="muted">{player.averageMode}</small>
                  </td>
                  <td>
                    {player.wins}-{player.losses}
                    {player.ties ? `-${player.ties}` : ""}
                  </td>
                  <td>{player.gamesPlayed}</td>
                  <td>{player.scratchTickets}</td>
                  <td>
                    {player.winRate == null
                      ? "—"
                      : `${Math.round(player.winRate * 100)}%`}
                  </td>
                  <td>{fmt(player.mondayAverage)}</td>
                  <td>{fmt(player.usedAverage)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!stats.length && <div className="empty">No player stats yet.</div>}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Weekly sessions</h3>
        {sessions.length ? (
          sessions.map((session) => {
            const winner = session.results?.find((result) => result.won);
            const checkedIn =
              session.attendees?.length ||
              session.finalTeams.reduce(
                (sum, team) => sum + team.players.length,
                0,
              );
            const isEditing = editingId === session.id;
            const open = openId === session.id;
            return (
              <div key={session.id} className="history-session">
                <div className="history-row">
                  <button
                    type="button"
                    className="session-main"
                    onClick={() =>
                      setOpenId(open ? undefined : session.id)
                    }
                  >
                    <div className="session-title-line">
                      <strong>{session.sessionDate}</strong>
                      <span className="badge">
                        {checkedIn} checked in
                      </span>
                    </div>
                    <span className="session-meta">
                      {session.teamCount} teams
                      {session.scratchWinners?.length
                        ? ` · ${session.scratchWinners.length} scratch`
                        : ""}
                      {open ? " · hide" : " · details"}
                    </span>
                  </button>
                  <div className="history-actions">
                    {isEditing ? (
                      <button
                        type="button"
                        className="button small secondary"
                        disabled={busy}
                        onClick={() => removeSession(session)}
                      >
                        Delete
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button small secondary"
                        disabled={busy}
                        onClick={() => {
                          setOpenId(session.id);
                          startEdit(session);
                        }}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </div>
                {open && (
                  <div className="history-detail">
                    {isEditing && (
                      <label className="field" style={{ maxWidth: 220, marginBottom: 12 }}>
                        Date
                        <input
                          type="date"
                          value={editDate}
                          onChange={(event) => setEditDate(event.target.value)}
                        />
                      </label>
                    )}
                    <div className="team-grid">
                      {session.finalTeams.map((team) => {
                        const teamResult = session.results?.find(
                          (result) => result.teamName === team.name,
                        );
                        const ranked = [...(session.results ?? [])].sort(
                          (a, b) =>
                            b.finalTotal - a.finalTotal ||
                            a.teamName.localeCompare(b.teamName),
                        );
                        const last = ranked[ranked.length - 1];
                        // Only last place is LOSS. With 3 teams, 2nd is neither.
                        const lost =
                          Boolean(winner) &&
                          Boolean(last) &&
                          !teamResult?.won &&
                          team.name === last?.teamName &&
                          winner?.teamName !== team.name;
                        return (
                          <div
                            className={`card team-card ${teamResult?.won ? "team-win" : ""} ${lost ? "team-loss" : ""}`}
                            key={team.name}
                          >
                            <div className="team-head">
                              <h3>{team.name}</h3>
                              <span
                                className={`badge ${teamResult?.won ? "AUTO" : lost ? "loss" : ""}`}
                              >
                                {teamResult?.won
                                  ? "WIN"
                                  : lost
                                    ? "LOSS"
                                    : ranked.length > 2
                                      ? `#${ranked.findIndex((entry) => entry.teamName === team.name) + 1 || "—"}`
                                      : "—"}
                              </span>
                            </div>
                            {team.players.map((player) => {
                              const games = isEditing
                                ? editScores[player.id] ?? [null, null, null]
                                : session.scores?.[player.id] ?? [
                                    null,
                                    null,
                                    null,
                                  ];
                              return (
                                <div className="player-chip" key={player.id}>
                                  <div className="top">
                                    <NameWithScratch
                                      name={player.name}
                                      on={clubIds.has(String(player.id))}
                                    />
                                    {!isEditing && (
                                      <span className="muted">
                                        tot {playerSeriesTotal(games)}
                                      </span>
                                    )}
                                  </div>
                                  {isEditing ? (
                                    <div className="edit-score-row">
                                      {[0, 1, 2].map((gameIndex) => (
                                        <label key={gameIndex}>
                                          G{gameIndex + 1}
                                          <input
                                            type="number"
                                            min={0}
                                            max={300}
                                            value={games[gameIndex] ?? ""}
                                            onChange={(event) =>
                                              setEditScore(
                                                player.id,
                                                gameIndex,
                                                event.target.value,
                                              )
                                            }
                                          />
                                        </label>
                                      ))}
                                    </div>
                                  ) : (
                                    <div className="player-score-grid compact">
                                      {[0, 1, 2].map((gameIndex) => (
                                        <div
                                          className="player-score-cell"
                                          key={gameIndex}
                                        >
                                          <span className="muted">
                                            G{gameIndex + 1}
                                          </span>
                                          <strong>
                                            {games[gameIndex] ?? "—"}
                                          </strong>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                            {teamResult && (
                              <div className="team-totals">
                                <span>
                                  Final{" "}
                                  <strong>{teamResult.finalTotal}</strong>
                                </span>
                                <span>
                                  HDC{" "}
                                  <strong>
                                    +
                                    {teamResult.handicapTotal ??
                                      teamResult.handicapPerGame ??
                                      0}
                                  </strong>
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {session.scratchWinners?.length ? (
                      <p className="muted" style={{ marginTop: 12 }}>
                        Scratch tickets ($10):{" "}
                        {session.scratchWinners.map((winner, index) => (
                          <span key={`${winner.playerId}-${index}`}>
                            {index ? " · " : null}
                            {winner.name}
                            <ScratchMark on />
                            {` (${winner.wins}W)`}
                          </span>
                        ))}
                      </p>
                    ) : null}
                    {isEditing && (
                      <div className="actions" style={{ marginTop: 12 }}>
                        <button
                          className="button"
                          disabled={busy}
                          onClick={() => saveEdit(session.id)}
                        >
                          Save changes
                        </button>
                        <button
                          className="button secondary"
                          onClick={() => setEditingId(undefined)}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div className="empty">No saved sessions yet.</div>
        )}
      </div>
    </>
  );
}
