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
- Anthropic API integration (review validation) - needs API key
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

## What's In Progress
- Railway deployment (needs to be configured on Railway.app)
- Environment variables need to be set (Resend API key, Anthropic API key, admin password, LND)

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
- [ ] Deploy to Railway.app
- [ ] Configure environment variables on Railway
- [x] Set up email provider (switched from Nodemailer/SMTP to Resend API)
- [ ] Get Anthropic API key configured
- [ ] Configure Voltage LND node connection

## Known Issues
- Email: Resend API key set, but using test sender (onboarding@resend.dev) - need to verify custom domain in Resend dashboard for production
- Anthropic API not configured (needs ANTHROPIC_API_KEY)
- Lightning not configured (needs LND_REST_URL and LND_MACAROON)
- better-sqlite3 had compilation issues on Node 24 - switched to sql.js (pure JS)

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
