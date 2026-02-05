# System Patterns

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend (EJS)                         │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │ Landing  │  │ Submit Review│  │ Admin Dashboard       │ │
│  │ Page     │  │ Page         │  │ (password protected)  │ │
│  └──────────┘  └──────────────┘  └───────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Express.js Backend                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Routes: /api/register, /api/submit, /api/raffle      │   │
│  └──────────────────────────────────────────────────────┘   │
│                            │                                 │
│  ┌─────────────────────────┴─────────────────────────────┐  │
│  │                    Services Layer                      │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │  │
│  │  │ Database │ │ Email    │ │ Anthropic│ │ Bitcoin  │  │  │
│  │  │ Service  │ │ Service  │ │ Service  │ │ Service  │  │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│   SQLite     │   │  External    │   │  External    │
│   Database   │   │  APIs        │   │  SMTP        │
└──────────────┘   │  - btcmap    │   └──────────────┘
                   │  - mempool   │
                   │  - anthropic │
                   └──────────────┘
```

## Database Schema

```sql
-- Users who register for the raffle
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    lnurl_address TEXT NOT NULL,
    opt_out_token TEXT UNIQUE NOT NULL,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Submitted reviews (raffle tickets)
CREATE TABLE tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    review_link TEXT NOT NULL,
    review_text TEXT,  -- Cached for display
    merchant_name TEXT,
    is_valid BOOLEAN DEFAULT 0,  -- Set after AI validation
    validation_reason TEXT,
    raffle_block INTEGER,  -- The 2016-block period this belongs to
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Raffle history
CREATE TABLE raffles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_height INTEGER NOT NULL,  -- The difficulty adjustment block
    block_hash TEXT NOT NULL,
    total_tickets INTEGER NOT NULL,
    winning_index INTEGER NOT NULL,  -- block_hash mod total_tickets
    winning_ticket_id INTEGER,
    prize_amount_sats INTEGER,
    paid_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (winning_ticket_id) REFERENCES tickets(id)
);

-- Donation tracking (optional)
CREATE TABLE donations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    txid TEXT,
    amount_sats INTEGER,
    confirmed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## Key Patterns

### 1. Raffle Block Calculation
```javascript
// Bitcoin difficulty adjusts every 2016 blocks
// Block 0, 2016, 4032, 6048, ... are adjustment blocks
function getCurrentRaffleBlock(currentHeight) {
    return Math.floor(currentHeight / 2016) * 2016;
}

function getNextRaffleBlock(currentHeight) {
    return (Math.floor(currentHeight / 2016) + 1) * 2016;
}
```

### 2. Winner Selection (Deterministic)
```javascript
function selectWinner(blockHash, totalTickets) {
    // Convert hex hash to BigInt for proper modulo
    const hashBigInt = BigInt('0x' + blockHash);
    const winnerIndex = Number(hashBigInt % BigInt(totalTickets));
    return winnerIndex;
}
```

### 3. Review Validation Flow
```
User submits link + email
        │
        ▼
Check email exists in users table
        │
        ▼
Validate Google review URL format
        │
        ▼
Fetch review content (if possible) or accept user-provided text
        │
        ▼
Send to Anthropic API: "Does this review mention paying with Bitcoin?"
        │
        ▼
If valid → Create ticket for current raffle period
If invalid → Return error with reason
```

### 4. Email Opt-Out Pattern
```
Registration → Generate UUID opt_out_token
            → Send email with link: /opt-out/{token}
            → User clicks → Set is_active = 0
```

## API Endpoints

### Public
- `GET /` - Landing page
- `GET /submit` - Review submission page
- `POST /api/register` - Register email + LNURL
- `POST /api/submit-review` - Submit review link
- `GET /opt-out/:token` - Opt out of registration
- `GET /api/merchants` - Get merchant list from btcmap

### Admin (password protected)
- `GET /admin` - Dashboard
- `GET /admin/tickets` - View all tickets
- `POST /admin/validate/:ticketId` - Manually validate ticket
- `POST /admin/raffle` - Trigger raffle for a block
- `POST /admin/mark-paid/:raffleId` - Mark winner as paid

## Security Considerations
- Admin routes protected by simple password (env var)
- Opt-out tokens are UUIDs (unguessable)
- Rate limiting on registration/submission endpoints
- Input validation on all user inputs
- SQL injection prevention via parameterized queries
