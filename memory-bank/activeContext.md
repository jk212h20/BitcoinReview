# Active Context

## Current Focus (Updated 2026-04-18)

### Session 34: Rebrand, secure admin auth, treasury log, polling overhaul, site-scoped budget guard

This was a long single conversation that touched almost every layer.
Outcomes are organized below by theme. Net effect: the project went
from a single-tenant prototype with shared-node leakage and password
in the URL to something that's safe to hand to a per-site admin.

#### Theme A — Brand & content polish

- **Rename** "Bitcoin Review Raffle" → **"Reviews Raffle"** project-wide
  (UI, routes, services, emails, telegram messages, README, .env.example,
  memory-bank). 67+ occurrences swapped.
- **Step 1 copy**: "Visit a merchant in Roatan and pay with Bitcoin (Onchain or Lightning)".
- **Step 2 copy**: "Leave a Google or Tripadvisor review mentioning your Bitcoin
  experience" — these are the two platforms Roatan merchants actually care about.

#### Theme B — Hero prize pool: visible above the fold

- New `src/services/price.js` — CoinGecko BTC/USD price with 5-min in-memory
  cache, concurrent-request dedupe, silent failure (returns null if upstream down).
- `/api/raffle-fund` now returns `btcUsd`, `totalFundUsd`, `nextPrizeUsd`.
- Homepage hero has a centered white prize card above the countdown:
  bold orange sats number (`text-bitcoin`, 3xl/5xl) with USD estimate
  smaller in gray below; total fund + "50% per raffle" footnote.
- Mobile prize badge moved out of the collapsed hamburger menu and pinned
  next to the menu icon so it's always visible (was buried before).

#### Theme C — Admin contact links (admin-configurable)

- New settings: `contact_telegram`, `contact_whatsapp`, `contact_email`.
- Middleware in `src/index.js` normalizes inputs (Telegram accepts `@handle`,
  `handle` or full URL; WhatsApp accepts any phone format and strips to digits
  for `wa.me/<digits>`; email is mailto:).
- Exposed via `res.locals.contact` to every render. Each link rendered only
  when the admin has set it.
- Visible in the layout footer and as a prominent "🏪 Missing a merchant?"
  callout on the submit page.
- Admin UI: 3-column "📮 Public Contact Links" section with explicit
  "Save contact links" button.

#### Theme D — Admin auth overhaul (session cookies + change-password)

This was the biggest change. The previous setup used `?password=` in the
URL bar and embedded the password in client-side JS.

- **New service `src/services/auth.js`**: scrypt-hashed passwords (Node
  stdlib, no new dep), HMAC-SHA256 signed cookies, 30-day sliding session.
  Cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
- New endpoints:
  - `POST /api/admin/login` — validates password, sets cookie, redirects.
  - `GET/POST /api/admin/logout` — clears cookie.
  - `POST /api/admin/change-password` — admin-page form, validates current
    password, stores new one as scrypt hash in `settings.admin_password_hash`
    (overrides `ADMIN_PASSWORD` env once set; env stays as bootstrap fallback).
- `adminAuth` middleware now accepts cookie OR raw password (back-compat)
  and auto-upgrades password-auth requests to a cookie. Legacy `?password=`
  visits to `/admin` get a 303 redirect to clean URL after the cookie is set
  — so the password disappears from address bar + history.
- Admin UI: "Log out" link in header; "🔑 Admin Password" card with
  current/new/confirm fields and a working Save button.
- Telegram morning-summary `/admin` link no longer carries `?password=`.
- `app.set('trust proxy', 1)` so `Secure` cookies work behind Railway TLS.

#### Theme E — Pay Winner Now: advertised prize, not 100-sat test default

- Bug: pay endpoint had fallback `amountSats || raffle.prize_amount_sats ||
  DEFAULT_PRIZE_SATS || 0`. If a real raffle was committed when the fund was
  empty, `prize_amount_sats` stored as `null`, and pay silently fell through
  to the env's leftover `100`.
- Fix: removed `DEFAULT_PRIZE_SATS` fallback. New priority:
  (1) explicit override → (2) stamped prize → (3) 50% of CURRENT fund.
- Pay button now reads "⚡ Pay X sats" using the stamped prize so the admin
  sees exactly what will send before clicking.
- Test Raffle still uses 100 sats as intended.

#### Theme F — Treasury Log

- New `GET /api/admin/treasury` — joins `deposit_addresses` (donations) +
  `raffles.paid_at` (payouts) + pending/failed raffles into a unified,
  time-sorted ledger. Returns full summary (totalDonated, totalPaidOut,
  reservedSats, reservedPendingSats, reservedFailedSats, netSats,
  currentFundSats, unaccountedSats).
