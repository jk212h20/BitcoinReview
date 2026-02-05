# Bitcoin Review Raffle - Project Brief

## Overview
A raffle system to incentivize Bitcoin adoption in Roatan by rewarding people who write Google reviews mentioning their Bitcoin purchases at local merchants.

## Core Concept
1. Users register with email + LNURL address
2. Users write Google reviews at Bitcoin-accepting merchants mentioning their Bitcoin purchase
3. Users submit review links to our platform
4. Every Bitcoin difficulty adjustment period (2016 blocks), one random reviewer wins Bitcoin

## Key Features

### User Registration
- Collect email and LNURL address
- No login required - simple form submission
- Send confirmation email with "wasn't me" opt-out link

### Review Submission
- Users submit Google review links + their email
- System verifies email exists in database
- AI (Anthropic API) validates review mentions Bitcoin purchase
- Valid reviews become raffle tickets

### Raffle System
- Triggered every 2016 blocks (Bitcoin difficulty adjustment)
- Winner selection: `block_hash mod number_of_valid_reviews`
- Deterministic and verifiable selection process

### Funding
- Display donation address on site
- Prize pool funded by community donations

### Merchants
- Pull merchant list from btcmap.org
- Accept reviews for any merchant mentioning Bitcoin purchase

## Technical Decisions
- Deploy via Railway.app
- Push completed features to: https://github.com/jk212h20/BitcoinReview.git
- Use Anthropic API for review validation

## Success Criteria
- Simple, frictionless user experience
- Transparent, verifiable raffle process
- Sustainable through community donations
