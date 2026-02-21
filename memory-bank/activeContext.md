# Active Context

## Current Focus (Updated 2026-02-21)

### Session 18: Fix Telegram links broken in Safari (reload loop)

**Problem:** Approve/View links from Telegram opened in Safari but got stuck in a reload loop (401 auth failure → login page → loop).

**Root cause:** Telegram's Markdown parser was corrupting URLs containing the 64-char `TELEGRAM_APPROVE_TOKEN`. Underscores and other chars in the hex token were interpreted as Markdown italic/bold markers, truncating the URL. The token in the URL didn't match the env var, causing 401 → login page.

**Fix (commit `456b26d`):**
- Switched ALL Telegram messages from `parse_mode: 'Markdown'` to `parse_mode: 'HTML'`
  - `*bold*` → `<b>bold</b>`, `_italic_` → `<i>italic</i>`, `` `code` `` → `<code>code</code>`
  - `[text](url)` → `<a href="url">text</a>` — HTML doesn't corrupt URLs
- Added `escapeHtml()` helper for safe content in HTML mode
- "View in Admin" link now uses `?token=` instead of `?password=` param
- `pages.js` route updated to accept both `?token=` and `?password=` query params
- `index.js` webhook messages also converted to HTML

### Previous sessions:
- **Session 17:** DB persistence fix — `DATABASE_PATH` → `/data/reviews.db` (Railway volume). Commit: `a477abc`
- **Session 16:** sql.js `last_insert_rowid` fix — read ID before `saveDatabase()`. Commit: `a26adb3`

## Telegram Review Flow (Complete)
When a review is submitted:
1. `notifyNewReview()` fires immediately (bypasses quiet hours)
2. Admin gets Telegram message with:
   - Merchant name + submitter (masked email/LN address)
   - Review text preview (first 200 chars)
   - `[Open Review]` → Google Maps URL
   - `[👁 View in Admin]` → `/admin/review/:id?token=TOKEN` (mobile approve page)
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
10. **sql.js quirk:** `db.export()` resets `last_insert_rowid()` — always read ID before save

## DB Settings Keys
| Key | Default | Purpose |
|-----|---------|---------|
| `review_mode` | `manual_review` | auto_approve or manual_review |
| `raffle_auto_trigger` | `false` | Auto-run raffle when block mined |
| `extra_telegram_chats` | `` | Comma-separated extra admin Telegram chat IDs |
| `pending_telegram_message` | `` | JSON-encoded notification held during quiet hours |

## Pre-Launch Checklist
- [x] Fix Railway GitHub webhook (reconnected — auto-deploys working)
- [x] Fix merchant name in Telegram notifications (last_insert_rowid bug)
- [ ] Test full flow end-to-end: submit → Telegram → Approve → verify
- [ ] Change `ADMIN_PASSWORD` from default
- [ ] Verify Resend custom domain for production emails
- [ ] Set `DEFAULT_PRIZE_SATS` to a real prize amount
- [ ] Turn on `raffle_auto_trigger` when ready

## Important Notes
- **Live URL:** https://web-production-3a9f6.up.railway.app
- Code: https://github.com/jk212h20/BitcoinReview.git (branch: main)
- **Next raffle block: #939,456** (~11 days away from 2026-02-21)
- **Admin Telegram management:** `POST /api/admin/telegram/chats` with `{chatId: "..."}` to add admins
