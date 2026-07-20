"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  computeGameResult,
  computeMoneySettlement,
  computeSeriesResults,
  emptyScores,
  gameMargins,
  GAMES_PER_SESSION,
  playerSeriesTotal,
  toSessionTeamResults,
  type MoneyLine,
  type ScoreMap,
  type TeamForScoring,
} from "@/lib/scoring";
import type {
  BalancingMode,
  GenerationResult,
  GeneratorPlayer,
  Player,
  PlayerStat,
  SessionTeamResult,
} from "@/lib/types";

type Tab = "play" | "history";
type PlayStep = "setup" | "game" | "summary";

type SyncResult = {
  ok: boolean;
  skipped: boolean;
  reason: string | null;
  weekNumber: number | null;
  leagueDate: string | null;
  updated: number;
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
  scores: ScoreMap;
  results: SessionTeamResult[];
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

const money = (value: number) => `$${value.toFixed(2)}`;

const newSeed = () => crypto.getRandomValues(new Uint32Array(3)).join("-");

const localDateInputValue = (now = new Date()) => {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

function syncBannerText(result: SyncResult): string {
  const week = result.weekNumber ? `Week ${result.weekNumber}` : "Latest sheet";
  if (result.skipped) return `${week} already up to date.`;
  return `${week}: updated ${result.updated} Monday member average${result.updated === 1 ? "" : "s"}.`;
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
      if (result.updated) refresh();
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
            <h1>Monday Bowling</h1>
            <small>Play · Score · History</small>
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
        {tab === "play" && (
          <PlayTab
            refreshKey={refreshKey}
            syncBusy={syncBusy}
            onSync={runSync}
            onSaved={refresh}
          />
        )}
        {tab === "history" && <HistoryTab refreshKey={refreshKey} />}
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
  const [teamCount, setTeamCount] = useState<2 | 3>(2);
  const [mode, setMode] = useState<BalancingMode>("BALANCED");
  const [date, setDate] = useState(localDateInputValue);
  const [seed, setSeed] = useState(newSeed());
  const [result, setResult] = useState<GenerationResult>();
  const [scores, setScores] = useState<ScoreMap>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [leagueOptions, setLeagueOptions] = useState<LeagueOption[]>([]);
  const [pickLeague, setPickLeague] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualAvg, setManualAvg] = useState("");
  const [avgDraft, setAvgDraft] = useState<Record<number, string>>({});
  const [moneyLines, setMoneyLines] = useState<MoneyLine[]>([]);
  const [savedOnce, setSavedOnce] = useState(false);

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
    setSelected((prev) => {
      if (prev.size) return prev;
      return new Set(
        roster.filter((player) => player.usedAverage != null).map((p) => p.id),
      );
    });
    const available = await api<{ players: LeagueOption[] }>(
      "/api/league/available",
    );
    setLeagueOptions(available.players);
  }, []);

  useEffect(() => {
    load().catch((error) => setMessage(error.message));
  }, [load, refreshKey]);

  const attendees = useMemo(
    () =>
      players.filter(
        (player) => selected.has(player.id) && player.usedAverage != null,
      ),
    [players, selected],
  );

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
      playerIds: team.players.map((player) => player.id),
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
      gameIndex,
    });
  }, [scoringTeams, scores, gameIndex]);

  const seriesResults = useMemo(() => {
    if (!scoringTeams.length) return [];
    return computeSeriesResults({
      teams: scoringTeams,
      scores,
      gameCount,
    });
  }, [scoringTeams, scores, gameCount]);

  const skipGameCount = gameResult?.complete
    ? gameIndex + 1
    : gameIndex;

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

  const generate = async (
    nextMode: BalancingMode,
    options?: { keepScores?: boolean; stayOnGame?: boolean },
  ) => {
    setBusy(true);
    setMessage("");
    try {
      if (participants.length < teamCount)
        throw new Error(`Select at least ${teamCount} players with averages`);
      const nextSeed = newSeed();
      setSeed(nextSeed);
      setMode(nextMode);
      const data = await api<GenerationResult>("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          players: participants,
          teamCount,
          mode: nextMode,
          seed: nextSeed,
        }),
      });
      setResult(data);
      if (options?.keepScores) {
        const ids = data.teams.flatMap((team) =>
          team.players.map((player) => player.id),
        );
        setScores((prev) => {
          const next = emptyScores(ids);
          for (const id of ids) {
            if (prev[id]) next[id] = [...prev[id]] as ScoreMap[string];
          }
          return next;
        });
      } else {
        setScores(
          emptyScores(
            data.teams.flatMap((team) => team.players.map((p) => p.id)),
          ),
        );
        setGameIndex(0);
        setGameCount(GAMES_PER_SESSION);
        setSavedOnce(false);
        setMoneyLines([]);
      }
      if (!options?.stayOnGame) setStep("game");
      setMessage(
        options?.keepScores ? "Teams reshuffled." : "",
      );
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const reshuffleTeams = () => {
    if (
      !confirm(
        "Reshuffle teams? Scores already entered stay with each bowler.",
      )
    )
      return;
    void generate(mode, { keepScores: true, stayOnGame: true });
  };

  const setScore = (playerId: string, value: string) => {
    setScores((prev) => {
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
      const series = computeSeriesResults({
        teams: scoringTeams,
        scores: clearedScores,
        gameCount: count,
      });
      const money = computeMoneySettlement({
        teams: result.teams.map((team) => ({
          name: team.name,
          averageSum: team.players.reduce(
            (sum, player) => sum + player.usedAverage,
            0,
          ),
          players: team.players.map((player) => ({
            id: player.id,
            name: player.name,
          })),
        })),
        scores: clearedScores,
        gameCount: count,
      });
      setMoneyLines(money);
      const sessionResults = toSessionTeamResults(series);
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
      const player = await api<Player>("/api/players", {
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
      setSelected((prev) => new Set(prev).add(player.id));
      onSaved();
      setMessage(`${name} added with MANUAL average ${average}.`);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const resetToSetup = () => {
    setStep("setup");
    setResult(undefined);
    setScores({});
    setGameIndex(0);
    setGameCount(GAMES_PER_SESSION);
    setMoneyLines([]);
    setSavedOnce(false);
  };

  return (
    <>
      {message && (
        <div
          className={`notice ${
            message.includes("saved") ||
            message.includes("added") ||
            message.includes("locked") ||
            message.includes("reshuffled") ||
            message.includes("Night")
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
              <p>Check attendance, set team count, fix averages, then generate.</p>
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
              <button className="button" onClick={() => setAddOpen(true)}>
                Add
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
                <button
                  className="button small secondary"
                  onClick={() =>
                    setSelected(
                      new Set(
                        players
                          .filter((player) => player.usedAverage != null)
                          .map((player) => player.id),
                      ),
                    )
                  }
                >
                  All with avg
                </button>
                <button
                  className="button small secondary"
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </button>
              </div>
            </div>
            <p className="muted" style={{ marginTop: -4 }}>
              Edit an average and press Lock to freeze it (won’t change on Sync).
            </p>
            <div className="roster-list" style={{ marginTop: 12 }}>
              {players.map((player) => (
                <div className="roster-row roster-edit" key={player.id}>
                  <input
                    type="checkbox"
                    checked={selected.has(player.id)}
                    onChange={() => toggle(player.id)}
                  />
                  <span className="roster-name">
                    <strong>{player.displayName}</strong>
                    <small className="muted">
                      {player.averageMode}
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
                      value={avgDraft[player.id] ?? ""}
                      onChange={(event) =>
                        setAvgDraft((prev) => ({
                          ...prev,
                          [player.id]: event.target.value,
                        }))
                      }
                    />
                    <button
                      className="button small secondary"
                      disabled={busy}
                      onClick={() => lockAverage(player)}
                    >
                      Lock
                    </button>
                  </div>
                </div>
              ))}
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
              Balance spreads high/low averages. Handicap is 90% of the team
              average-sum gap (fewer bowlers usually get more help).
            </p>
            <div className="actions" style={{ marginTop: 12 }}>
              <button
                className="button"
                disabled={busy}
                onClick={() => generate("BALANCED")}
              >
                Generate teams (Balance)
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => generate("RANDOM")}
              >
                Generate teams (Random)
              </button>
            </div>
          </div>
        </>
      )}

      {step === "game" && result && gameResult && (
        <>
          <div className="page-title">
            <div>
              <h2>Game {gameIndex + 1}</h2>
              <p>Enter scores. Results show when everyone has a number.</p>
            </div>
            <div className="actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={reshuffleTeams}
              >
                Reshuffle teams
              </button>
              <button className="button secondary" onClick={resetToSetup}>
                Back to setup
              </button>
            </div>
          </div>

          {gameResult.complete && (
            <div
              className={`notice ${gameResult.winnerName ? "success" : ""} result-banner`}
            >
              {gameResult.winnerName
                ? gameResult.margin != null
                  ? `${gameResult.winnerName} wins by ${gameResult.margin}`
                  : `${gameResult.winnerName} wins`
                : "Tie game"}
            </div>
          )}

          <div className="team-grid">
            {result.teams.map((team) => {
              const series = seriesResults.find(
                (entry) => entry.teamName === team.name,
              );
              const line = gameResult.teams.find(
                (entry) => entry.teamName === team.name,
              );
              const lost =
                gameResult.complete &&
                gameResult.lastName === team.name &&
                gameResult.winnerName !== team.name;
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
                    {gameResult.complete ? (
                      <span
                        className={`badge ${line?.won ? "AUTO" : lost ? "loss" : ""}`}
                      >
                        {line?.won
                          ? gameResult.margin != null
                            ? `WIN +${gameResult.margin}`
                            : "WIN"
                          : lost
                            ? gameResult.margin != null
                              ? `LOSS -${gameResult.margin}`
                              : "LOSS"
                            : "TIE"}
                      </span>
                    ) : null}
                  </div>

                  <div className="scoreboard single-game">
                    {team.players.map((player) => {
                      const games = scores[player.id] ?? [null, null, null];
                      return (
                        <div className="scoreboard-row single" key={player.id}>
                          <span>
                            <strong>{player.name}</strong>
                            <small className="muted">
                              avg {player.usedAverage}
                            </small>
                          </span>
                          <input
                            type="number"
                            min={0}
                            max={300}
                            aria-label={`${player.name} game ${gameIndex + 1}`}
                            value={games[gameIndex] ?? ""}
                            onChange={(event) =>
                              setScore(player.id, event.target.value)
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
                      <strong>
                        {gameResult.complete ? (line?.scratch ?? 0) : "—"}
                      </strong>
                    </div>
                    <div>
                      <span className="muted">HDC</span>
                      <strong>+{series?.handicapPerGame ?? 0}</strong>
                    </div>
                    <div className="team-score-total">
                      <span className="muted">Total</span>
                      <strong>
                        {gameResult.complete ? (line?.total ?? 0) : "—"}
                      </strong>
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
                onClick={() => setGameIndex((value) => value - 1)}
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
                    onClick={() => setGameIndex((value) => value + 1)}
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
                          : `#${team.place ?? "—"}`}
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

          <div className="team-grid" style={{ marginTop: 16 }}>
            {result.teams.map((team) => {
              const series = seriesResults.find(
                (entry) => entry.teamName === team.name,
              );
              const lost =
                series?.place != null &&
                !series.won &&
                series.place === seriesResults.length;
              const members = moneyLines.filter(
                (line) => line.teamName === team.name,
              );
              const teamDue = members.reduce(
                (sum, line) => sum + line.netDue,
                0,
              );
              return (
                <div
                  className={`card team-card ${series?.won ? "team-win" : ""} ${lost ? "team-loss" : ""}`}
                  key={team.name}
                >
                  <div className="team-head">
                    <h3>{team.name}</h3>
                    <strong className="due-pill">{money(teamDue)}</strong>
                  </div>
                  <div className="player-stats-list">
                    {team.players.map((player) => {
                      const line = members.find(
                        (entry) => entry.playerId === player.id,
                      );
                      const games =
                        scores[player.id] ?? [null, null, null];
                      const seriesTotal = line?.seriesTotal ?? 0;
                      const expected = player.usedAverage * gameCount;
                      const diff = seriesTotal - expected;
                      return (
                        <div className="player-stat-row" key={player.id}>
                          <div className="player-stat-top">
                            <strong>{player.name}</strong>
                            <strong className="due-amount">
                              {money(line?.netDue ?? 0)}
                            </strong>
                          </div>
                          <div className="player-score-grid">
                            {Array.from({ length: gameCount }, (_, index) => (
                              <div className="player-score-cell" key={index}>
                                <span className="muted">G{index + 1}</span>
                                <strong>{games[index] ?? "—"}</strong>
                              </div>
                            ))}
                            <div className="player-score-cell series">
                              <span className="muted">Series</span>
                              <strong>{seriesTotal}</strong>
                            </div>
                          </div>
                          <div
                            className={`player-vs-avg ${
                              diff > 0
                                ? "diff-up"
                                : diff < 0
                                  ? "diff-down"
                                  : "muted"
                            }`}
                          >
                            {diff > 0 ? "+" : ""}
                            {diff} vs avg
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </>
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

function HistoryTab({ refreshKey }: { refreshKey: number }) {
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [stats, setStats] = useState<PlayerStat[]>([]);
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
    if (!confirm(`Delete session ${session.sessionDate}?`)) return;
    setBusy(true);
    setMessage("");
    try {
      await api(`/api/sessions/${session.id}`, { method: "DELETE" });
      setSessions((prev) => prev.filter((entry) => entry.id !== session.id));
      if (openId === session.id) setOpenId(undefined);
      if (editingId === session.id) setEditingId(undefined);
      setMessage("Session deleted.");
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
          <p>Weekly scores, margins, wins, and Monday averages.</p>
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
                <th>Player</th>
                <th>W-L</th>
                <th>Win %</th>
                <th>Monday avg</th>
                <th>Used avg</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((player) => (
                <tr key={player.id}>
                  <td>
                    <strong>{player.displayName}</strong>
                    <br />
                    <small className="muted">{player.averageMode}</small>
                  </td>
                  <td>
                    {player.wins}-{player.losses}
                    {player.ties ? `-${player.ties}` : ""}
                  </td>
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
            const margins = gameMargins(session.results ?? []);
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
                        {winner ? winner.finalTotal : "—"}
                      </span>
                    </div>
                    <span className="session-meta">
                      {session.teamCount} teams ·{" "}
                      {session.mode === "RANDOM" ? "Random" : "Balanced"}
                      {winner ? ` · ${winner.teamName} won` : ""}
                      {open ? " · hide" : " · details"}
                    </span>
                  </button>
                  <div className="history-actions">
                    <button
                      type="button"
                      className="button small secondary"
                      disabled={busy}
                      onClick={() => startEdit(session)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="button small danger"
                      disabled={busy}
                      onClick={() => removeSession(session)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {open && (
                  <div className="history-detail">
                    <div className="margin-row history-margins">
                      {margins.map((game) => (
                        <span key={game.gameIndex}>
                          G{game.gameIndex + 1}:{" "}
                          {game.winnerName && game.margin != null ? (
                            <>
                              <strong>{game.winnerName}</strong>{" "}
                              <em className="diff-up">+{game.margin}</em>
                            </>
                          ) : (
                            <span className="muted">tie / —</span>
                          )}
                        </span>
                      ))}
                    </div>
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
                        const lost =
                          !teamResult?.won &&
                          winner &&
                          teamResult &&
                          team.name !== winner.teamName;
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
                                    <strong>{player.name}</strong>
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
