import { describe, expect, it } from "vitest";
import {
  parseLeagueReportHtml,
  parseSheetFilename,
  pickLatestSheet,
} from "@/lib/league-sync";

const SAMPLE_HTML = `
<table>
<tr><td>01</td><td>05/14/26</td><td><a href="seasons/20261/OH260514-01.pdf">OH260514-01.pdf</a></td></tr>
<tr><td>09</td><td>07/09/26</td><td><a href="seasons/20261/OH260709-09.pdf">OH260709-09.pdf</a></td></tr>
<tr><td>10</td><td>07/16/26</td><td><a href="seasons/20261/OH260716-10.pdf" target="_blank">OH260716-10.pdf</a></td></tr>
</table>
`;

describe("league sync HTML parsing", () => {
  it("parses sheet filenames into week and date", () => {
    expect(parseSheetFilename("OH260716-10.pdf")).toEqual({
      weekNumber: 10,
      dateLabel: "7/16/2026",
    });
  });

  it("extracts sheet links and picks the highest week", () => {
    const sheets = parseLeagueReportHtml(
      SAMPLE_HTML,
      "https://www.4thstreetbowl.com/bowl/leagues/report.php?l=OH&s=20261",
    );
    expect(sheets).toHaveLength(3);
    expect(sheets[0]).toMatchObject({
      filename: "OH260514-01.pdf",
      weekNumber: 1,
      url: "https://www.4thstreetbowl.com/bowl/leagues/seasons/20261/OH260514-01.pdf",
    });
    expect(pickLatestSheet(sheets)).toMatchObject({
      filename: "OH260716-10.pdf",
      weekNumber: 10,
    });
  });
});
