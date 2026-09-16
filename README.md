# Reviews Raffle - Roatán

Reviews Raffle rewards people who help local Roatán merchants get genuine reviews about Bitcoin payments. A visitor pays a participating merchant with Bitcoin, writes an honest review, submits the review link, and receives one entry after the review is approved.

The raffle is community funded. Half of the current raffle fund is offered as the next prize, while the other half stays in the fund for the following draw.

## For participants

1. Visit a merchant in Roatán and pay with Bitcoin, either on-chain or Lightning.
2. Write an honest Google or Tripadvisor review that mentions the experience.
3. Submit the review link at the site.
4. The team approves valid entries.
5. At the next Bitcoin difficulty-adjustment block, one approved entry wins the raffle.

A Lightning address is optional. Winners receive a secure claim link and can use a Lightning wallet to collect the prize.

## How the draw is verifiable

The raffle follows Bitcoin's 2,016-block difficulty-adjustment cycle, roughly every two weeks.

- The draw uses the hash of the adjustment block.
- Approved tickets are ordered by their ticket ID.
- `integer(block hash) mod number of approved tickets` selects the winning entry.

Anyone can inspect the trigger block on [mempool.space](https://mempool.space) and repeat the calculation. The site stores the trigger block, hash, ticket count, winning index, and prize amount with each raffle.

## Review moderation

The default setting is manual review. The admin dashboard can approve or reject submitted reviews. An Anthropic API key enables an additional AI validation tool, but it does not replace the operator's responsibility for moderation.

## Technical overview

- **Server:** Node.js and Express
- **Pages:** EJS templates and Tailwind CSS
- **Database:** SQLite, managed through `sql.js`
- **Bitcoin data:** Mempool.space
- **Merchant data:** BTCMap
- **Prize delivery:** Lightning claim links through the configured Lightning provider
- **Email:** Resend when configured
- **Hosting:** Railway

## Local development

### Requirements

- Node.js 18 or later
- npm

### Start the app

```bash
git clone https://github.com/jk212h20/BitcoinReview.git
cd BitcoinReview
npm ci
cp .env.example .env
npm run dev
```

Set at least `ADMIN_PASSWORD` in `.env`. Never commit `.env`, production credentials, database files, or payment-provider tokens.

Run the full test suite with:

```bash
npm test
```

Build the production CSS with:

```bash
npm run build
```

## Important environment variables

| Variable | Purpose | Required |
| --- | --- | --- |
| `PORT` | HTTP port, normally supplied by Railway | No |
| `DATABASE_PATH` | SQLite file location | Yes in production |
| `ADMIN_PASSWORD` | Admin dashboard password | Yes |
| `BASE_URL` | Public base URL used in claim links | Yes in production |
| `ANTHROPIC_API_KEY` | Enables AI review-assistance tool | No |
| `RESEND_API_KEY` and `EMAIL_FROM` | Winner email notifications | No, but recommended |
| Lightning-provider settings | Create and pay Lightning claims | Required to deliver prizes |
| `TELEGRAM_BOT_TOKEN` and admin chat settings | Admin notifications | No |

See `.env.example` for the full set of supported names. Production values belong in Railway variables, not in GitHub or local files.

## Railway deployment

Railway runs the app with the command in `railway.json` and checks `/api/health` after deployment.

1. Connect the GitHub repository to the Railway service.
2. Configure production variables in Railway.
3. Attach a persistent Railway Volume and set `DATABASE_PATH` to a file on that volume, for example `/data/reviews.db`.
4. Keep the service at exactly one Railway replica. The application uses an in-memory `sql.js` snapshot; the LNURL claim lock protects concurrent processes only when they share the same volume, while multiple replicas with independent snapshots are not a supported deployment.
5. Push a commit to the branch Railway deploys, currently `main`.
6. Confirm that the build succeeds and `/api/health` returns successfully before treating the release as live.

A local change, a feature branch, or an open pull request does not change the public website. A successful push to the deployed branch does.

## Safe release practice

- Small, content-only UX fixes may be committed and pushed to `main` after tests pass.
- Changes to raffle integrity, payments, security, or database migrations must go through a separate pull request, independent review, and an explicit merge decision.
- Do not delete or alter historical raffle or payout records without a documented audit.

## Useful links

- Live site: https://bitcoinreviewsraffle.com/
- Bitcoin Roatan: https://bitcoinroatan.info
- BTCMap: https://btcmap.org

## License

MIT
