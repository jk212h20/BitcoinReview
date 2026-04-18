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
- Admin routes protected by signed HttpOnly session cookie (HMAC-SHA256
  over a 30-day expiry; key derived from `SESSION_SECRET` or `ADMIN_PASSWORD`).
  Rotating the password invalidates all sessions automatically.
- Admin password stored as scrypt hash in `settings.admin_password_hash`
  once the admin sets one via /admin → 🔑 Admin Password. The
  `ADMIN_PASSWORD` env is bootstrap fallback only.
- **Site-scoped spending guard**: the LND node is shared across multiple
  sites. `lightning.payInvoice` and `lightning.payLightningAddress` both
  call `assertWithinBudget(sats)` → throws `BUDGET_EXCEEDED` if `sats >
  donations − payouts` for THIS site. Single chokepoint; defense-in-depth
  request-level checks at admin commit/pay endpoints too.
- Lightning Status admin card shows ONLY site-scoped info (no shared-node
  alias / pubkey / channel balance leaked).
- Opt-out tokens are UUIDs (unguessable)
- Rate limiting on registration/submission endpoints. Read-only polled
  endpoints (`/api/raffle-fund`, `/api/claim/*/status`) and admin endpoints
  (`/api/admin/*`) are explicitly exempt — auth is the right boundary
  there, not a per-IP cap.
- Input validation on all user inputs
- SQL injection prevention via parameterized queries

## Pattern: Site-scoped budget guard

```js
// services/lightning.js
function getSiteAvailableSats() {
    const donated = db.getAllDepositAddresses()
        .filter(d => d.received_at && d.amount_received_sats > 0)
        .reduce((s, d) => s + d.amount_received_sats, 0);
    const paidOut = db.getAllRaffles()
        .filter(r => r.paid_at && r.prize_amount_sats > 0)
        .reduce((s, r) => s + r.prize_amount_sats, 0);
    return Math.max(0, donated - paidOut);
}

function assertWithinBudget(sats, context) {
    const available = getSiteAvailableSats();
    if (sats > available) {
        const err = new Error(`Refusing to pay ${sats} sats: this site only has ${available} sats available...`);
        err.code = 'BUDGET_EXCEEDED';
        throw err;
    }
}

// Wired into BOTH pay primitives so every code path is covered.
```

## Pattern: Smart polling (rate-limit-friendly)

```js
// Three rules: (1) skip if no relevant DOM, (2) pause when hidden, (3) silent on 429.
const POLL_INTERVAL_MS = 60000;
function startPolling() {
    if (pollTimer || !shouldPoll()) return;  // rule 1
    pollTimer = setInterval(() => {
        if (document.hidden) return;          // rule 2 (cheap; checked on every tick)
        fetch('/api/foo').then(r => {
            if (!r.ok) { backoff++; return; } // rule 3 (don't surface 429 to user)
            // ...
        });
    }, POLL_INTERVAL_MS * Math.min(1 << Math.min(backoff, 4), 5));  // exponential backoff cap 5 min
}
document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else { fetchOnce(); startPolling(); }    // immediate refresh on focus
});
```

## Pattern: EJS template-literal escape doubling

`admin.ejs` body is wrapped in a JS template literal that EJS feeds to
`layout`:

```ejs
<%- include('layout', { body: `
    <button onclick="alert('Saved!\\n\\nClick OK')">...</button>
                                  ^^^^^   not  ^n
` }) %>
```

`\n` in a string literal here gets JS-decoded into a real newline before
reaching the browser → unterminated string in `<script>` → silent
SyntaxError → Alpine fails to hydrate → save buttons appear empty.

**Always use `\\n` in source** when writing inline JS strings inside the
admin.ejs body. Same for `\t`, `\r`, etc. (Already-doubled `\\n` is just
a literal backslash + n at the JS layer, which becomes `\n` in browser
JS — which is what you want at runtime.)

**Validation**: extract the rendered `<script>` block and run `node --check`
on it. Catches this class of bug in seconds.
