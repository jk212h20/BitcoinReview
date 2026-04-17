# Plan: Claim-Based Raffle Prize Flow

## Problem
Current flow requires Lightning Address at review submission time. Issues:
1. **Bolt12 incompatibility** — Phoenix Wallet `@phoenixwallet.me` addresses use BIP-353/Bolt12, which LND can't pay
2. **Poor UX** — Reviewers must set up a wallet + Lightning Address before submitting
3. **Silent payments** — Winner may not notice auto-sent sats; no acknowledgment
4. **Friction** — 7 people go through wallet setup, mostly forget, only 1 wins

## Proposed Flow: LNURL-Withdraw Claim Link

### How it works:
1. **Submission:** User submits review with **email only** (optional: Telegram username)
2. **Raffle draw:** Winner selected deterministically (same block_hash mod ticket_count)
3. **Notification:** Winner gets an **email** with a unique claim link (+ Telegram if provided)
4. **Claim page:** Winner clicks link → sees prize amount + **LNURL-withdraw QR code**
5. **Scanning:** Winner scans QR with ANY Lightning wallet → sats are pulled from our LND node
6. **Done:** Claim marked as completed, shown in public raffle history

### Why LNURL-Withdraw:
- Works with **every** Lightning wallet (Phoenix, WoS, Muun, Breez, Zeus, BlueWallet, etc.)
- No Lightning Address needed — just scan a QR code
- Winner actively acknowledges the win (must scan to claim)
- Compatible with both Bolt11 AND Bolt12 wallets (the wallet initiates)
- Standard protocol: [LUD-03](https://github.com/lnurl/luds/blob/luds/03.md)

### Technical Implementation:

#### Database Changes
```sql
-- Add to raffles table or new claims table:
ALTER TABLE raffles ADD COLUMN claim_token TEXT;      -- unique secret token for claim URL
ALTER TABLE raffles ADD COLUMN claim_status TEXT DEFAULT 'pending';  -- pending | claimed | expired
ALTER TABLE raffles ADD COLUMN claim_expires_at TEXT;  -- e.g., 30 days after draw
ALTER TABLE raffles ADD COLUMN claimed_at TEXT;

-- Remove requirement for lightning_address in users table
-- Keep it optional for backwards compat but not required for submissions
```

#### New LNURL-Withdraw Server Endpoint
Our Express server acts as a **LNURL-withdraw service**:

1. **`GET /api/lnurl/withdraw/:token`** — LNURL-withdraw endpoint (wallet's first call)
   - Returns: `{ tag: "withdrawRequest", callback, k1, defaultWithdrawable, minWithdrawable, maxWithdrawable }`
   - `k1` = the claim token (used to verify the callback)

2. **`GET /api/lnurl/withdraw/:token/callback?k1=...&pr=...`** — Callback (wallet sends invoice)
   - Wallet provides a BOLT11 invoice (`pr`) for the prize amount
   - Server validates k1, checks claim isn't already used
   - Server pays the invoice via LND `payInvoice()`
   - Marks claim as completed

3. **`GET /claim/:token`** — Human-friendly claim page
   - Shows prize amount, congratulations message
   - Displays QR code encoding the LNURL-withdraw URL (bech32-encoded)
   - "How to claim" instructions for popular wallets
   - Status updates (pending/claimed/expired)

#### Claim Page Flow:
```
Winner clicks email link → /claim/abc123
  → Page shows: "🎉 You won 53,500 sats!"
  → QR code (LNURL-withdraw encoded as lnurl...)
  → Instructions: "Open any Lightning wallet, scan this QR code"
  → After scan+claim: page updates to "✅ Prize claimed!"
```

#### Email Template:
```
Subject: 🎉 You won the Reviews Raffle!

Congratulations! You were selected as the winner of the Reviews Raffle.

Your prize: 53,500 sats (~$XX.XX)

Click here to claim your prize:
https://bitcoinreview.app/claim/abc123def456

You'll see a QR code — just scan it with any Lightning wallet to receive your sats.
This link expires in 30 days.

— Reviews Raffle
```

#### Changes to Existing Code:

1. **`src/views/submit.ejs`** — Remove Lightning Address field (or make it fully optional with note)
2. **`src/services/database.js`** — Add claim_token, claim_status columns; make lightning_address optional
3. **`src/routes/api.js`** — New LNURL-withdraw endpoints
4. **`src/routes/pages.js`** — New `/claim/:token` page route
5. **`src/views/claim.ejs`** — New claim page template
6. **`src/index.js`** — `commitRaffleResult()`: generate claim token, send claim email instead of auto-paying
7. **`src/services/lightning.js`** — Keep `payInvoice()` (used by LNURL-withdraw callback)
8. **`src/views/admin.ejs`** — Show claim status (pending/claimed) in raffle table
9. **`src/services/email.js`** — New claim email template

#### LNURL Encoding:
The QR code needs to encode the LNURL-withdraw URL as a bech32 string:
```
lnurl... = bech32_encode("https://bitcoinreview.app/api/lnurl/withdraw/abc123")
```
Use npm package `lnurl` or manually bech32-encode.

#### Claim Expiry:
- Claims expire after **30 days**
- Expired unclaimed prizes return to the raffle fund
- Background check in polling interval marks expired claims

#### Admin Features:
- Raffle table shows claim status: 🟡 Pending | ✅ Claimed | ⏰ Expired
- Admin can manually resend claim email
- Admin can manually mark as paid (for edge cases)

### Migration Plan:
1. Make lightning_address optional in submit form (keep for existing users)
2. Add claim columns to raffles table
3. Build LNURL-withdraw endpoints
4. Build claim page
5. Update commitRaffleResult() to use claim flow
6. Test end-to-end
7. Remove auto-pay logic (or keep as fallback for users who DO have LNURL addresses)

### Dependencies:
- `bech32` npm package (for LNURL encoding) — or use the `lnurl` package
- QR code generation: can use `api.qrserver.com` (already in use) or `qrcode` npm package

### Edge Cases:
- Winner scans QR but wallet fails to complete → claim stays "pending", can retry
- Winner loses email → admin can resend or provide claim link via Telegram
- Winner doesn't claim within 30 days → funds return to raffle pool
- Multiple scan attempts → only first successful payment goes through (k1 single-use)
