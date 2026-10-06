# UX Contract

This is a one-page English PWA for a weekly bowling league. The README is the project brief; `src/app/page.tsx`, `src/app/api/[...segments]/route.ts`, and the domain helpers in `src/lib/` implement its current workflows. Business rules stay in the API/domain layer. `DESIGN.md` records visual rules; CSS variables in `src/app/globals.css` are the runtime token source.

## Canonical UI ownership

| Capability      | Canonical owner                             | Source of truth                    | Allowed variants      | Verification                 |
| --------------- | ------------------------------------------- | ---------------------------------- | --------------------- | ---------------------------- |
| Table Selection | Native checkboxes in `src/app/page.tsx`     | This contract and page state       | Current-page roster   | Keyboard and selection flow  |
| Select/Listbox  | Native HTML `<select>` controls             | This contract and browser behavior | Native                | Keyboard and popup           |
| Date            | Native `<input type="date">`                | This contract and browser behavior | Native                | Keyboard and locale          |
| Form            | Native HTML inputs and owning page handlers | API/domain validation              | Create and edit       | Typecheck and relevant tests |
| Scrollbar       | Global `src/app/globals.css`                | `DESIGN.md` and CSS tokens         | Browser defaults      | Browser inspection           |
| Toast           | Page-level notice and existing status copy  | Owning page state                  | Success and error     | Workflow inspection          |
| CRUD            | Page handlers + API route + domain helper   | API/domain behavior                | Return to current tab | Relevant flow and tests      |

### Screen and flow owners

| Area                                      | Owner                              | Contract                                                                         |
| ----------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| Navigation and screen state               | `src/app/page.tsx`                 | Play, Club, and History are tabs in one page.                                    |
| Forms and list actions                    | Native HTML controls in `page.tsx` | Use buttons for actions, labeled inputs, and native selects for compact choices. |
| Scoring, averages, money, and persistence | API routes and `src/lib/`          | UI changes must preserve validated server/domain behavior.                       |
| Responsive layout and visual states       | `src/app/globals.css`              | Shared tokens and breakpoints; do not add screen-specific color systems.         |

## Play

- Check-in selection is separate from roster editing. The Generate action is disabled until enough ready players exist for the selected team count.
- In normal roster view, tapping a player's average locks or unlocks that value. A locked state is orange and exposed with `aria-pressed`; while the request is pending, the control is disabled. Roster Edit retains numeric average editing and explicit Lock/Unlock actions.
- Each night has three games. Previous is absent in Game 1 and available in Games 2 and 3. The next/final action remains disabled until every player on the active teams has a score.
- On narrow screens, keep Generate and game-navigation actions near the bottom without covering the page's scrollable content or the device safe area.
- Team score headers call the series average sum `Total`.

## Club

- Club is the source of truth for membership. Keep membership editing, payouts, and ledger ownership unchanged.
- Initial loads show loading copy, not an empty state. After data loads, show a true empty state when a section has no records. Load failures remain visible in the page notice and section copy.
- Do not change dues, ticket, payout, or ledger calculations as part of presentation work.

## History

- Default sort is Win % descending. Desktop headers and the mobile Change sort control use the same sort state and sorted rows.
- Desktop uses the full statistics table. At narrow widths, each player card shows name and average mode with W-L and Win % in the header, then one row of four labeled values: Games, HDC, Mon Avg, and Used Avg.
- Weekly sessions remain limited to the most recent three months by the existing page logic.
- Edit scores in a saved session changes player scores and the stats derived from them. Saved team results, scratch tickets, and prize records stay as recorded.

## Feedback and accessibility

- Keep actions native and keyboard-operable, preserve visible focus, and give icon-only controls accessible names.
- Preserve entered values on errors. Show pending state on the control that initiated a request and retain the existing API error feedback.
- Use the app's English copy, explicit score/stat labels, and visible focus states. Sticky actions must leave enough scroll space and respect safe-area insets.

## Verification

- Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` after UI changes.
- Compare Play, Club, and History at desktop and narrow phone widths; verify average lock/unlock, game navigation, mobile sort, and initial Club loading/empty states.
