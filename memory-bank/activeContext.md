# Active Context

## Current Focus (Updated 2026-02-20)

### Just Completed: Telegram Admin Notifications + Go-Live Prep

**What was built (Session 13):**
1. **Telegram admin notifications** (`src/services/telegram.js`)
   - Notifies admin (via CoraTelegramBot) on every new review submission
   - Message includes: merchant name, masked submitter email, link to open review, one-tap Approve/Reject links
   - Also notifies on raffle results (winner, prize amount, Lightning address)
2. **One-tap approve/reject from Telegram**
   - `GET /api/admin/tickets/:id/quick-approve?token=<TELEGRAM_APPROVE_TOKEN>` — approves ticket, returns mobile-friendly HTML
   - `GET /api/admin/tickets/:id/quick-reject?token=<TELEGRAM_APPROVE_TOKEN>` — rejects ticket, returns mobile-friendly HTML
   - These bypass the admin password — use a separate long-lived secret token
3. **Mobile admin quick-review page** (`/admin/review/:id`)
   - Clean mobile page showing ticket details, review text, Approve/Reject buttons
   - Accepts either admin password (`?password=`) or TELEGRAM_APPROVE_TOKEN (`?token=`)
   - New view: `src/views/admin-review.ejs`
4. **Email + Lightning address now MANDATORY** on submit form and API
   - Previously email was optional; now required for raffle entry
   - Frontend validation + backend validation both enforce this
5. **Fixed LEFT JOIN bug** — anonymous tickets (user_id=null) were invisible in admin due to INNER JOIN; now uses LEFT JOIN in `getAllTickets()`, `getPendingTickets()`, `getTicketById()`
6. **TELEGRAM_APPROVE_TOKEN** generated and set on Railway: `b39cfda59cdd9...`

## Architecture Decisions
1. **Tech Stack:** Node.js + Express + SQLite (sql.js) + EJS templates
2. **No user logins:** Simple email + LNURL registration
3. **Raffle timing:** Bitcoin difficulty adjustment (every 2016 blocks)
4. **Winner selection:** Deterministic via `block_hash mod ticket_count`
5. **Review validation:** Manual admin approval via Telegram (scraping/AI deprioritized)
6. **Lightning payments:** LND REST API via Voltage node
7. **Database:** sql.js (pure JS, no native compilation)
8. **API Proxy:** Using PPQ (api.ppq.ai) as proxy to access Claude models
9. **Telegram auth:** Two separate auth methods — `ADMIN_PASSWORD` (for browser/API) and `TELEGRAM_APPROVE_TOKEN` (for one-tap links)

## Environment Variables (Railway production)
| Var | Purpose |
|-----|---------|
| `TELEGRAM_BOT_TOKEN` | CoraTelegramBot token |
| `TELEGRAM_CHAT_ID` | Admin's Telegram chat ID |
| `TELEGRAM_APPROVE_TOKEN` | Secret token for one-tap approve/reject links |
| `ADMIN_PASSWORD` | Admin dashboard/API password |
| `BASE_URL` | https://web-production-3a9f6.up.railway.app |

## Known Issues
- **Merchant name extraction** — Google Maps doesn't always expose the merchant name; some reviews show null merchant
- **PPQ API key** returning 401 — AI validation endpoint exists but needs valid key to work

## Next Steps (Post Go-Live)
1. Test full flow: submit review → receive Telegram notification → tap Approve → verify ticket approved
2. Change `ADMIN_PASSWORD` from default
3. Verify Resend custom domain for production emails
4. Add retry logic for failed Telegram sends
5. Add multi-admin support (store additional Telegram chat IDs in DB settings)

## Important Notes
- **Live URL:** https://web-production-3a9f6.up.railway.app
- Code pushed to: https://github.com/jk212h20/BitcoinReview.git
- Railway project: BitcoinReview (service: web, environment: production)
- **Telegram bot:** CoraTelegramBot (shared with Cline Notifier — fine for small projects)
- **Admin flow:** New review → Telegram message → tap "View in Admin" or directly "Approve"/"Reject"
- **Quick-approve routes** bypass adminAuth middleware (path matched in middleware before auth check)
