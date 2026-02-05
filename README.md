# Bitcoin Review Raffle 🌴⚡

A raffle system to incentivize Bitcoin adoption in Roatan by rewarding people who write Google reviews mentioning their Bitcoin purchases at local merchants.

## How It Works

1. **Register** - Sign up with your email and Lightning address
2. **Pay with Bitcoin** - Visit a merchant and pay with Bitcoin/Lightning
3. **Write a Review** - Leave a Google review mentioning your Bitcoin purchase
4. **Submit** - Submit your review link on our site
5. **Win!** - Every ~2 weeks (Bitcoin difficulty adjustment), one random reviewer wins Bitcoin!

## Features

- 🎫 No login required - simple email + LNURL registration
- 🤖 AI-powered review validation (Anthropic Claude)
- 🎲 Provably fair raffle using Bitcoin block hashes
- 📍 Merchant list from BTCMap.org
- ⚡ Lightning address prizes
- 📧 Email notifications

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** SQLite
- **Frontend:** EJS templates + Tailwind CSS + Alpine.js
- **APIs:** Anthropic, BTCMap, Mempool.space

## Setup

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
# Clone the repository
git clone https://github.com/jk212h20/BitcoinReview.git
cd BitcoinReview

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your settings
# Required: ADMIN_PASSWORD
# Optional: ANTHROPIC_API_KEY, SMTP settings, DONATION_ADDRESS

# Start the server
npm start
```

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port (default: 3000) | No |
| `DATABASE_PATH` | SQLite database path | No |
| `ANTHROPIC_API_KEY` | For AI review validation | No* |
| `SMTP_HOST` | Email server host | No |
| `SMTP_PORT` | Email server port | No |
| `SMTP_USER` | Email username | No |
| `SMTP_PASS` | Email password | No |
| `SMTP_FROM` | From email address | No |
| `ADMIN_PASSWORD` | Admin dashboard password | Yes |
| `BASE_URL` | Public URL of the site | No |
| `DONATION_ADDRESS` | Bitcoin donation address | No |

*Without Anthropic API key, reviews are auto-approved

## Development

```bash
# Run with auto-reload
npm run dev
```

## Deployment (Railway)

1. Push to GitHub
2. Connect repository to Railway
3. Set environment variables in Railway dashboard
4. Deploy!

## API Endpoints

### Public
- `POST /api/register` - Register email + LNURL
- `POST /api/submit-review` - Submit a review
- `GET /api/merchants` - Get merchant list
- `GET /api/raffle-info` - Get current raffle info
- `GET /api/stats` - Get public statistics

### Admin (requires password)
- `GET /api/admin/dashboard` - Dashboard data
- `POST /api/admin/raffle/run` - Run raffle
- `POST /api/admin/raffle/:id/mark-paid` - Mark winner paid

## Raffle Mechanics

The raffle uses Bitcoin's blockchain for provably fair winner selection:

1. Every 2016 blocks (~2 weeks), Bitcoin adjusts its mining difficulty
2. We use the hash of this difficulty adjustment block
3. Winner = `block_hash mod total_tickets`
4. This is deterministic and verifiable by anyone!

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.

---

Made with ⚡ for Bitcoin adoption in Roatan 🌴
