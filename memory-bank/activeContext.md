# Active Context

## Current Focus (Updated 2026-02-23)

### Session 24: Test Raffle now sends 100 sats + admin delete raffle

**What was done:**
- **Test Raffle button** now sends a real 100 sats Lightning payment, creates a raffle record in DB, winner shows in public raffle history
- **Delete raffle endpoint:** `DELETE /api/admin/raffle/:id` — admin can delete raffle records with optional refund to raffle fund
- **Delete button (🗑️)** added to every row in admin Raffles tab for easy cleanup
- Files changed: `src/routes/admin.js`, `src/services/database.js` (`deleteRaffle`), `src/views/admin.ejs`

### Previous: Session 23: Page load performance optimization

**What was done:**
- **Eliminated LND API calls from page routes:** Every page was calling `await lightning.getDepositInfo()` which hit the Voltage LND node to check invoice expiry — adding 500ms-2s per page load. Replaced with `lightning.getDepositInfoCached()` (synchronous, returns in-memory cache).
- **Background deposit refresh:** New `refreshDepositInfoIfNeeded()` runs every 5 min in the background polling interval, keeping deposit cache fresh without blocking page renders.
- **gzip compression:** Added `compression` middleware — ~70% smaller HTML/CSS/JSON responses.
- **Static asset caching:** `express.static` now sets `maxAge: '7d'` + ETags for `styles.css` — browser caches for a week, validates with conditional requests.
- **EJS view caching:** `app.set('view cache', true)` — compiled EJS templates cached in memory (no re-parsing on each request).
- **BTCMap pre-warming:** Merchant list fetched at startup so `/submit` and `/merchants` don't wait for external API on first load.
- **Link prefetching:** Added `<link rel="prefetch">` for all main pages — browser pre-downloads pages in the background so navigation feels instant.
- **Preconnect hints:** Added `<link rel="preconnect">` for `cdn.jsdelivr.net` (AlpineJS CDN).
- **Pinned AlpineJS version:** Changed from `@3.x.x` (resolves on every CDN hit) to `@3.14.8` (fixed version, better CDN caching).

**Impact:** Pages that previously took 1-2s (due to LND API round-trip on every request) now render in ~50-100ms for cached pages, ~200-500ms for pages that still call `bitcoin.getRaffleInfo()` (which has its own 5-min cache). Navigation between pages feels near-instant thanks to prefetching.

### Previous: Session 22: Instant Lightning deposit detection + fund corrections

**What was done:**
- **Real-time invoice subscription (`lightning.js`):** `subscribeToInvoices()` connects to LND `/v2/invoices/subscribe` streaming endpoint on startup. When any invoice settles, `handleSettledInvoice()` instantly credits the raffle fund — no more 5-minute polling delay.
- **Auto-reconnect:** If the subscription stream disconnects, it reconnects after 5 seconds.
- **Fixed custom-amount invoice detection:** `checkLightningDeposits()` now queries ALL unpaid Lightning invoices from DB via `getUnpaidLightningInvoices()`, not just the cached zero-amount one. Custom invoices from "Generate" button are now tracked.
- **Fund correction endpoint:** `POST /api/raffle-fund/set` — admin can set fund to exact amount (for corrections). Requires `ADMIN_PASSWORD`.
- **Frontend polling:** Reduced from 30s to 10s in `layout.ejs` — combined with instant backend detection, fund updates appear within ~10s of payment.
- **Railway start command:** Changed from `npm start` to `node --no-deprecation src/index.js` to eliminate npm warnings that Railway flagged as crashes.
- **Current fund:** 107,000 sats (100k seed + 2k + 4k + 1k donations)

### Previous: Session 21: Dedicated raffle fund tracker + 50% prize model

- Raffle fund tracked separately from LND node balance via `raffle_fund_sats` setting
- Prize = 50% of fund per raffle, other 50% carries over
- `GET /api/raffle-fund`, `POST /api/raffle-fund/add`, `POST /api/raffle-fund/set`
- Nav badge + homepage display with live polling
- Seeded 100k sats; `DEFAULT_PRIZE_SATS` env var no longer used

### Previous: Session 20: Donation address on all pages + QR code hover

**What was done:**
- **Routes (`pages.js`):** Added `donationAddress` (from Voltage node via `lightning.getDepositInfo()`) to reviews, merchants, how-it-works, and raffles routes — previously only index and submit had it
- **Layout footer (`layout.ejs`):** Upgraded donation display from plain `<code>` block to:
  - Clickable link → mempool.space address page
  - QR code popup on hover (using `api.qrserver.com` with `bitcoin:` URI)
  - 📋 Copy button with "✓ Copied!" feedback
  - AlpineJS-powered hover with smooth transitions
