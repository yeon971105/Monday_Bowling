export const DEFAULT_LEAGUE_REPORT_URL =
  "https://www.4thstreetbowl.com/bowl/leagues/report.php?l=OH&s=20261";

export interface LeagueSheetLink {
  weekNumber: number;
  dateLabel: string;
  filename: string;
  url: string;
}

const SHEET_HREF =
  /href=["']([^"']*seasons\/\d+\/(OH\d{6}-\d{2}\.pdf))["']/gi;
const FILENAME_PARTS = /^OH(\d{2})(\d{2})(\d{2})-(\d{2})\.pdf$/i;

function resolveUrl(href: string, reportUrl: string): string {
  return new URL(href, reportUrl).toString();
}

export function parseSheetFilename(filename: string): {
  weekNumber: number;
  dateLabel: string;
} | null {
  const match = FILENAME_PARTS.exec(filename);
  if (!match) return null;
  const [, yy, mm, dd, week] = match;
  const year = Number(yy) >= 70 ? `19${yy}` : `20${yy}`;
  return {
    weekNumber: Number(week),
    dateLabel: `${Number(mm)}/${Number(dd)}/${year}`,
  };
}

export function parseLeagueReportHtml(
  html: string,
  reportUrl: string,
): LeagueSheetLink[] {
  const byFilename = new Map<string, LeagueSheetLink>();
  for (const match of html.matchAll(SHEET_HREF)) {
    const href = match[1];
    const filename = match[2];
    const parts = parseSheetFilename(filename);
    if (!parts) continue;
    byFilename.set(filename, {
      weekNumber: parts.weekNumber,
      dateLabel: parts.dateLabel,
      filename,
      url: resolveUrl(href, reportUrl),
    });
  }
  return [...byFilename.values()].sort(
    (a, b) => a.weekNumber - b.weekNumber || a.filename.localeCompare(b.filename),
  );
}

export function pickLatestSheet(
  sheets: LeagueSheetLink[],
): LeagueSheetLink | null {
  if (!sheets.length) return null;
  return sheets.reduce((latest, sheet) =>
    sheet.weekNumber > latest.weekNumber ? sheet : latest,
  );
}

export async function fetchLeagueReportSheets(
  reportUrl = DEFAULT_LEAGUE_REPORT_URL,
): Promise<LeagueSheetLink[]> {
  const pageResponse = await fetch(reportUrl, {
    headers: { "User-Agent": "MondayBowling/1.0" },
    cache: "no-store",
  });
  if (!pageResponse.ok)
    throw new Error(
      `Could not load league report page (${pageResponse.status})`,
    );
  const html = await pageResponse.text();
  return parseLeagueReportHtml(html, reportUrl);
}

export async function downloadLeagueSheet(
  sheet: LeagueSheetLink,
): Promise<Buffer> {
  const pdfResponse = await fetch(sheet.url, {
    headers: { "User-Agent": "MondayBowling/1.0" },
    cache: "no-store",
  });
  if (!pdfResponse.ok)
    throw new Error(`Could not download ${sheet.filename} (${pdfResponse.status})`);
  const buffer = Buffer.from(await pdfResponse.arrayBuffer());
  if (!buffer.length) throw new Error(`Downloaded PDF ${sheet.filename} was empty`);
  return buffer;
}

export async function fetchLatestLeagueSheet(
  reportUrl = DEFAULT_LEAGUE_REPORT_URL,
): Promise<{ sheet: LeagueSheetLink; buffer: Buffer }> {
  const sheets = await fetchLeagueReportSheets(reportUrl);
  const sheet = pickLatestSheet(sheets);
  if (!sheet) throw new Error("No league sheet PDFs were found on the report page");
  const buffer = await downloadLeagueSheet(sheet);
  return { sheet, buffer };
}
