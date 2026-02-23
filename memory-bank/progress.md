# Progress

## What Works
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
