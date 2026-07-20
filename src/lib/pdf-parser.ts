import type { ParsedLeaguePdf, ParsedPdfPlayer } from "./types";

const TEAM_HEADING =
  /^\s*(?:Team\s+)?(\d{1,3})\s*-\s*(.+?)(?:\s+Lane\s+\d+\s+Avg\s*=\s*\d+)?\s*$/i;
const META_WEEK = /\bweek\s*(?:no\.?|number|#)?\s*[:#-]?\s*(\d{1,3})\b/i;
const META_DATE = /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/;
const SUB_HEADING = /temporary\s+sub|temp(?:orary)?\s+sub|substitute/i;
const BOWLING_CENTER = /^\s*(.+?\b(?:Bowl|Bowling Center|Lanes))\s*$/im;

function numberOrNull(token: string): number | null {
  if (/^_+$/.test(token)) return null;
  const value = Number(token.replace(/^bk/i, "").replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function normalizePrintedName(name: string): string {
  const cleaned = name
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.{3,}$/, "")
    .trim();
  if (cleaned.includes(",")) {
    const [last, first] = cleaned.split(",", 2).map((part) => part.trim());
    if (last && first) return `${first} ${last}`;
  }
  return cleaned;
}

type LeadingColumns = {
  currentAverage: number | null;
  pdfHandicap: number | null;
  games: number | null;
  pins: number | null;
  averageWasBook: boolean;
};

function parseLeadingColumns(raw: string): LeadingColumns | null {
  const tokens = raw.trim().split(/\s+/);
  if (tokens.length < 4) return null;
  const first = tokens[0];
  const averageWasBook = /^bk/i.test(first);

  if (/^\d{4,6}$/.test(first)) {
    // Extractors can collapse AVG and HDCP: 97 + 110 becomes 97110.
    const candidates: LeadingColumns[] = [];
    for (let averageLength = 1; averageLength <= 3; averageLength++) {
      const averageToken = first.slice(0, averageLength);
      const handicapToken = first.slice(averageLength);
      if (!/^\d{1,3}$/.test(handicapToken)) continue;
      const currentAverage = Number(averageToken);
      const pdfHandicap = Number(handicapToken);
      const games = numberOrNull(tokens[1]);
      const pins = numberOrNull(tokens[2]);
      if (
        currentAverage > 300 ||
        pdfHandicap > 220 ||
        games === null ||
        games <= 0 ||
        pins === null
      )
        continue;
      const configuredHandicap = Math.max(
        0,
        Math.floor((220 - currentAverage) * 0.9),
      );
      const pinAverage = Math.floor(pins / games);
      if (
        Math.abs(pinAverage - currentAverage) <= 2 &&
        Math.abs(configuredHandicap - pdfHandicap) <= 1
      ) {
        candidates.push({
          currentAverage,
          pdfHandicap,
          games,
          pins,
          averageWasBook: false,
        });
      }
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  const currentAverage = numberOrNull(first);
  if (currentAverage === null && !/^_+$/.test(first)) return null;
  return {
    currentAverage,
    pdfHandicap: numberOrNull(tokens[1]),
    games: numberOrNull(tokens[2]),
    pins: numberOrNull(tokens[3]),
    averageWasBook,
  };
}

/**
 * Parse BLS Team Rosters using the leading AVG, HDCP, GMS, and PINS structure.
 * Later Book Average and high-score values are intentionally never considered
 * authoritative import averages.
 */
export function parseBlsText(text: string): ParsedLeaguePdf {
  const errors: string[] = [];
  const players: ParsedPdfPlayer[] = [];
  const normalized = text.replace(/\r/g, "");
  const lines = normalized.split("\n");
  const rosterIndex = lines.findIndex((line) => /team\s+rosters/i.test(line));
  const relevant = rosterIndex >= 0 ? lines.slice(rosterIndex + 1) : lines;
  if (rosterIndex < 0)
    errors.push(
      "Team Rosters heading was not found; scanned the entire document.",
    );

  const headerLines = lines.slice(0, Math.max(rosterIndex, 20));
  const leagueName =
    headerLines.find((line) => /^\s*ohana league\s*$/i.test(line))?.trim() ??
    lines
      .find((line) => /league/i.test(line) && !/league\s+sheet/i.test(line))
      ?.trim() ??
    null;
  const weekMatch = normalized.match(META_WEEK);
  const dateMatch = normalized.match(META_DATE);
  let currentTeamNumber: number | null = null;
  let currentTeamName: string | null = null;
  let inTemporarySubstitutes = false;

  for (const raw of relevant) {
    const line = raw
      .replace(/\f/g, " ")
      .replace(/([A-Za-z])bk(?=\d{1,3}\b)/g, "$1 bk")
      .trim();
    if (!line) continue;
    if (/^(?:team\s+)?rosters?$/i.test(line)) continue;
    if (SUB_HEADING.test(line)) {
      inTemporarySubstitutes = true;
      currentTeamNumber = null;
      currentTeamName = null;
      continue;
    }
    const team = line.match(TEAM_HEADING);
    if (team) {
      currentTeamNumber = Number(team[1]);
      currentTeamName = team[2]
        .replace(/\s+Lane\s+\d+\s+Avg\s*=\s*\d+\s*$/i, "")
        .trim();
      inTemporarySubstitutes = false;
      continue;
    }
    if (/^Lane\s+\d+\s+Avg\s*=/i.test(line)) continue;
    if (
      /name.*\bavg\b.*\b(?:hdcp|hcp)\b.*\b(?:gms|games)\b.*\bpins\b/i.test(line)
    )
      continue;
    if (/^(?:page|league|date|week|bowler|team total|book|bls-)/i.test(line))
      continue;

    // PDF extraction sometimes removes the space between a name and its AVG
    // (for example "Anny Vien132"), so the first numeric or bk token marks
    // the structural boundary instead of relying on whitespace alone.
    const match = line.match(/^\s*(.+?)(bk\d{1,3}|\d{1,6}|_+)\s+(.+)$/i);
    if (!match) {
      if (
        /\d/.test(line) &&
        /[A-Za-z]/.test(line) &&
        !/high game|high series|average|standing/i.test(line)
      )
        errors.push(`Unparsed roster line: ${line}`);
      continue;
    }
    const [, rawName, firstColumn, remainingColumns] = match;
    const rawColumns = `${firstColumn} ${remainingColumns}`;
    const printedName = normalizePrintedName(rawName.replace(/^\*+|\*+$/g, ""));
    if (
      !/[A-Za-z]/.test(printedName) ||
      /^(team|total|average|name)$/i.test(printedName)
    )
      continue;
    const columns = parseLeadingColumns(rawColumns);
    if (!columns) {
      if (/\d/.test(rawColumns)) errors.push(`Unparsed roster line: ${line}`);
      continue;
    }
    const player: ParsedPdfPlayer = {
      printedName,
      currentAverage: columns.currentAverage,
      pdfHandicap: columns.pdfHandicap,
      games: columns.games,
      pins: columns.pins,
      teamNumber: currentTeamNumber,
      teamName: currentTeamName,
      temporarySubstitute: inTemporarySubstitutes || /^\*/.test(rawName),
      raw,
    };
    if (
      player.currentAverage !== null &&
      (player.currentAverage < 0 || player.currentAverage > 300)
    )
      player.error = "Average is outside 0-300";
    if (
      !columns.averageWasBook &&
      player.currentAverage !== null &&
      player.games &&
      player.pins !== null
    ) {
      const pinAverage = Math.floor(player.pins / player.games);
      if (Math.abs(pinAverage - player.currentAverage) > 2)
        player.error = `Pins/games (${pinAverage}) does not agree with average (${player.currentAverage})`;
    }
    players.push(player);
  }

  if (!players.length) errors.push("No player rows were recognized.");
  return {
    leagueName,
    bowlingCenter: normalized.match(BOWLING_CENTER)?.[1]?.trim() ?? null,
    leagueDate: dateMatch?.[1] ?? null,
    weekNumber: weekMatch ? Number(weekMatch[1]) : null,
    players,
    errors,
  };
}
