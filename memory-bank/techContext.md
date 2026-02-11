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
- **Email:** Resend API (https://resend.com) - handles SPF/DKIM/DMARC automatically
- **Lightning:** LND REST API via Voltage node

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
│   │   └── bitcoin.js     # Block hash fetching
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
EMAIL_FROM=Bitcoin Review Raffle <onboarding@resend.dev>
ADMIN_PASSWORD=
BASE_URL=http://localhost:3000
DONATION_ADDRESS=
LND_REST_URL=
LND_MACAROON=
AUTO_PAY_ENABLED=false
DEFAULT_PRIZE_SATS=100000
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
