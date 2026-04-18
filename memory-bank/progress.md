# Progress

## What Works
- **Treasury Log** on /admin: full ledger of donations + payouts with summary
  tiles (Donated / Paid out / Reserved / Net / Current fund) and CSV export.
- **Site-scoped spending guard**: `lightning.payInvoice` and `payLightningAddress`
  refuse to send more than `donations − payouts`. The shared Voltage LND node's
  channel balance is no longer the ceiling.
- **Admin auth via signed cookies** (HttpOnly, SameSite=Lax, Secure in prod) —
  password is never in URL. /admin → 🔑 Admin Password card lets the admin
  rotate it without redeploying (stored as scrypt hash in settings).
- **Public contact links** (Telegram / WhatsApp / Email), admin-configurable,
  rendered in footer + submit page when set.
- **BTC→USD price service** with 5-min cache; hero card shows prize in sats
  (bold orange) with USD estimate below.
- **Smart polling**: badge poll 60s + paused on tab hidden + skipped on /admin
  and pages without the badge; claim status poll 5s + paused on hidden;
  exponential backoff on failures; silent on 429.
- **Rate limit refactor**: 300 reqs/15min/IP with `/api/admin/*`,
  `/api/raffle-fund`, `/api/claim/*/status`, `/api/health` exempt.
- **Pay Winner Now** uses the advertised (stamped) prize, not the leftover
  100-sat test default. Button label shows the exact amount that will send.
- **Shared-node info redacted** from /api/admin/lightning/status — no alias,
  pubkey, or channel balance leaked to per-site admin.
