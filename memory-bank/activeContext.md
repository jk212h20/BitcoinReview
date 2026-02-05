# Active Context

## Current Focus
Initial project setup and core infrastructure build.

## Recent Decisions
1. **Tech Stack:** Node.js + Express + SQLite + EJS templates
2. **No user logins:** Simple email + LNURL registration
3. **Raffle timing:** Bitcoin difficulty adjustment (every 2016 blocks)
4. **Winner selection:** Deterministic via `block_hash mod ticket_count`
5. **Review validation:** Anthropic API to check if review mentions Bitcoin
6. **Merchants:** Pull from btcmap.org, but accept any review mentioning Bitcoin

## Next Steps
1. Initialize Node.js project with package.json
2. Set up Express server with basic routes
3. Create SQLite database with schema
4. Build landing page with registration form
5. Build review submission page
6. Implement email service with opt-out links
7. Integrate btcmap.org API
8. Integrate Anthropic API for validation
9. Build raffle system
10. Create admin dashboard
11. Deploy to Railway

## Important Notes
- Always push completed features to: https://github.com/jk212h20/BitcoinReview.git
- Deploy via Railway.app
- Need Anthropic API key from user for review validation
- Need SMTP credentials for email sending

## Open Questions
- What Bitcoin address to use for donations?
- What SMTP provider to use for emails?
- What should the prize amount be per raffle?