- **Submit page (`submit.ejs`):** Has its own duplicate footer (doesn't use layout.ejs) — updated with same QR/link treatment
- No more "Coming soon" text — shows actual Voltage node on-chain address or "Not configured" fallback

### Previous: Session 19: Transparent raffle commitment + public history

**Core change:** Raffle result is now **always** committed automatically when the trigger block is mined — using `block_hash mod ticket_count`. The `raffle_auto_trigger` setting now only controls whether **payment** is also automatic (renamed to "Auto-Pay Winner" in UI).

**What was done:**
- `checkRaffleEvents()` in `src/index.js` — always calls `commitRaffleResult()` when trigger block mined
- `commitRaffleResult()` — new function that deterministically selects winner, creates raffle record, sends notifications/emails; `autoPay` flag only controls Lightning payment
- **Homepage (`index.ejs`):** Shows latest raffle result with full verification data (block hash, formula, mempool.space link) — stays visible until next raffle
- **New `/raffles` page (`raffles.ejs`):** Public raffle history with verification for every past raffle + explanation of the algorithm
- **Admin panel (`admin.ejs`):** Yellow "Payment Needed" banner with ⚡ Pay button when unpaid raffle exists; Settings renamed "Auto-Pay Winner" with clarifying note
- **Navigation:** "Raffles" link added to desktop + mobile nav in `layout.ejs`

### Previous: Session 18: Fix Safari reload loop (two causes)

**Cause 1: Tailwind Play CDN** (commit `407a689`)
The site used `<script src="https://cdn.tailwindcss.com">` — a 3MB JS file that scans DOM, generates CSS via MutationObserver, and injects `<style>` tags. Safari's WebKit enters infinite layout/repaint loop with this approach.

**Fix:** Proper Tailwind CSS build pipeline:
- `tailwindcss` as devDependency with `tailwind.config.js` (bitcoin colors)
- `src/styles/input.css` → `public/styles.css` (22KB minified)
- All templates (`layout.ejs`, `submit.ejs`, `admin-review.ejs`) now use `<link href="/styles.css">`
- `npm run build` runs `tailwindcss` — Nixpacks auto-runs on Railway deploy
- **IMPORTANT:** When adding new Tailwind classes, run `npm run build:css` to regenerate

**Cause 2: Telegram Markdown corrupting URLs** (commit `456b26d`)
- Switched Telegram messages from `parse_mode: 'Markdown'` → `'HTML'`
- "View in Admin" link now uses `?token=` instead of `?password=`

### Previous sessions:
- **Session 17:** DB persistence fix — `DATABASE_PATH` → `/data/reviews.db` (Railway volume). Commit: `a477abc`
- **Session 16:** sql.js `last_insert_rowid` fix — read ID before `saveDatabase()`. Commit: `a26adb3`

## Telegram Review Flow (Complete)
When a review is submitted:
1. `notifyNewReview()` fires (respects quiet hours 6pm–9am Roatan — queues count, summary sent at 9am)
2. Admin gets Telegram message with:
   - Merchant name + submitter (masked email/LN address)
   - Review text preview (first 200 chars)
   - `[Open Review]` → Google Maps URL
   - `[👁 View in Admin]` → `/admin/review/:id?token=TOKEN` (mobile approve page)
   - `[✅ Approve]` → one-tap GET `/api/admin/tickets/:id/quick-approve?token=TOKEN`
   - `[❌ Reject]` → one-tap GET `/api/admin/tickets/:id/quick-reject?token=TOKEN`
3. After approve/reject: `notifyTicketDecision` confirms back to all admins

## Architecture Decisions
1. **Tech Stack:** Node.js + Express + SQLite (sql.js) + EJS templates
2. **No user logins:** Simple email + LNURL registration
3. **Raffle timing:** Bitcoin difficulty adjustment (every 2016 blocks)
4. **Winner selection:** Deterministic via `block_hash mod ticket_count`
5. **Review validation:** Manual admin approval via Telegram
6. **Lightning payments:** LND REST API via Voltage node
7. **Database:** sql.js (pure JS, no native compilation)
8. **Telegram auth:** Two auth methods — `ADMIN_PASSWORD` (browser) and `TELEGRAM_APPROVE_TOKEN` (one-tap)
9. **Quiet hours:** 6pm–9am Roatan time; all notifications (including reviews) queued during quiet hours, summary at 9am
10. **sql.js quirk:** `db.export()` resets `last_insert_rowid()` — always read ID before save

## DB Settings Keys
| Key | Default | Purpose |
|-----|---------|---------|
| `review_mode` | `manual_review` | auto_approve or manual_review |
| `raffle_auto_trigger` | `false` | Auto-**pay** winner when block mined (raffle result always auto-commits) |
| `extra_telegram_chats` | `` | Comma-separated extra admin Telegram chat IDs |
| `pending_telegram_message` | `` | JSON-encoded notification held during quiet hours |
| `raffle_fund_sats` | `0` | Dedicated raffle prize pool (sats). Prize = 50% of this per raffle. |

## Pre-Launch Checklist
- [x] Fix Railway GitHub webhook (reconnected — auto-deploys working)
- [x] Fix merchant name in Telegram notifications (last_insert_rowid bug)
- [x] Seed raffle fund (100k sats via `POST /api/raffle-fund/add`)
- [ ] Test full flow end-to-end: submit → Telegram → Approve → verify
- [ ] Change `ADMIN_PASSWORD` from default
- [ ] Verify Resend custom domain for production emails
- [ ] Turn on `raffle_auto_trigger` when ready

## Important Notes
- **Live URL:** https://web-production-3a9f6.up.railway.app
- Code: https://github.com/jk212h20/BitcoinReview.git (branch: main)
- **Next raffle block: #939,456** (~11 days away from 2026-02-21)
- **Admin Telegram management:** `POST /api/admin/telegram/chats` with `{chatId: "..."}` to add admins
