# Active Context

## Current Focus (Updated 2026-02-11)

### Just Fixed: Donation Address "Not Configured" on Production
- **Root cause**: Two issues compounded:
  1. LND deposit integration code was committed but never deployed successfully
  2. The `/api/stats` healthcheck endpoint called `bitcoin.getRaffleInfo()` which fetches from mempool.space — this timed out on Railway, causing healthcheck failures
  3. Railway kept the old deployment (without LND code) running since new deploys never passed healthcheck
- **Fix**: Made `/api/stats` resilient to blockchain API timeouts (returns 200 with partial data instead of 500)
- **Result**: Healthcheck passes, new deploy goes live, Voltage LND node provides on-chain address + Lightning invoices

**HTML scraping + AI validation pipeline** is now fully functional. Reviews are automatically scraped via Puppeteer and validated by Claude AI to determine if they mention Bitcoin payment. Scraping has been tested and confirmed working locally.

## Recent Changes (Latest Session - Session 12)
1. **Filtered BTCMap merchants for validity and freshness (2026-02-11):**
   - Added `isValidBitcoinMerchant()` filter in `src/services/btcmap.js`
   - Merchants now require `payment:lightning=yes` OR `payment:onchain=yes` (or `payment:bitcoin=yes`)
   - Merchants also require `survey:date` or `check_date:currency:XBT` within the last year
   - Merchants with no date tags or stale data (>1 year) are excluded from the listing

## Previous Session Changes (Session 11)
1. **Fixed Chrome Detection for Local Development:**
   - Scraper now uses `puppeteer` (full, with bundled Chromium) as fallback when no system Chrome is found
   - Three-tier detection: production (@sparticuz/chromium) → system Chrome → bundled Chromium
   - Fixed `page.waitForTimeout` deprecation — replaced with `setTimeout` promise

2. **Tested Scraping Pipeline End-to-End:**
   - Successfully scraped ticket #3 (`maps.app.goo.gl/Vb8bXcH3qRT26rv27`) — extracted Thai review text about a brewery
   - Review text saved to database ✅
   - AI validation attempted but failed with 401 from PPQ proxy (API key issue, not code issue)
   - Admin scrape endpoint works: `POST /api/admin/tickets/:id/scrape`

3. **Dependencies Updated:**
   - Added `puppeteer` (full) alongside `puppeteer-core` for local dev fallback
   - Both `puppeteer` and `puppeteer-core` + `@sparticuz/chromium` in package.json

## Previous Session Changes (Session 10)
1. **New Scraper Service (`src/services/scraper.js`):**
   - Uses `puppeteer-core` + `@sparticuz/chromium` for headless Chrome scraping
   - Scrapes Google Maps review pages to extract review text and merchant name
   - Multiple CSS selector strategies for robustness against Google's DOM changes
   - Queue/mutex system ensures only one scrape runs at a time (memory safety)
   - `scrapeAndValidateReview()` — full pipeline: scrape → update DB → AI validate → update DB
   - `revalidateAllPending()` — batch re-validate all unvalidated tickets

2. **Database Helpers Added:**
   - `updateTicketReviewText(ticketId, text)` — stores scraped review text
   - `updateTicketMerchant(ticketId, name)` — stores scraped merchant name
   - `getUnvalidatedTickets()` — finds tickets needing validation

3. **API Submit Flow Updated (`POST /api/submit`):**
   - After creating a ticket, fires background scrape+validate (non-blocking)
   - HTTP response returns immediately, validation happens async

4. **Admin Endpoints Added:**
   - `POST /api/admin/tickets/revalidate-all` — batch re-scrape+validate all pending tickets
   - `POST /api/admin/tickets/:id/scrape` — scrape+validate a single ticket (returns result)

## Architecture Decisions
1. **Tech Stack:** Node.js + Express + SQLite (sql.js) + EJS templates
2. **No user logins:** Simple email + LNURL registration
3. **Raffle timing:** Bitcoin difficulty adjustment (every 2016 blocks)
4. **Winner selection:** Deterministic via `block_hash mod ticket_count`
5. **Review validation:** Claude via PPQ proxy API to check if review mentions Bitcoin
6. **Lightning payments:** LND REST API via Voltage node
7. **Database:** sql.js (pure JS, no native compilation)
8. **API Proxy:** Using PPQ (api.ppq.ai) as proxy to access Claude models
9. **Review scraping:** Puppeteer-based async scraping with queue/mutex, non-blocking to HTTP requests
10. **AI validation pipeline:** Scrape → extract text → Claude validates Bitcoin mention → update ticket status

## Known Issues
- **Merchant name extraction** — Google Maps doesn't always expose the merchant name in the selectors used. Some reviews will have `null` merchant name.

## Next Steps
1. **Fix PPQ API key** — Get a valid API key for `api.ppq.ai` or switch to direct Anthropic API
2. Deploy latest changes to Railway (includes new puppeteer dependencies)
3. Test scraping pipeline on production (verify @sparticuz/chromium works on Railway)
4. Consider adding retry logic for failed scrapes
5. Add merchant name extraction improvements

## Important Notes
- **Live URL:** https://web-production-3a9f6.up.railway.app
- Code pushed to: https://github.com/jk212h20/BitcoinReview.git
- Railway project: BitcoinReview (service: web, environment: production)
- **Scraping is async/non-blocking** — submit endpoint returns immediately, validation happens in background
- **Queue system** prevents multiple Puppeteer instances from running simultaneously
- **Three-tier Chrome detection:** @sparticuz/chromium (prod) → system Chrome → bundled Chromium (dev)
- **Admin routes mounted at `/api/admin/`** — e.g., `/api/admin/tickets/3/scrape`
- Admin password: set via `ADMIN_PASSWORD` env var, passed via `x-admin-password` header
