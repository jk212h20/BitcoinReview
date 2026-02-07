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
- **Anthropic API:** Validate review content mentions Bitcoin
- **Bitcoin Block API:** Fetch block hashes for raffle (mempool.space or blockstream.info)
- **Email:** Resend API (https://resend.com) - handles SPF/DKIM/DMARC automatically

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
ANTHROPIC_API_KEY=
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

## Key Dependencies
- express
- better-sqlite3
- ejs
- resend (email API)
- @anthropic-ai/sdk
- dotenv
- uuid (for opt-out tokens)