- Memory bank documentation created
- Node.js project setup (package.json, dependencies installed)
- Express server with routing (pages, API, admin routes)
- SQLite database with schema (using sql.js - pure JS, no native compilation)
- **Unified submit form** - single page with Google Review Link (required), Email (optional), Lightning Address (optional)
- Form fields hide on success, showing only success message + "Submit another review" link
- localStorage persistence for email and Lightning Address fields
- New unified API endpoint: `POST /api/submit-review` (creates participant + submits review in one step)
- Email service (registration confirmation, opt-out) - using Resend API
- btcmap.org integration (merchant list)
- **Anthropic API integration** - review validation via PPQ proxy (api.ppq.ai) using Claude claude-sonnet-4-20250514
- Bitcoin block API integration (raffle trigger via difficulty adjustment)
- **Bitcoin API caching** - 60-second cache on getRaffleInfo() with pre-warming on startup
- Raffle system (deterministic winner selection via block_hash mod ticket_count)
- Admin dashboard with login
- Railway deployment config (railway.json)
- GitHub repository setup (pushed to https://github.com/jk212h20/BitcoinReview.git)
- Server tested locally - runs on port 3000
- API stats endpoint working
- Homepage with clean CTAs (Submit a Review, How It Works) - no registration form
- **Lightning Network service** (`src/services/lightning.js`) - full LND REST API integration
- **Lightning Address payments** - resolve address → request invoice → pay invoice flow
- **Admin Lightning features** - node status, auto-pay on raffle, manual pay button
- **Database payment tracking** - payment_status, payment_hash, payment_error columns in raffles
- **✅ Deployed to Railway.app** - live at https://web-production-3a9f6.up.railway.app
- **✅ All environment variables configured on Railway** (PPQ API, Resend, LND, admin, etc.)
- **✅ Deposit address display on homepage** - On-chain Bitcoin address + Lightning invoice from Voltage node with QR codes, copy buttons, and custom invoice generator
- **✅ Public reviews page** (`/reviews`) - Shows all submitted reviews with stats, without exposing submitter email or lightning addresses
- **✅ HTML scraping + AI validation pipeline** - Puppeteer scrapes Google review pages, Claude AI validates Bitcoin mention, async non-blocking
- **✅ Transparent raffle commitment** - Raffle result always auto-commits from trigger block hash; `raffle_auto_trigger` only controls auto-payment
- **✅ Public raffle history page** (`/raffles`) - Verification data, block hashes, formula, mempool.space links
- **✅ Homepage raffle result** - Latest raffle stays visible with full verification until next raffle
- **✅ Admin unpaid-raffle banner** - Yellow alert with ⚡ Pay button when payment is pending
- **✅ Donation address on all pages** - Every page footer shows Voltage node on-chain address with clickable mempool.space link, QR code on hover, and copy button
- **✅ LNURL-withdraw claim-based prizes** - Winners get email with claim link → scan QR with ANY Lightning wallet → sats pulled from LND node. No Lightning address needed upfront. Works with Phoenix, WoS, Muun, Breez, Zeus, BlueWallet, etc.

## What's Left to Build
- [x] Node.js project setup (package.json, dependencies)
- [x] Express server with routing
- [x] SQLite database with schema
- [x] Landing page (clean CTAs, no registration form)
- [x] Unified review submission page (single form)
- [x] Email service (registration confirmation, opt-out)
- [x] btcmap.org integration (merchant list)
- [x] Anthropic API integration (review validation)
- [x] Bitcoin block API integration (raffle trigger)
- [x] Raffle system (winner selection)
- [x] Admin dashboard
- [x] Railway deployment config
- [x] GitHub repository setup
- [x] Performance optimization (API caching, removed unnecessary fetches)
- [x] Lightning Network service (LND REST API)
- [x] Lightning Address payment flow
- [x] Admin auto-pay and manual pay features
- [x] Admin LND node status display
- [x] Deploy to Railway.app
- [x] Configure environment variables on Railway
- [x] Set up email provider (switched from Nodemailer/SMTP to Resend API)
- [x] Get Anthropic API key configured (using PPQ proxy)
- [x] Configure Voltage LND node connection
- [x] Telegram admin notifications (CoraTelegramBot)
- [x] One-tap approve/reject via Telegram links
- [x] Mobile admin quick-review page (/admin/review/:id)
- [x] Email + LN address mandatory on submit
- [x] Fixed LEFT JOIN bug for anonymous tickets
- [ ] Test full review submission flow on production (incl. Telegram notification)
- [ ] Test Lightning payment flow end-to-end on production
- [ ] Verify domain in Resend for production emails
- [ ] Change admin password from default (admin123)

## Known Issues
- Email: Resend API key set, but using test sender (onboarding@resend.dev) - need to verify custom domain in Resend dashboard for production
- Admin password is default (admin123) - should be changed for production
- DEFAULT_PRIZE_SATS set to 100 (very low) - may need adjustment
- PPQ API key returning 401 - AI validation exists but non-functional until key is fixed
- Merchant name from Google Maps often null (extraction unreliable)
- ~~Database wiped on every deploy~~ **FIXED Session 17** — `DATABASE_PATH` now points to Railway volume `/data/reviews.db`

## Session Log

### Session 34 (2026-04-17 → 2026-04-18)
**Theme:** Rebrand, secure admin auth, treasury log, polling overhaul,
site-scoped spending guard. 14 commits, no schema migrations.

**A. Brand & content polish**
- Rename "Bitcoin Review Raffle" → "Reviews Raffle" project-wide (67+ refs).
- Step 1 copy: "...pay with Bitcoin (Onchain or Lightning)".
- Step 2 copy: "Leave a Google or Tripadvisor review..." (the two platforms
  Roatan merchants actually care about).
- Commits: `bbdf35b`, `f21f2f0`, `3cd75fa`, `c53792f`.

**B. Hero prize pool**
- New `src/services/price.js` (CoinGecko BTC/USD, 5-min cache, dedupe,
  silent failure).
- `/api/raffle-fund` extended with `btcUsd`, `totalFundUsd`, `nextPrizeUsd`.
- Centered white hero card above the countdown: bold orange sats
  (text-bitcoin, 3xl/5xl), USD estimate small in gray below, total
  fund + "50% per raffle" footnote.
- Mobile prize badge moved out of collapsed hamburger menu and pinned
  next to the menu icon (was buried before).

**C. Public contact links**
- New settings: `contact_telegram`, `contact_whatsapp`, `contact_email`.
- Middleware in `src/index.js` normalizes inputs (Telegram accepts handle/
  @handle/URL; WhatsApp strips to digits for wa.me/<digits>; email mailto).
- Exposed via `res.locals.contact` to every render. Hidden when not set.
- Admin UI: 3-column "📮 Public Contact Links" in Settings with explicit Save button.
- Rendered in layout footer + prominent "🏪 Missing a merchant?" callout
  on submit page.
- Commits: `bbdf35b` (initial Telegram+Email), `ef738ea` (WhatsApp added).

**D. Admin auth overhaul** (CRITICAL — `2752fd9`)
- Previous setup leaked password in URL (`?password=`) and embedded it in
  client-side JS.
- New `src/services/auth.js`: scrypt password hashing (Node stdlib, no new
  dep), HMAC-SHA256 signed cookies, 30-day sliding session.
- Endpoints: `POST /api/admin/login`, `GET/POST /api/admin/logout`,
  `POST /api/admin/change-password`.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in production.
- `adminAuth` middleware accepts cookie OR raw password (back-compat) and
  auto-upgrades password-auth requests to a cookie.
- Legacy `/admin?password=...` visits get a 303 redirect to clean URL after
  cookie is set — password vanishes from address bar + history.
- New "🔑 Admin Password" card with current/new/confirm fields. Once set,
  scrypt hash in `settings.admin_password_hash` overrides ADMIN_PASSWORD env.
- "Log out" link in admin header; Telegram morning-summary `/admin` link
  no longer carries `?password=`.
- `app.set('trust proxy', 1)` so `Secure` cookies work behind Railway TLS.

**E. Pay Winner Now: advertised prize, not 100-sat test default** (`0921340`)
- Bug: pay endpoint had fallback chain ending in `DEFAULT_PRIZE_SATS` env
  (=100). If a real raffle was committed when the fund was empty,
  `prize_amount_sats` stored as null and pay silently used 100 sats.
- Fix: removed env fallback. Priority: explicit override → stamped prize →
  50% of CURRENT fund. Pay button label now reads "⚡ Pay X sats" with the
  actual amount.
- Test Raffle still uses 100 sats as intended.

**F. Treasury Log** (`72a6d5b`, refined `b0af10e`, `1dbdd7d`/`d4067c4` for
brief reconcile button add+remove)
- New `GET /api/admin/treasury` joins deposit_addresses (donations) +
  raffles.paid_at (payouts) + pending/failed raffles into one ledger.
- Returns full summary (totalDonated, totalPaidOut, reservedSats,
  reservedPendingSats, reservedFailedSats, netSats, currentFundSats,
  unaccountedSats).
- `?direction=in|out` filter; `?format=csv` returns RFC-4180 CSV download
  with proper Content-Disposition.
- New "💰 Treasury Log" card on /admin (top of page after unpaid alert)
  with 5 summary tiles + filter dropdown + Refresh + ⬇ Export CSV.
- "Reserved" tile and "Unaccounted" drift banner explain any gap between
  Net (in − out − reserved) and the live fund. Drift banner is
  informational; admins resolve drift by deleting offending raffles
  with refund (cleaner than a one-shot reconcile).
- Brief `/treasury/reconcile` endpoint + button shipped in `1dbdd7d`,
  removed in `d4067c4` once the site-budget guard made it unnecessary.

**G. Site-scoped spending guard** (`9148bd0`) — CRITICAL
- The Voltage LND node is shared across multiple sites. Before this fix,
  an admin or buggy code path could spend more than this site had ever
  received in donations — draining sibling sites' funds.
- New `src/services/lightning.js` helpers:
  - `getSiteAvailableSats()` = totalDonated − totalPaidOut (from local ledger).
  - `assertWithinBudget(sats, context)` throws `BUDGET_EXCEEDED` when
    sats > available.
- Both pay primitives wired through the guard:
  - `payInvoice()` decodes BOLT11 and checks BEFORE contacting LND.
  - `payLightningAddress()` checks BEFORE LNURL callback resolution
    (so a refused payment has zero side effects).
- Multi-layered defense at the request boundary too:
  - `POST /admin/raffle/run` refuses if prizeAmountSats > available.
  - `POST /admin/raffle/test` refuses if 100-sat test exceeds available.
  - `POST /admin/raffle/:id/pay` rejects admin overrides exceeding the
    reserved (stamped) prize.
- `/api/admin/lightning/status` redacted: no longer exposes node alias,
  pubkey, channel balance, or block height. Returns ONLY:
  `{ configured, synced, siteAvailableSats, autoPayEnabled }`.
- Admin Lightning Card renamed "⚡ Lightning Status" with three site-scoped
  fields: connection state, "This site can spend up to X sats" (with
  tooltip), Auto-Pay state.
- Verified: focused unit test proved 900 > 800 refused (BUDGET_EXCEEDED),
  800 = 800 allowed (boundary), 500 < 800 allowed. Live admin endpoint
  returned only the four redacted fields.

**H. Polling overhaul** (`84a623c`, `44f945f`) — fixed "Too many requests"
- Pre-fix per-tab budgets (15-min window):
  - Badge poll on every page (layout.ejs): 90 reqs (10s, no pause)
  - Claim page status poll: 300 reqs (3s, no pause)
- express-rate-limit keys by req.ip — shared NAT IPs (hotspot, café,
  cellular CGNAT) shared a single 100-req budget.
- Fixes:
  - Badge: 10s → 60s, pause when document.hidden, skip on /admin, skip
    if no badge element on page, exponential backoff on failures, silent
    on 429.
  - Claim page: 3s → 5s, pause on hidden, immediate refresh on focus,
    silent on 429.
  - Server: rate limit raised 100 → 300 per IP per 15 min, with explicit
    skip for /api/admin/*, /api/raffle-fund, /api/claim/*/status, /api/health.
- Verified: 15 badge + 3 homepage + 2 admin treasury + 180 claim polls = 0×429.
  Stress test 350× POST /api/submit still triggers 50× 429 (write endpoints
  remain protected).

**Lessons captured this session**
- **EJS template-literal escape doubling**: `admin.ejs` body is wrapped in
  a JS template literal that EJS feeds to `layout`. So `\n` in a string
  literal gets JS-decoded into a real newline before reaching the browser
  → unterminated string in `<script>` → silent SyntaxError → Alpine fails
  to hydrate → save buttons appear empty. Always use `\\n` in source.
  Bit us twice this session.
- **Rate limiter scope**: express-rate-limit defaults to per-IP keying;
  authenticated admins on shared IPs get locked out by their own dashboard
  if the limit is too tight. Auth-gated routes should be exempt.
- **Reservation accounting**: `commitRaffleResult` deducts the prize at
  commit time. Pending/failed raffles hold sats against the fund;
  expose them as their own "Reserved" tile rather than letting Net ≠
  Current fund look like a bug.
- **Always validate inline scripts after touching admin.ejs**: `node --check`
  on the extracted `<script>` content catches the EJS double-escape class
  of bug in seconds. Added to the regression test workflow.

### Session 33 (2026-04-08)
- **Multi-location architecture** (replaces clonable branch approach):
  - `locations.config.js` — location registry with BTCMap bounding boxes (Roatan default + Austin)
  - `src/routes/location.js` — full mini-site routes: `/:slug`, `/:slug/submit`, `/:slug/merchants`, `/:slug/reviews`, `/:slug/raffles`, `/:slug/how-it-works`
  - `src/services/btcmap.js` — `getMerchantsForAreas(areas)` fetches merchants by bounding box
  - `src/services/database.js` — `location_slug` column on tickets, location-filtered queries
  - `src/views/layout.ejs` — location-aware nav, communities dropdown, location footer
  - `src/views/submit.ejs` — passes `locationSlug` to API
  - One raffle, one DB — locations are filtered views, not separate instances
  - Fixed `resolveLocation` middleware: `next('route')` instead of `next()` for non-matching slugs
  - Commits: `24aa7c2` (architecture), `fba0864` (route fix)
  - **Deployed and verified** — all location routes return 200: `/austin`, `/austin/submit`, `/austin/merchants`, `/austin/reviews`

### Session 32 (2026-04-07)
- **GitHub Issues system for partner collaboration:**
  - 4 issue templates: bug-report, feature-request, content-change, design-tweak (`.github/ISSUE_TEMPLATE/`)
  - `issue-to-cline.sh` script: fetches issue via `gh`, formats as Cline dispatch prompt
  - Partner files GitHub issues → run script → Cline sub-agent works on it
  - Committed on main: `f6c6f8f`
- **Clonable branch (`clonable`):**
  - `site.config.js` — extracts all location/branding strings (siteName, regionName, merchantAreas, timezone, page text)
  - 17 files updated to use `siteConfig` instead of hardcoded strings
  - `index.js` injects siteConfig into all EJS views via `res.locals`
  - README.md updated with "Deploy Your Own" instructions
  - Verified: config loads, grep for hardcoded strings returns zero matches
  - Commit: `320706f`, pushed to `origin/clonable` — **not merged to main yet**

### Session 1 (2026-02-05)
- Created memory bank documentation
- Defined project architecture and tech stack
- Built entire application: server, routes, views, services, database
- Tested locally - server runs, API responds correctly
- Pushed to GitHub: https://github.com/jk212h20/BitcoinReview.git

### Session 2 (2026-02-07)
- Simplified review submission: merged separate register + submit into one unified form
- Only Google Review Link is required; Email and Lightning Address are optional
- Created new `POST /api/submit-review` endpoint that handles participant creation + review submission
- Form fields hide on successful submission, replaced by success message
- Added localStorage persistence for email and Lightning Address
- Fixed slow submit page load: removed btcmap merchant fetch from route
- Added 60-second cache to `bitcoin.getRaffleInfo()` with pre-warming on server startup
- Cleaned up homepage: removed registration form, simplified to CTAs
- Tested full flow locally - everything working

### Session 3 (2026-02-07, continued)
- Built Lightning Network service (`src/services/lightning.js`)
  - LND REST API integration with macaroon authentication
  - Lightning Address resolution (LNURL-pay protocol)
  - Invoice request and payment execution
  - Node info, wallet balance, channel balance queries
  - `isConfigured()` health check
- Enhanced admin routes with Lightning integration:
  - Auto-pay winner on raffle run (when AUTO_PAY_ENABLED=true)
  - Manual `POST /admin/raffle/:id/pay` endpoint
  - `GET /admin/lightning/status` endpoint
- Enhanced admin dashboard UI:
  - Lightning Node status card (alias, balance, auto-pay, default prize)
  - "⚡ Pay" button on unpaid raffles with Lightning Address
  - Payment failure tracking in database
- Updated .env.example with Lightning environment variables

### Session 4 (2026-02-07, continued)
- Switched email service from Nodemailer/SMTP to **Resend API**
  - Replaced nodemailer with `resend` npm package
  - Rewrote `src/services/email.js` to use Resend SDK
  - Resend handles SPF/DKIM/DMARC automatically - no DNS config needed for testing
  - Env vars simplified: just `RESEND_API_KEY` and `EMAIL_FROM` (replaced 5 SMTP vars)
  - Using `onboarding@resend.dev` as test sender until custom domain is verified
  - Free tier: 3,000 emails/month, 100/day - sufficient for this project
- Removed nodemailer dependency
- Updated .env and .env.example
- Updated memory bank documentation (techContext, activeContext, progress)

### Session 5 (2026-02-07, continued)
- **Switched to PPQ API proxy** for Anthropic/Claude access
  - Set `ANTHROPIC_BASE_URL=https://api.ppq.ai` 
  - Using PPQ API key instead of direct Anthropic key
  - Updated `src/services/anthropic.js` to accept custom base URL via env var
  - Model: `claude-sonnet-4-20250514`
- **Deployed to Railway.app:**
  - Created Railway project "BitcoinReview" via `railway init`
  - Created "web" service with `railway add`
  - Set all environment variables via `railway variables set`
  - Deployed via `railway up` - Nixpacks auto-detected Node.js
  - Build succeeded, healthcheck passed on `/api/stats`
  - Generated domain: https://web-production-3a9f6.up.railway.app
  - Set `BASE_URL` env var to match Railway domain
- Pushed all changes to GitHub
- Updated memory bank documentation

### Session 11 (2026-02-08, continued)
- **Fixed Chrome detection for local development:**
  - Scraper now uses `puppeteer` (full, with bundled Chromium) as fallback when no system Chrome found
  - Three-tier detection: production (@sparticuz/chromium) → system Chrome → bundled Chromium
  - Fixed `page.waitForTimeout` deprecation — replaced with `setTimeout` promise
- **Tested scraping pipeline end-to-end:**
  - Successfully scraped ticket #3 — extracted Thai review text about a brewery
  - Review text saved to database ✅
  - AI validation attempted but failed with 401 from PPQ proxy (API key issue, not code issue)
  - Admin scrape endpoint confirmed working: `POST /api/admin/tickets/:id/scrape`
- **Known issue:** PPQ API key returning 401 — needs valid key or switch to direct Anthropic API
- Updated memory bank documentation

### Session 6 (2026-02-07, continued)
- **Deposit address display on homepage:**
  - Added `deposit_addresses` table to database.js for caching addresses
  - Extended `lightning.js` with `getNewAddress()` (on-chain via `/v2/wallet/address/next`) and `addInvoice()` (Lightning via `/v1/invoices`)
  - Added `cacheDepositAddresses()` and `getCachedDepositInfo()` functions with DB persistence
  - New API endpoints: `GET /api/deposit-info`, `POST /api/generate-invoice`
  - Updated `pages.js` to pass deposit info (onchainAddress, lightningInvoice, totalDonationsSats) to homepage
  - Added "Fund the Raffle" section to `index.ejs` with QR codes, copy buttons, and custom amount invoice generator
  - Startup cache warming + 10-minute polling interval in `index.js`
- **Fixed EJS template syntax errors:**
  - Nested backtick template literals broke EJS parser
  - Converted conditional HTML to string concatenation
  - Converted client-side JS to ES5 syntax to avoid backtick conflicts
- Tested locally - deposit addresses displaying correctly from Voltage node
- Updated memory bank documentation

### Session 7 (2026-02-07, continued)
- **Fixed review submission bug:**
  - `TypeError: Cannot read properties of null (reading 'opt_out_token')` in api.js
  - Root cause: `findOrCreateUser()` returned `{ user: null }` when `last_insert_rowid()` failed
  - Added null check in `api.js` with clear error message
  - Added fallback lookup in `database.js` `findOrCreateUser()` - if ID lookup fails, tries email/lnurl
  - Verified submission works end-to-end
- **Verified deposit address display on homepage:**
  - On-chain Bitcoin QR + address + copy button ✅
  - Lightning invoice QR + copy button ✅
  - Custom amount invoice generator ✅
  - Total donated badge ✅
  - Footer on-chain address ✅
- Updated memory bank documentation

### Session 8 (2026-02-07, continued)
- **Fixed database schema mismatch:**
  - Old DB had `email TEXT UNIQUE NOT NULL` and `lnurl_address TEXT NOT NULL` but code expected nullable
  - `CREATE TABLE IF NOT EXISTS` doesn't alter existing tables
  - Deleted old DB (5 test records), server recreated with correct nullable schema
  - Backup saved at `data/reviews.db.backup`
- **Fixed anonymous review submission:**
  - Removed anonymous user creation hack (fake email/lnurl)
  - Tickets now created with `user_id: null` for review-only submissions
  - Response prompts user to add email/Lightning address for raffle entry
  - Tested both flows: review-only ✅, full submission (email+lnurl+review) ✅
- **Verified deposit addresses still displaying correctly on homepage**
- Updated memory bank documentation

### Session 9 (2026-02-07, continued)
- **Added public reviews page (`/reviews`):**
  - New `getPublicTickets()` function in database.js - queries tickets WITHOUT joining user email/lnurl for privacy
  - New `reviews.ejs` template with orange gradient header, stats summary cards (total/successful/unsuccessful), and review cards
  - New `GET /reviews` route in pages.js
  - "Reviews" nav link added to both desktop and mobile navigation in layout.ejs
  - Each review card shows: merchant name, submission date, validation status badge, AI assessment, and link to original review
  - **Privacy enforced:** No email or lightning address is exposed on this public page
- Tested locally - page renders correctly with 200 status
- Updated memory bank documentation

### Session 10 (2026-02-08)
- **HTML scraping + AI validation pipeline:**
  - New `src/services/scraper.js` — Puppeteer-based Google Maps review scraper
  - Uses `puppeteer-core` + `@sparticuz/chromium` (works on Railway/serverless)
  - Multiple CSS selector strategies for extracting review text and merchant name
  - Queue/mutex system ensures only one browser instance at a time
  - `scrapeAndValidateReview()` — full pipeline: scrape → store text → AI validate → update status
  - `revalidateAllPending()` — batch process all unvalidated tickets
- **Database helpers added:**
  - `updateTicketReviewText()`, `updateTicketMerchant()`, `getUnvalidatedTickets()`
- **API submit flow updated:**
  - `POST /api/submit` now fires background scrape+validate (non-blocking)
  - Ticket initially marked "Pending AI validation", updated async after scrape+AI check
- **Admin endpoints added:**
  - `POST /admin/tickets/revalidate-all` — batch re-scrape+validate all pending tickets
  - `POST /admin/tickets/:id/scrape` — scrape+validate single ticket with result
- Updated memory bank documentation
