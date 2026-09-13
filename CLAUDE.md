# Entre bicis y libros — Book Club App

Paola's latina book club in Amsterdam ("Entre bicis y libros"). Events calendar, book history carousel with member ratings, PDF library, member profiles, live raffle (Goblet-of-Fire style, gold fire) OR public live voting per event, monthly theme (temática), attendance + gamification leaderboard.

## Always Do First
- Invoke the `frontend-design` skill before writing any frontend code, every session, no exceptions.

## Tech Stack
| Layer | Tech |
|---|---|
| Backend | Node.js + Express (ESM, single `api.mjs`), port 3001 local |
| Database | Supabase — **ExecutionAI Lab project, schema `bookclub`** |
| Storage | Private bucket `bookclub-pdfs` — signed URLs only |
| Frontend | Single-file HTML pages, Tailwind CDN, inline JS, no build step |
| Dev server | `node serve.mjs` (port 3000) |
| Screenshots | `node screenshot.mjs http://localhost:3000 [label] [--width=N --height=N] [--full]` |
| Deploy | Render (API) + static hosting (HTML) |

## Auth
- **Members**: name picker + 4–6 digit PIN → `POST /api/login` → session token in localStorage `bcToken` (+ `bcMember` JSON). Header: `x-member-token`.
- **Admin (Paola)**: `x-admin-token` = `ADMIN_TOKEN` env var, stored in localStorage `adminToken`.

## Language Rule
- **Spanish** for all member-facing copy (pages, buttons, errors shown to users).
- **English** for code, comments, admin internals, docs.

## Design System — "velvet purple canal nights, gilded book edges"
Defined as inline `tailwind.config` in every page. Never default Tailwind palette names.

| Token | Value | Use |
|---|---|---|
| `noche` | `#1e1533` (base), darker `#150e24`, surface `#2a1f47`, line `#3d2f61` | plum-night backgrounds |
| `marigold` | `#d9a441` | antique gold — CTAs, brand accent |
| `orquidea` | `#c9679a` | orchid — secondary accent, errors, vote highlights |
| `crema` | `#f7f0e6` (dim `#b5a9cf`) | ivory text & cards / lavender-grey muted |
| `caliz` / `goblet` | `#f5c96b` | luminous gold — RESERVED for raffle/vote magic moments |

Brand mark: inline SVG bike wheel (8 spokes, gold stroke) + `Entre bicis <em>y libros</em>` in every nav.

- Fonts: **Fraunces** (display serif, headings) + **Karla** (body). Never same font for both.
- Layered color-tinted shadows (no flat `shadow-md`), grain overlay on heroes, `mix-blend-multiply` gradient treatment on book covers.
- Animate only `transform` and `opacity`. Never `transition-all`.
- Every clickable: `hover`, `focus-visible`, `active` states.
- Mobile-first.

## Book Lifecycle
`suggested` → `picked` (raffle draw OR vote close) → `reading` → `read` (event completed, `read_at` set).
Status flag lives on `bookclub.books.status` — API endpoints flip it (draw, close-vote, complete); pages filter by it.

## Key Flows
- **Selection method**: `events.selection_method` = `'raffle' | 'vote'`, admin picks per event (locked once decided). Both paths finalize via the shared `finalizeWinner()` helper → `status='raffled'` + `drawn_at` (one state machine for both).
- **Raffle**: admin `POST /api/admin/events/:id/draw` (idempotent via guarded update on `winning_suggestion_id IS NULL`; 400 on vote events). Clients poll `GET /api/events/:id/raffle` every 2s. `rifa.html` plays the animation locally when state flips to `drawn`; late joiners (drawn_at > 90s ago) skip to static result. rifa.html ↔ votacion.html redirect each other based on `selection_method`.
- **Voting**: PUBLIC live poll on `votacion.html` (polls `GET /api/events/:id/votes` every ~3s — tallies AND voter names visible). `PUT /api/events/:id/vote` — one vote per member per round (`UNIQUE(event_id, member_id, round)`), changeable until close; blocked after `events.vote_deadline` (JS-side date compare — mockdb has no gt/lt). Admin `POST /api/admin/events/:id/close-vote` (idempotent): unique max → finalize; **tie → runoff round** (`vote_round`+1, `runoff_candidate_ids` restricts the ballot, old votes stay archived by round; update guarded on `vote_round` against double-click).
- **Suggestions**: one per member per event (`UNIQUE(event_id, member_id)`), replaceable until draw — on vote events also locked once ANY votes exist (the upsert keeps the row id, so replacing would silently repoint votes at a different book).
- **Theme (temática)**: `events.theme` text; admin sets it on create or any time via PATCH (inline "Guardar temática" in admin). Shown on home ticket, evento.html header, votacion.html chip.
- **Ratings**: 0–10 scale in half-point steps (`numeric(3,1)` + CHECK), private note per member per book.

## Env Vars (`.env`)
```
MOCK=1                      # in-memory demo data (all PINs 1234); remove to use Supabase
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
ADMIN_TOKEN
PORT=3001
```
Mock mode (`mockdb.mjs`) mimics the supabase-js subset used by `api.mjs` and preloads demo members/books/events — used when `MOCK=1` or Supabase env vars are missing.

## Dev Workflow
```bash
node api.mjs      # API on :3001 (also serves static files)
node serve.mjs    # static dev server on :3000
node screenshot.mjs http://localhost:3000 home
node seed.mjs     # idempotent backfill of members/past books/ratings
```
- Never screenshot `file:///` URLs. Do ≥2 compare→fix screenshot rounds per page.
- `API_BASE` in pages: `localhost` → `http://localhost:3001`, else Render URL.
- `node smoke-test.mjs` — 58-check API test suite incl. voting/runoff (run against mock mode; restart api.mjs first — each run mutates the in-memory state).
- `node verify-raffle.mjs <event_id>` — two-window raffle sync verification with screenshots.
- `node debug-page.mjs <url> [--ls=…]` — dump browser console errors for a page.
- `screenshot.mjs` extras: `--delay=MS`, `--ls="k=v;k2=v2"` or `--ls-env` (reads `SCREENSHOT_LS`) to inject localStorage (auth tokens).
- Port 3000 is often taken by other projects — `api.mjs` (3001) serves the static files too; screenshot against 3001.

## Rules
- Never push to git unless explicitly told.
- No `window.confirm()` — branded modals.
- Escape HTML via data attributes, never inline string interpolation in `onclick`.
- Practical over perfect — ~10-30 members, no over-engineering.