- `?direction=in|out` filter; `?format=csv` returns RFC-4180 CSV download.
- New "💰 Treasury Log" card on `/admin` (top of page after unpaid alert)
  with 5 summary tiles + filter + Refresh + ⬇ Export CSV.
- "Reserved" tile and "Unaccounted" drift banner explain any gap between
  Net (in − out − reserved) and the live fund. The drift banner is
  informational; admins resolve drift by deleting offending raffles with
  refund (cleaner than a one-shot reconcile).
- (A `/treasury/reconcile` endpoint + button existed briefly but was removed
  once the site-budget guard made it unnecessary.)

#### Theme G — Site-scoped spending guard (CRITICAL safety fix)

The Voltage LND node is **shared across multiple sites**. Before this
change, an admin (or a buggy code path) could spend more than this site
had ever received in donations — draining sibling sites' funds.

- New helpers in `src/services/lightning.js`:
  - `getSiteAvailableSats()` = `totalDonated − totalPaidOut` (from local ledger).
  - `assertWithinBudget(sats, context)` — throws `BUDGET_EXCEEDED` with
    clear error when `sats > available`.
- Both pay primitives wired through the guard:
  - `payInvoice()` decodes BOLT11 and checks BEFORE contacting LND.
  - `payLightningAddress()` checks BEFORE LNURL callback resolution
    (so a refused payment has zero side effects).
- Multi-layered defense at the request boundary too:
  - `POST /admin/raffle/run` refuses if `prizeAmountSats > available`.
  - `POST /admin/raffle/test` refuses if 100-sat test exceeds available.
  - `POST /admin/raffle/:id/pay` rejects admin overrides that exceed the
    reserved (stamped) prize amount.
- **`/api/admin/lightning/status` redacted**: no longer exposes node alias,
  pubkey, channel balance, or block height. Returns ONLY:
  `{ configured, synced, siteAvailableSats, autoPayEnabled }`.
- Admin Lightning Card renamed "⚡ Lightning Status" with three site-scoped
  fields: connection status, "This site can spend up to X sats" (with
  tooltip explaining the shared-node distinction), Auto-Pay state.

#### Theme H — Polling overhaul (rate-limit fix)

User reported "Too many requests" replacing the treasury log after only
3 page loads. Root cause: client-side polling was running away.

- Pre-fix per-tab budgets (15-min window):
  - Badge poll on every page (`layout.ejs`): **90 reqs** (10s, no pause)
  - Claim page status poll: **300 reqs** (3s, no pause)
  - express-rate-limit keys by `req.ip` — shared NAT IPs (hotspot, café,
    cellular CGNAT) shared a single 100-req budget.
- Fixes:
  - Badge: 10s → 60s, pause when `document.hidden`, skip on `/admin`,
    skip if no badge element exists, exponential backoff on consecutive
    failures, silent on 429.
  - Claim page: 3s → 5s, pause on hidden, immediate refresh on focus,
    silent on 429.
  - Server: rate limit raised 100 → 300 per IP per 15 min, with explicit
    `skip` for `/api/admin/*` (auth-gated), `/api/raffle-fund`,
    `/api/claim/*/status`, `/api/health`.
- Verified: 15 badge + 3 homepage + 2 admin treasury + 180 claim polls = 0×429.
  Stress test 350× POST `/api/submit` still returns 50× 429 (write endpoints
  remain protected — exactly the right boundary).

## Current System State (post-Session 34)

**Live URL**: https://web-production-3a9f6.up.railway.app
**Branch**: main (no open work branches)

### Auth
- Admin auth: signed HttpOnly session cookie (30-day sliding); password
  in DB hash (scrypt) overrides `ADMIN_PASSWORD` env once set.
- No password ever in URL bar / browser history / server access logs.

### Spending
- Hard ceiling: `getSiteAvailableSats()` = donations − payouts.
- Enforced inside `lightning.payInvoice` and `lightning.payLightningAddress`
  (single chokepoint), plus belt-and-braces request-level checks on commit
  and pay endpoints.
- Test raffles still cost 100 sats (intentional).

### Admin UI shows
- Lightning Status (connection, site spend ceiling, auto-pay) — NO node
  alias / pubkey / channel balance.
- Treasury Log with full ledger, summary tiles (Donated / Paid out /
  Reserved / Net / Current fund), CSV export.
- Settings panel with explicit Save buttons for Review settings + Contact links.
- 🔑 Admin Password card.
- Log out link in header.

### Settings keys added this session
- `admin_password_hash` — scrypt hash; once set, overrides ADMIN_PASSWORD env.
- `contact_telegram`, `contact_whatsapp`, `contact_email`.

### Polling
- Badge: 60s active, paused when hidden, skipped on /admin or pages
  without the badge element.
- Claim status: 5s active, paused when hidden.
- Both back off silently on 429.

