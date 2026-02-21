# Active Context

## Current Focus (Updated 2026-02-20)

### Just Completed: Auto-Raffle, Featured Reviews, Quiet Hours, Test Suite

**What was built (Session 14):**
1. **Auto-raffle trigger** — `raffle_auto_trigger` DB setting (default: false)
   - Background poll loop (every 5 min) in `src/index.js` calls `checkRaffleEvents()`
   - `runAutoRaffle()` handles: get block hash → pick winner → create raffle → notify → auto-pay
   - Toggle via `POST /api/admin/settings` with `{ settings: { raffle_auto_trigger: "true" } }`
2. **Raffle event notifications** (always sent, regardless of auto/manual mode):
   - **144-block warning**: fires once per cycle, tracks sent block in `raffle_warning_sent_block` setting
   - **Block mined alert**: fires once, tracks in `raffle_block_notified` setting
   - Manual mode: sends admin link; Auto mode: runs raffle + announces winner
3. **Quiet hours** — 6pm–9am Roatan time (America/Tegucigalpa, UTC-6)
   - `isQuietHours()` in telegram.js checks current hour in Roatan timezone
   - Suppressed notifications stored in `pending_telegram_message` DB setting
   - `deliverPendingNotifications()` runs every 5 min poll, delivers at 9am
   - Note: New review submissions are NOT subject to quiet hours (immediate)
4. **Admin Telegram chat management**
   - `GET /api/admin/telegram/chats` — list primary + extra chat IDs
   - `POST /api/admin/telegram/chats` — add extra admin chat ID (sends confirmation msg)
   - `DELETE /api/admin/telegram/chats/:chatId` — remove extra chat ID
   - Extra IDs stored in `extra_telegram_chats` DB setting (comma-separated)
5. **Featured reviews**
   - `is_featured` column added to tickets (safe migration via ALTER TABLE)
   - `POST /api/admin/tickets/:id/feature` with `{ featured: true/false }`
   - `/reviews` page: only approved reviews, featured cards with gold styling at top
   - `getApprovedPublicTickets()` sorts featured first
6. **Raffle test suite** — `src/tests/raffle.test.js`
   - 19 tests, 0 external deps, runs with `npm test`
   - Tests: selectWinnerIndex, getNextRaffleBlock, getCurrentRaffleBlock, getBlocksUntilNextRaffle, distribution

## Architecture Decisions
1. **Tech Stack:** Node.js + Express + SQLite (sql.js) + EJS templates
2. **No user logins:** Simple email + LNURL registration
3. **Raffle timing:** Bitcoin difficulty adjustment (every 2016 blocks)
4. **Winner selection:** Deterministic via `block_hash mod ticket_count`
5. **Review validation:** Manual admin approval via Telegram (scraping/AI deprioritized)
6. **Lightning payments:** LND REST API via Voltage node
7. **Database:** sql.js (pure JS, no native compilation)
8. **Telegram auth:** Two auth methods — `ADMIN_PASSWORD` (browser) and `TELEGRAM_APPROVE_TOKEN` (one-tap)
9. **Quiet hours:** 6pm–9am Roatan time; new review notifications bypass quiet hours

## DB Settings Keys
| Key | Default | Purpose |
|-----|---------|---------|
| `review_mode` | `manual_review` | auto_approve or manual_review |
| `raffle_auto_trigger` | `false` | Auto-run raffle when block mined |
| `raffle_warning_sent_block` | `0` | Last block for which 144-warning was sent |
| `raffle_block_notified` | `0` | Last raffle block for which mined-alert was sent |
| `extra_telegram_chats` | `` | Comma-separated extra admin Telegram chat IDs |
| `pending_telegram_message` | `` | JSON-encoded notification held during quiet hours |

## Next Steps (Post Go-Live)
1. Test full flow: submit review → Telegram notification → Approve → verify ticket
2. Change `ADMIN_PASSWORD` from default
3. Verify Resend custom domain for production emails
4. Set `DEFAULT_PRIZE_SATS` to a real prize amount
5. Turn on `raffle_auto_trigger` when ready

## Important Notes
- **Live URL:** https://web-production-3a9f6.up.railway.app
- Code: https://github.com/jk212h20/BitcoinReview.git (branch: main)
- Railway auto-deploys on push to main
- **Next raffle block: #939,456** (~12 days away from 2026-02-20)
- **Admin Telegram management:** `POST /api/admin/telegram/chats` with `{chatId: "..."}` to add admins
