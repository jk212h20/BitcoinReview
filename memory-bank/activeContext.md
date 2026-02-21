# Active Context

## Current Focus (Updated 2026-02-20)

### Session 15: Bug fixes + pre-launch improvements

**What was fixed:**
1. `notifyNewReview(ticket, user, db)` — was missing `db` param, extra admin chat IDs didn't get new review alerts
2. `notifyRaffleResult(..., db)` in `admin.js` raffle/run — same missing `db` param
3. Quick-approve (`/quick-approve`) now sends `notifyTicketDecision` confirmation to all admins
4. Quick-reject (`/quick-reject`) now sends `notifyTicketDecision` confirmation to all admins

**Railway deploy issue:**
- GitHub webhook is broken — git pushes don't auto-trigger builds
- `serviceInstanceRedeploy` API reuses cached Docker image (no source rebuild)
- **Fix:** Go to Railway dashboard → service → Settings → disconnect/reconnect GitHub
- All code is correct in git (latest commit: `3b16ae4`)

## Telegram Review Flow (Complete)
When a review is submitted:
1. `notifyNewReview()` fires immediately (bypasses quiet hours)
2. Admin gets Telegram message with:
   - Merchant name + submitter (masked email/LN address)
   - Review text preview (first 200 chars)
   - `[Open Review]` → Google Maps URL
   - `[👁 View in Admin]` → `/admin/review/:id?password=TOKEN` (mobile approve page)
   - `[✅ Approve]` → one-tap GET `/api/admin/tickets/:id/quick-approve?token=TOKEN`
   - `[❌ Reject]` → one-tap GET `/api/admin/tickets/:id/quick-reject?token=TOKEN`
3. After approve/reject: `notifyTicketDecision` confirms back to all admins

## Architecture Decisions
1. **Tech Stack:** Node.js + Express + SQLite (sql.js) + EJS templates
2. **No user logins:** Simple email + LNURL registration
3. **Raffle timing:** Bitcoin difficulty adjustment (every 2016 blocks)
4. **Winner selection:** Deterministic via `block_hash mod ticket_count`
5. **Review validation:** Manual admin approval via Telegram
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

## Pre-Launch Checklist
- [ ] Fix Railway GitHub webhook (disconnect/reconnect in Railway dashboard)
- [ ] Test full flow: submit review → Telegram notification → Approve → verify ticket
- [ ] Change `ADMIN_PASSWORD` from default
- [ ] Verify Resend custom domain for production emails
- [ ] Set `DEFAULT_PRIZE_SATS` to a real prize amount
- [ ] Turn on `raffle_auto_trigger` when ready

## Important Notes
- **Live URL:** https://web-production-3a9f6.up.railway.app
- Code: https://github.com/jk212h20/BitcoinReview.git (branch: main)
- Railway auto-deploys on push to main (BROKEN — needs GitHub reconnect)
- **Next raffle block: #939,456** (~12 days away from 2026-02-20)
- **Admin Telegram management:** `POST /api/admin/telegram/chats` with `{chatId: "..."}` to add admins
- **Add admin:** Go to `/admin?password=YOURPASSWORD` → Telegram Chats section
