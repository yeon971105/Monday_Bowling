---
version: alpha
name: Dopamine Bowling
description: A compact, friendly bowling-league scorecard for weekly play.
colors:
  ink: "#13231d"
  muted: "#65736d"
  paper: "#f7f6f1"
  card: "#ffffff"
  line: "#dfe5df"
  primary: "#176b4b"
  primary-dark: "#0f4d37"
  success-soft: "#dff4e9"
  accent: "#d96d2a"
  danger: "#a93636"
typography:
  sans:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
rounded:
  sm: "0.5rem"
  md: "0.625rem"
  lg: "1rem"
spacing:
  section-gap: "1rem"
  page-max: "77.5rem"
components:
  button: {}
  card: {}
  input: {}
---

# Dopamine Bowling Design System

## Overview

### Creative North Star

A well-kept league scorecard: warm paper around clear green team markers, with orange reserved for a deliberate locked average. The interface should feel familiar at the lanes and keep scores quick to scan on a phone.

### Product context and register

- **Audience and primary job:** Weekly league bowlers check in, build teams, enter three game scores, and review club and player records.
- **Target market and evidence:** US bowling league; the project README specifies America/Los_Angeles for club dues.
- **Locale and language:** English UI. Dates and numbers use browser locale unless a league rule states otherwise.
- **Usage scene:** Repeated use at league night, including phones; score entry and player names need to remain visible at narrow widths.
- **Register:** Practical product UI with a small bowling-ball brand mark.
- **Memorable signature:** Deep green team identity and orange locked-average state.
- **Restraint:** Keep data labels explicit, avoid decorative competition graphics, and preserve full player names and scores.
- **Anti-references:** Dense spreadsheet-only mobile layouts and high-gloss sports dashboards that obscure entry tasks.
- **Token ownership/runtime mapping:** This file records the established system; runtime tokens are canonical in `src/app/globals.css` (`:root`). Values are mirrored here and should change together. No generated-token pipeline exists.

## Colors

Use ink on warm paper, white cards, and muted gray-green supporting labels. Green marks primary actions and team identity. Orange marks a locked average; red marks destructive actions and scratch membership uses its own red S badge. Keep focus visible and use a pale green or orange surface with the corresponding semantic text color for selected states. The app currently has a light theme.

## Typography

Use the system sans stack with Inter first and platform sans fallbacks. Use medium or bold weight for names, actions, totals, and section headings; use muted text for labels. Keep numbers legible and aligned, and allow long names to wrap instead of clipping.

## Layout

The desktop shell is capped at 1240px with 20px side padding and a 12-column dashboard grid. Cards use a 16px gap. At 820px the navigation and dashboard reflow and History becomes player cards with the same sort state as the table; at 520px cards and controls use compact spacing. On mobile, Play's game navigation and Generate action stay near the bottom with safe-area padding. Preserve page scrolling and reserve room around sticky controls.

## Elevation and shapes

Use white cards with a thin green-gray border, 13–16px corners, and a soft green-gray shadow. Primary actions and cards remain rounded but not pill-shaped; badges and compact state labels may use pills. Dialog overlays use a dark translucent backdrop.

## Components

- **Buttons:** Green for the primary next action, white bordered for secondary actions, red for destructive actions. Keep a 44px minimum for primary controls and give icon-only controls an accessible name.
- **Fields:** White native inputs and selects with a green focus ring. Keep numeric input widths large enough for three-digit bowling scores.
- **Lists and tables:** Use compact rows on desktop. At phone widths, transform wide statistics into labeled cards; do not require horizontal scrolling to read player stats.
- **Loading and feedback:** Keep content geometry stable, show loading copy until data arrives, and place errors in the owning section or page notice.
- **Iconography and motion:** Use text and small native glyphs; no icon library or decorative motion is established. Respect reduced motion if transitions are added.

## Do's and Don'ts

- **Do:** Reuse the green, orange, paper, and card roles across Play, Club, and History.
- **Do:** Keep values and state visible without relying on color alone; buttons expose lock state semantically.
- **Don't:** Clip player names, three-digit averages, or score totals.
- **Don't:** show an empty state while a section is still loading.
