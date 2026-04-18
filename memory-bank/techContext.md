# Tech Context

## Tech Stack

### Backend
- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** SQLite (simple, file-based, easy to deploy)

### Frontend
- **Approach:** Server-side rendered with EJS templates
- **Styling:** Tailwind CSS (via CDN for simplicity)
- **Interactivity:** Vanilla JS + Alpine.js for reactive components

### External APIs
- **btcmap.org:** Fetch Bitcoin-accepting merchants
- **Anthropic API (via PPQ proxy):** Validate review content mentions Bitcoin - using `api.ppq.ai` as base URL with PPQ API key to access Claude claude-sonnet-4-20250514
- **Bitcoin Block API:** Fetch block hashes for raffle (mempool.space or blockstream.info)
- **CoinGecko (public, no key):** BTC/USD price for hero card; in-memory cache 5 min, silent failure. Endpoint: `api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd`
- **Email:** Resend API (https://resend.com) - handles SPF/DKIM/DMARC automatically
- **Lightning:** LND REST API via Voltage node (**shared across multiple sites** — see Session 34 site-budget guard)

### Deployment
- **Platform:** Railway.app
- **Repository:** https://github.com/jk212h20/BitcoinReview.git

## Project Structure
```
BitcoinReview/
├── memory-bank/           # Project documentation
├── src/
│   ├── index.js           # Express app entry point
│   ├── routes/
│   │   ├── pages.js       # Frontend page routes
│   │   ├── api.js         # API endpoints
│   │   └── admin.js       # Admin routes
│   ├── services/
│   │   ├── database.js    # SQLite operations
│   │   ├── email.js       # Email sending
│   │   ├── btcmap.js      # Merchant fetching
│   │   ├── anthropic.js   # Review validation
│   │   ├── bitcoin.js     # Block hash fetching
│   │   ├── lightning.js   # LND REST + site-scoped budget guard (assertWithinBudget)
│   │   ├── price.js       # BTC/USD via CoinGecko (5-min cache)
│   │   ├── auth.js        # Admin scrypt password hash + signed HttpOnly session cookie
│   │   └── telegram.js    # Bot notifications + admin invite flow
│   └── views/
│       ├── layouts/
│       ├── index.ejs      # Landing page
│       ├── submit.ejs     # Review submission
│       └── admin.ejs      # Admin dashboard
├── public/
│   ├── css/
│   └── js/
├── data/
│   └── reviews.db         # SQLite database file
├── package.json
├── .env.example
└── railway.json           # Railway deployment config
```

## Environment Variables
```
PORT=3000
DATABASE_PATH=./data/reviews.db
ANTHROPIC_API_KEY=           # PPQ API key (sk-...)
ANTHROPIC_BASE_URL=https://api.ppq.ai  # PPQ proxy for Claude access
RESEND_API_KEY=
EMAIL_FROM=Reviews Raffle <onboarding@resend.dev>
ADMIN_PASSWORD=              # Bootstrap only; once admin uses /admin → 🔑 Admin Password,
                             # the scrypt hash in settings.admin_password_hash takes over.
SESSION_SECRET=              # Optional; if unset auth.js derives from ADMIN_PASSWORD.
                             # Rotating either invalidates all existing admin sessions.
BASE_URL=http://localhost:3000
DONATION_ADDRESS=
LND_REST_URL=
LND_MACAROON=
AUTO_PAY_ENABLED=false
DEFAULT_PRIZE_SATS=100000    # Legacy — no longer used in pay paths since Session 34.
                             # Kept only for the test-raffle hardcoded 100.
TELEGRAM_BOT_TOKEN=
TELEGRAM_APPROVE_TOKEN=      # One-tap approve/reject auth for Telegram message buttons
```

## Deployment
- **Railway.app** - live at https://web-production-3a9f6.up.railway.app
- Railway project: BitcoinReview (service: web, environment: production)
- Deployed via `railway up` (Nixpacks auto-detects Node.js)
- Healthcheck endpoint: `/api/stats`

## Key Dependencies
- express
- sql.js (pure JS SQLite - replaced better-sqlite3 due to native compilation issues)
- ejs
- resend (email API)
- @anthropic-ai/sdk (with custom baseURL for PPQ proxy)
- dotenv
- uuid (for opt-out tokens)