### Lessons captured this session
- **EJS template-literal escape doubling**: `admin.ejs` body is wrapped in
  a JS template literal that EJS feeds to `layout`. So `\n` in a string
  literal gets JS-decoded into a real newline before reaching the browser
  → unterminated string in `<script>` → silent SyntaxError → Alpine fails
  to hydrate → save buttons appear empty. Always use `\\n` in source.
  Bit us twice.
- **Rate limiter scope**: express-rate-limit defaults to per-IP keying;
  authenticated admins on shared IPs get locked out by their own dashboard
  if the limit is too tight. Auth-gated routes should be exempt.
- **Reservation accounting**: `commitRaffleResult` deducts the prize at
  commit time. Pending/failed raffles hold sats against the fund; explain
  the gap in the UI rather than letting Net ≠ Current fund look like a bug.

## Pending / next ideas (not started)

- Decide whether to also pause LND `subscribeToInvoices` reconnect loop
  during prolonged outages (currently retries every 5s forever).
- Consider Server-Sent Events for the badge instead of polling, since LND
  already detects deposits in real time. Would eliminate the timer entirely.

---

### Session 33: Multi-Location Architecture (replaces clonable approach)

**Decision:** Instead of cloning the whole site for each city, we now run all locations under one deployment with URL-based sub-sites (`/austin`, `/roatan`). One raffle, one DB, one LND node — locations are just filtered views. The `clonable` branch is now deprecated.

**What was built:**
- `locations.config.js` — Location registry with BTCMap bounding boxes. Roatan (default, serves at `/`) + Austin. To add a city: add entry here + deploy.
- `src/routes/location.js` — Full mini-site route handler: `/:slug`, `/:slug/submit`, `/:slug/merchants`, `/:slug/reviews`, `/:slug/raffles`, `/:slug/how-it-works`
- `src/services/btcmap.js` — New `getMerchantsForAreas(areas)` fetches merchants by bounding box rectangles. Supports multiple areas per location (Roatan + Utila).
- `src/services/database.js` — `location_slug` column on tickets, `getApprovedPublicTicketsByLocation()`, `getMostRecentlyReviewedMerchantByLocation()`
- `src/index.js` — Mounts location routes before page routes, injects default location into `res.locals`
- `src/routes/api.js` — Accepts `locationSlug` in submit payload, passes to `createTicket()`
- `src/views/layout.ejs` — Location-aware nav links (`locBase` prefix), AlpineJS communities dropdown, footer shows location description + communities list
- `src/views/submit.ejs` — `locationSlug` in Alpine data + fetch body
- Commits: `24aa7c2` (architecture), `fba0864` (fix `next('route')` in resolveLocation)
- **Deployed and verified** on Railway — all location routes return 200

**How it works:**
- `/` → Roatan (default, `isDefault: true`)
- `/austin` → Austin sub-site with Austin-specific merchants, reviews, nav links
- `/austin/submit` → Submit form pre-tagged with `locationSlug: 'austin'`
- All reviews enter the same global raffle pool
- Nav shows communities dropdown when >1 location exists

### Previous: Session 32: GitHub Issues System

### Previous: Session 27: Utila Merchants Added
- Merchants page now shows Bitcoin-accepting businesses from **both Roatan and Utila**
- `btcmap.js`: Added `getUtilaMerchants()` with Utila bounding box
- Files changed: `src/services/btcmap.js`, `src/views/merchants.ejs`, `src/routes/pages.js`, `public/styles.css`

### Previous: Session 26: Telegram Win Notifications for Players
- Players can optionally link their Telegram on the submit form to receive win notifications via DM
- Deep-link flow: "Connect Telegram" button → `t.me/Bot?start=notify_<PIN>` → bot links chat ID to user email
- PIN stored in `telegram_link_pins` setting (similar to admin invite PINs, 30min expiry)
- `telegram_chat_id` column added to `users` table
- Submit form auto-detects linked status on email blur (via `GET /api/telegram/link-status`)
- Returning users with pre-filled email see "✅ Telegram connected" automatically
- When a raffle winner has Telegram linked, `telegram.notifyWinner()` sends claim link via DM
- New API endpoints: `POST /api/telegram/link`, `GET /api/telegram/link-status`
- Bot webhook handles `/start notify_<PIN>` payload in `index.js`
- Files changed: `database.js`, `api.js`, `index.js`, `telegram.js`, `submit.ejs`

### Previous: Session 25: LNURL-withdraw claim-based raffle prizes

