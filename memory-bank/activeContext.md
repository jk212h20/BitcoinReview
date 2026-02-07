# Active Context

## Current Focus
Lightning Network integration complete. Admin dashboard enhanced with LND node status, auto-pay on raffle run, and manual "Pay via Lightning" button for winners.

## Recent Changes (Latest Session)
1. **Lightning Service (`src/services/lightning.js`):** Full LND REST API integration
   - Connects to Voltage LND node via REST API with macaroon auth
   - Lightning Address resolution (LNURL-pay flow)
   - Invoice request and payment
   - `payLightningAddress()` - full flow: resolve → invoice → pay
   - `isConfigured()` - check node status
   - `getChannelBalance()` - check channel liquidity
2. **Admin Routes - Lightning Integration:**
   - `POST /admin/raffle/run` now auto-pays winner via Lightning if `AUTO_PAY_ENABLED=true`
   - `POST /admin/raffle/:id/pay` - manually pay a raffle winner via Lightning
   - `GET /admin/lightning/status` - check LND node status and balance
   - Payment results tracked in DB (`payment_hash`, `payment_status`, `payment_error`)
3. **Admin Dashboard UI Enhancements:**
   - Lightning Node status card (alias, balance, auto-pay status, default prize)
   - "⚡ Pay" button on unpaid raffles with Lightning Address
   - "Mark Paid" button for manual tracking
4. **Database Schema Updates:**
   - `raffles` table has `payment_status`, `payment_hash`, `payment_error` columns
   - `markRafflePaid()` and `markRafflePaymentFailed()` methods

## Previous Session Changes
1. **Simplified Submit Form:** Single unified form - only review link required
   - Email and Lightning Address optional
   - Form fields hide on success, showing only success message
2. **Fixed Slow Page Load:** 
   - Removed btcmap fetch from submit page route
   - 60-second cache on `bitcoin.getRaffleInfo()`
   - Cache pre-warming on startup
3. **Unified API:** `POST /api/submit-review` handles participant creation + review submission

## Architecture Decisions
1. **Tech Stack:** Node.js + Express + SQLite (sql.js) + EJS templates
2. **No user logins:** Simple email + LNURL registration
3. **Raffle timing:** Bitcoin difficulty adjustment (every 2016 blocks)
4. **Winner selection:** Deterministic via `block_hash mod ticket_count`
5. **Review validation:** Anthropic API to check if review mentions Bitcoin
6. **Lightning payments:** LND REST API via Voltage node
7. **Database:** sql.js (pure JS, no native compilation)

## Environment Variables for Lightning
- `LND_REST_URL` - Voltage LND REST endpoint
- `LND_MACAROON` - Hex-encoded admin macaroon
- `AUTO_PAY_ENABLED` - Set to 'true' to auto-pay winners
- `DEFAULT_PRIZE_SATS` - Default prize amount in sats

## Next Steps
1. Deploy to Railway.app with Lightning env vars
2. Configure Voltage LND node connection
3. Test Lightning payment flow end-to-end
4. ~~Set up SMTP provider for email sending~~ ✅ Done - switched to Resend API
5. Get Anthropic API key configured
6. Verify domain in Resend dashboard for production emails (currently using onboarding@resend.dev for testing)

## Important Notes
- Code pushed to: https://github.com/jk212h20/BitcoinReview.git
- Server tested locally on port 3000 - all working
- Lightning service gracefully handles missing config (returns not configured)
- Auto-pay failures are logged but don't break raffle execution