**What was done:**
- **Email-only submission:** Lightning address is now optional on the submit form. Only email is required upfront.
- **Claim-based prize distribution (LNURL-withdraw / LUD-03):**
  - When a raffle winner is selected, a unique claim token (UUID) is generated with 30-day expiry
  - Winner receives email with a "Claim Your Prize" button linking to `/claim/:token`
  - Claim page shows a QR code (bech32-encoded LNURL) that any Lightning wallet can scan
  - Wallet scans QR → fetches withdraw parameters → sends BOLT11 invoice → our LND node pays it
  - Works with **every** Lightning wallet: Phoenix, WoS, Muun, Breez, Zeus, BlueWallet, etc.
  - Claim page polls for status and shows success animation when claimed
- **New files:** `src/views/claim.ejs` (claim page with QR)
- **New routes:** `GET /claim/:token` (page), `GET /api/lnurl/withdraw/:token` (LUD-03 first call), `GET /api/lnurl/withdraw/:token/callback` (LUD-03 callback), `GET /api/claim/:token/status` (polling)
- **New DB columns on `raffles`:** `claim_token`, `claim_status` (pending/claimed/expired), `claim_expires_at`, `claimed_at`, `claim_payment_hash`
- **New DB functions:** `setRaffleClaimToken()`, `findRaffleByClaimToken()`, `markRaffleClaimed()`, `markRaffleClaimExpired()`, `getExpiredUnclaimedRaffles()`
- **Updated email:** Winner email now contains claim link + button instead of just notification
- **Updated views:** Raffles page and admin show claim status (Claimed/Awaiting/Expired) instead of Paid/Pending. Admin raffles tab shows claim links.
- **New dependency:** `bech32` npm package for LNURL encoding
- Files changed: `src/services/database.js`, `src/routes/api.js`, `src/routes/pages.js`, `src/services/email.js`, `src/index.js`, `src/views/submit.ejs`, `src/views/raffles.ejs`, `src/views/admin.ejs`, `src/views/claim.ejs`

**IMPORTANT: `BASE_URL` env var** must be set to the public HTTPS URL for LNURL-withdraw to work (wallets need to reach the callback URL). Already in `.env.example`.

**Previous limitation resolved:** Phoenix Wallet (Bolt12-only) users can now receive prizes — they scan the LNURL-withdraw QR code with Phoenix which supports LNURL-withdraw. No Lightning address needed upfront.

### Previous: Session 24: Test Raffle + BIP-353/Bolt12 detection

- Test Raffle button, delete raffle endpoint, BIP-353/Bolt12 detection
- Better Lightning payment error messages

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
| `review_link_mode` | `google` | `google` (Google Maps only) or `all` (Google/Yelp/TripAdvisor/etc.) |
| `raffle_auto_trigger` | `false` | Auto-**pay** winner when block mined (raffle result always auto-commits) |
| `extra_telegram_chats` | `` | Comma-separated extra admin Telegram chat IDs |
| `pending_telegram_message` | `` | JSON-encoded notification held during quiet hours |
| `raffle_fund_sats` | `0` | Dedicated raffle prize pool (sats). Prize = 50% of this per raffle. |
| `admin_password_hash` | (unset) | scrypt-hashed admin password set via /admin → 🔑 Admin Password card. Once set, overrides `ADMIN_PASSWORD` env. |
| `contact_telegram` | `` | Public Telegram contact (handle, @handle, or t.me URL). Shown in footer + submit page when set. |
| `contact_whatsapp` | `` | Public WhatsApp number (any format; normalized to digits for wa.me link). |
| `contact_email` | `` | Public email contact (rendered as mailto). |

## Pre-Launch Checklist
- [x] Fix Railway GitHub webhook (reconnected — auto-deploys working)
- [x] Fix merchant name in Telegram notifications (last_insert_rowid bug)
- [x] Seed raffle fund (100k sats via `POST /api/raffle-fund/add`) — **note: this seed
      bypassed deposit_addresses; a brief Reconcile button existed and was removed
      once the site-budget guard made it unnecessary.**
- [ ] Test full flow end-to-end: submit → Telegram → Approve → verify
- [x] **Change admin password from default — UI now exists at /admin → 🔑 Admin Password.**
      Once changed, the value lives in `settings.admin_password_hash` (scrypt) and
      overrides `ADMIN_PASSWORD` env.
- [ ] Verify Resend custom domain for production emails
- [ ] Turn on `raffle_auto_trigger` when ready
- [x] Set `contact_telegram` / `contact_whatsapp` / `contact_email` via /admin
      (whichever channels you want public).

## Important Notes
- **Live URL:** https://web-production-3a9f6.up.railway.app
- Code: https://github.com/jk212h20/BitcoinReview.git (branch: main)
- **Admin Telegram management:** `POST /api/admin/telegram/chats` with `{chatId: "..."}` to add admins
- **Admin auth:** session-cookie based; the legacy `?password=...` URL still works
  for back-compat (gets converted to a cookie + clean redirect).
- **Spending ceiling:** strict — `donations − payouts`. The shared LND node's
  channel balance is NOT visible to admins and is not the ceiling.
