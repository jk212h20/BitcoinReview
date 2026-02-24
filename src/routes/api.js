/**
 * API routes for the unified submission flow
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const db = require('../services/database');
const email = require('../services/email');
const bitcoin = require('../services/bitcoin');
const btcmap = require('../services/btcmap');
const lightning = require('../services/lightning');
const anthropic = require('../services/anthropic');
const telegram = require('../services/telegram');

/**
 * POST /api/submit
 * Unified endpoint: accepts any combination of review link, email, ln address
 * Smart logic determines what to do based on what's provided
 */
router.post('/submit', async (req, res) => {
    try {
        const { email: userEmail, lnurl, reviewLink, reviewText, triedBitcoin, merchantAccepted } = req.body;
        
        const hasEmail = userEmail && userEmail.trim().length > 0;
        const hasLnurl = lnurl && lnurl.trim().length > 0;
        const hasReview = reviewLink && reviewLink.trim().length > 0;
        
        // Review link is required
        if (!hasReview) {
            return res.status(400).json({
                success: false,
                error: 'Please provide your Google review link'
            });
        }
        
        // Email is required
        if (!hasEmail) {
            return res.status(400).json({
                success: false,
                error: 'Please provide your email address'
            });
        }
        
        // Lightning address is now optional — winners claim via LNURL-withdraw QR code
        
        // Bitcoin experience questions are required
        if (triedBitcoin === undefined || triedBitcoin === null) {
            return res.status(400).json({
                success: false,
                error: 'Please answer: Did you try to use Bitcoin?'
            });
        }
        if (merchantAccepted === undefined || merchantAccepted === null) {
            return res.status(400).json({
                success: false,
                error: 'Please answer: Did the merchant accept Bitcoin?'
            });
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(userEmail.trim())) {
            return res.status(400).json({
                success: false,
                error: 'Invalid email address format'
            });
        }
        
        // Validate review link if provided
        if (hasReview) {
            const link = reviewLink.trim();
            // Accept any Google Maps/review-like URL
            // Allowed major review platforms (when review_link_mode = 'all')
            const TRUSTED_REVIEW_DOMAINS = [
                /google\.com\/maps/,
                /maps\.app\.goo\.gl/,
                /g\.page/,
                /goo\.gl\/maps/,
                /yelp\.com\/biz/,
                /tripadvisor\.com/,
                /trustpilot\.com\/review/,
                /facebook\.com\/.+\/reviews/,
                /foursquare\.com/,
                /opentable\.com/,
                /zomato\.com/,
                /yellowpages\.com/,
                /bbb\.org/,
                /glassdoor\.com/,
                /indeed\.com\/cmp/,
                /apple\.com\/maps/,
                /maps\.apple\.com/
            ];

            const reviewLinkMode = db.getSetting('review_link_mode') || 'google';
            let isValidLink;
            if (reviewLinkMode === 'google') {
                isValidLink = /google\.com\/maps|maps\.app\.goo\.gl|g\.page|goo\.gl\/maps/.test(link);
            } else {
                // 'all' mode — must match a trusted review domain
                isValidLink = TRUSTED_REVIEW_DOMAINS.some(pattern => pattern.test(link));
            }
            if (!isValidLink) {
                return res.status(400).json({
                    success: false,
                    error: reviewLinkMode === 'google'
                        ? 'Please provide a valid Google Maps or Google Reviews link'
                        : 'Please provide a review link from a major review platform (Google, Yelp, TripAdvisor, Trustpilot, etc.)'
                });
            }
        }
        
        // --- Determine what to do based on provided fields ---
        
        const cleanEmail = hasEmail ? userEmail.trim().toLowerCase() : null;
        const cleanLnurl = hasLnurl ? lnurl.trim() : null;
        const cleanReview = hasReview ? reviewLink.trim() : null;
        
        let user = null;
        let userCreated = false;
        let ticketCreated = false;
        let hasRaffleTicket = false;
        let raffleBlock = null;
        
        // If we have email or lnurl, find or create user
        if (cleanEmail || cleanLnurl) {
            const optOutToken = uuidv4();
            const result = db.findOrCreateUser(cleanEmail, cleanLnurl, optOutToken);
            
            if (result.error) {
                return res.status(400).json({
                    success: false,
                    error: result.error
                });
            }
            
            user = result.user;
            userCreated = result.created;
            
            if (!user) {
                console.error('findOrCreateUser returned null user. Result:', JSON.stringify(result));
                return res.status(500).json({
                    success: false,
                    error: 'Failed to create user account. Please try again.'
                });
            }
            
            // Send registration email if new user with email
            if (userCreated && cleanEmail && user.opt_out_token) {
                email.sendRegistrationEmail(cleanEmail, user.opt_out_token).catch(err => {
                    console.error('Failed to send registration email:', err);
                });
            }
        }
        
        // If we have a review link, create a ticket
        if (cleanReview) {
            // Check for duplicate review link for this user
            if (user) {
                const existingTicket = db.findTicketByUserAndLink(user.id, cleanReview);
                if (existingTicket) {
                    return res.status(400).json({
                        success: false,
                        error: 'This review has already been submitted'
                    });
                }
            }
            
            // Get current raffle block
            const currentHeight = await bitcoin.getCurrentBlockHeight();
            raffleBlock = bitcoin.getNextRaffleBlock(currentHeight);
            
            // A ticket gets a raffle entry if we have a user (email or lnurl)
            hasRaffleTicket = !!user;
            
            // Save review text if user pasted it
            const cleanReviewText = (reviewText && reviewText.trim().length > 0) ? reviewText.trim() : null;
            
            const cleanMerchantName = (req.body.merchantName && req.body.merchantName.trim()) ? req.body.merchantName.trim() : null;
            const ticket = db.createTicket(
                user ? user.id : null,
                cleanReview,
                cleanReviewText,
                cleanMerchantName,
                raffleBlock,
                !!triedBitcoin,
                !!merchantAccepted
            );
            
            // Check review_mode setting to determine validation behavior
            const reviewMode = db.getSetting('review_mode') || 'manual_review';
            
            if (reviewMode === 'auto_approve') {
                // Auto-approve: mark valid immediately
                db.validateTicket(ticket.id, true, 'Auto-approved');
            } else {
                // Manual review (default): mark as pending for admin review
                db.validateTicket(ticket.id, false, null);
            }
            
            ticketCreated = true;
            
            // Send Telegram notification to admin (non-blocking)
            const createdTicket = db.getTicketById(ticket.id);
            telegram.notifyNewReview(createdTicket || { id: ticket.id, review_link: cleanReview, review_text: cleanReviewText, merchant_name: null }, user, db).catch(err => {
                console.error('Failed to send Telegram notification:', err);
            });
        }
        
        // --- Build response message based on what happened ---
        const response = { success: true };
        
        if (cleanReview && hasRaffleTicket) {
            // Best case: review + identity = raffle ticket
            response.message = '🎉 Review submitted! You\'re entered in the raffle.';
            response.raffleTicket = true;
            response.raffleBlock = raffleBlock;
        } else if (cleanReview && !hasRaffleTicket) {
            // Review only, no identity
            response.message = 'Thanks for sharing your review! Add your email or Lightning address to enter the raffle.';
            response.raffleTicket = false;
            response.needsIdentity = true;
        } else if (!cleanReview && user) {
            // No review, just saving user info
            response.message = 'Info saved! Submit a Google review link to enter the raffle.';
            response.raffleTicket = false;
            response.needsReview = true;
        }
        
        res.json(response);
        
    } catch (error) {
        console.error('Submit error:', error);
        res.status(500).json({
            success: false,
            error: 'Something went wrong. Please try again.'
        });
    }
});

/**
 * POST /api/register (legacy - redirects to unified submit)
 */
router.post('/register', async (req, res) => {
    const { email: userEmail, lnurl } = req.body;
    // Forward to unified endpoint
    req.body.reviewLink = null;
    const { v4: uuidv4 } = require('uuid');
    
    try {
        if (!userEmail || !lnurl) {
            return res.status(400).json({
                success: false,
                error: 'Email and Lightning address are required'
            });
        }
        
        const optOutToken = uuidv4();
        const result = db.findOrCreateUser(userEmail.toLowerCase(), lnurl, optOutToken);
        
        if (result.error) {
            return res.status(400).json({ success: false, error: result.error });
        }
        
        if (result.created && userEmail) {
            email.sendRegistrationEmail(userEmail, result.user.opt_out_token).catch(err => {
                console.error('Failed to send registration email:', err);
            });
        }
        
        res.json({
            success: true,
            message: 'Registration successful! Check your email for confirmation.'
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ success: false, error: 'Registration failed. Please try again.' });
    }
});

/**
 * POST /api/submit-review (legacy - redirects to unified submit)
 */
router.post('/submit-review', async (req, res) => {
    req.body.lnurl = null;
    // Forward to the unified handler logic
    const { email: userEmail, reviewLink } = req.body;
    req.body = { email: userEmail, lnurl: null, reviewLink };
    
    // Just call the unified submit logic
    try {
        const hasEmail = userEmail && userEmail.trim().length > 0;
        const hasReview = reviewLink && reviewLink.trim().length > 0;
        
        if (!hasReview) {
            return res.status(400).json({ success: false, error: 'Review link is required' });
        }
        
        const cleanEmail = hasEmail ? userEmail.trim().toLowerCase() : null;
        const cleanReview = reviewLink.trim();
        
        let user = null;
        if (cleanEmail) {
            user = db.findUserByEmail(cleanEmail);
            if (!user) {
                return res.status(400).json({ success: false, error: 'Email not registered. Please register first.' });
            }
        }
        
        const currentHeight = await bitcoin.getCurrentBlockHeight();
        const raffleBlock = bitcoin.getNextRaffleBlock(currentHeight);
        
        const ticket = db.createTicket(user ? user.id : null, cleanReview, null, null, raffleBlock);
        if (user) {
            db.validateTicket(ticket.id, true, 'Auto-validated');
        }
        
        res.json({
            success: true,
            message: 'Review submitted and validated! You are entered in the raffle.',
            raffleBlock
        });
    } catch (error) {
        console.error('Submit review error:', error);
        res.status(500).json({ success: false, error: 'Failed to submit review. Please try again.' });
    }
});

/**
 * GET /api/merchants
 * Get list of Bitcoin merchants in Roatan
 */
router.get('/merchants', async (req, res) => {
    try {
        const merchants = await btcmap.getMerchantList();
        res.json({
            success: true,
            merchants,
            count: merchants.length
        });
    } catch (error) {
        console.error('Merchants fetch error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch merchants'
        });
    }
});

/**
 * GET /api/raffle-info
 * Get current raffle information
 */
router.get('/raffle-info', async (req, res) => {
    try {
        const info = await bitcoin.getRaffleInfo();
        const ticketCount = db.countValidTicketsForBlock(info.nextRaffleBlock);
        const latestRaffle = db.getLatestRaffle();
        
        res.json({
            success: true,
            ...info,
            ticketCount,
            latestRaffle: latestRaffle ? {
                blockHeight: latestRaffle.block_height,
                totalTickets: latestRaffle.total_tickets,
                prizeAmount: latestRaffle.prize_amount_sats,
                winnerEmail: latestRaffle.email ? 
                    latestRaffle.email.replace(/(.{2}).*(@.*)/, '$1***$2') : null
            } : null
        });
    } catch (error) {
        console.error('Raffle info error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch raffle info'
        });
    }
});

/**
 * GET /api/stats
 * Get public statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const userCount = db.getUserCount();
        const raffles = db.getAllRaffles();
        
        // Gracefully handle blockchain API timeouts so healthcheck still passes
        let info = null;
        let ticketCount = 0;
        try {
            info = await bitcoin.getRaffleInfo();
            ticketCount = db.countValidTicketsForBlock(info.nextRaffleBlock);
        } catch (err) {
            console.warn('Stats: blockchain API unavailable:', err.message);
        }
        
        res.json({
            success: true,
            stats: {
                registeredUsers: userCount,
                currentRaffleTickets: ticketCount,
                totalRaffles: raffles.length,
                nextRaffleBlock: info ? info.nextRaffleBlock : null,
                blocksUntilRaffle: info ? info.blocksUntilNext : null,
                timeEstimate: info ? info.timeEstimate : null
            }
        });
    } catch (error) {
        console.error('Stats error:', error);
        // Still return 200 for healthcheck - basic stats are available even if blockchain API fails
        res.json({
            success: true,
            stats: {
                registeredUsers: 0,
                currentRaffleTickets: 0,
                totalRaffles: 0,
                nextRaffleBlock: null,
                blocksUntilRaffle: null,
                timeEstimate: null
            }
        });
    }
});

/**
 * GET /api/deposit-info
 * Get current deposit addresses (on-chain + lightning)
 */
router.get('/deposit-info', async (req, res) => {
    try {
        const info = await lightning.getDepositInfo();
        const totalDonations = db.getTotalDonationsReceived();
        
        res.json({
            success: true,
            onchainAddress: info.onchainAddress,
            lightningInvoice: info.lightningInvoice,
            totalDonationsSats: totalDonations
        });
    } catch (error) {
        console.error('Deposit info error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch deposit info'
        });
    }
});

/**
 * POST /api/generate-invoice
 * Generate a Lightning invoice with a specific amount
 */
router.post('/generate-invoice', async (req, res) => {
    try {
        const { amount } = req.body;
        const amountSats = parseInt(amount);
        
        if (!amountSats || amountSats < 1) {
            return res.status(400).json({
                success: false,
                error: 'Please provide a valid amount in sats (minimum 1)'
            });
        }
        
        if (amountSats > 10000000) { // 0.1 BTC max
            return res.status(400).json({
                success: false,
                error: 'Amount too large (max 10,000,000 sats)'
            });
        }
        
        const result = await lightning.createDonationInvoice(amountSats, `Donation to Bitcoin Review Raffle - ${amountSats} sats`);
        
        res.json({
            success: true,
            bolt11: result.bolt11,
            paymentHash: result.paymentHash,
            amountSats
        });
    } catch (error) {
        console.error('Generate invoice error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate invoice'
        });
    }
});

/**
 * GET /api/raffle-fund
 * Get current raffle fund balance and next prize amount
 * The fund is tracked separately from the LND node balance.
 * Prize = 50% of fund, awarded each raffle.
 */
router.get('/raffle-fund', async (req, res) => {
    try {
        const fundSats = parseInt(db.getSetting('raffle_fund_sats') || '0');
        const nextPrizeSats = Math.floor(fundSats / 2);

        res.json({
            success: true,
            totalFundSats: fundSats,
            nextPrizeSats: nextPrizeSats
        });
    } catch (error) {
        console.error('Raffle fund error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch fund info' });
    }
});

/**
 * POST /api/raffle-fund/add
 * Admin: add sats to the raffle fund (e.g. manual seed deposit)
 * Requires admin password in body
 */
router.post('/raffle-fund/add', (req, res) => {
    try {
        const { password, amount } = req.body;
        
        if (!password || password !== process.env.ADMIN_PASSWORD) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        const amountSats = parseInt(amount);
        if (!amountSats || amountSats < 1) {
            return res.status(400).json({ success: false, error: 'Invalid amount' });
        }
        
        const currentFund = parseInt(db.getSetting('raffle_fund_sats') || '0');
        const newFund = currentFund + amountSats;
        db.setSetting('raffle_fund_sats', String(newFund));
        
        console.log(`🎯 Raffle fund manually increased: ${currentFund} + ${amountSats} = ${newFund} sats`);
        
        res.json({
            success: true,
            previousFund: currentFund,
            added: amountSats,
            newFund: newFund,
            nextPrize: Math.floor(newFund / 2)
        });
    } catch (error) {
        console.error('Add to fund error:', error);
        res.status(500).json({ success: false, error: 'Failed to add to fund' });
    }
});

/**
 * POST /api/raffle-fund/set
 * Admin: set the raffle fund to an exact amount (for corrections)
 * Requires admin password in body
 */
router.post('/raffle-fund/set', (req, res) => {
    try {
        const { password, amount } = req.body;
        
        if (!password || password !== process.env.ADMIN_PASSWORD) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        const amountSats = parseInt(amount);
        if (isNaN(amountSats) || amountSats < 0) {
            return res.status(400).json({ success: false, error: 'Invalid amount (must be >= 0)' });
        }
        
        const previousFund = parseInt(db.getSetting('raffle_fund_sats') || '0');
        db.setSetting('raffle_fund_sats', String(amountSats));
        
        console.log(`🎯 Raffle fund manually set: ${previousFund} → ${amountSats} sats`);
        
        res.json({
            success: true,
            previousFund,
            newFund: amountSats,
            nextPrize: Math.floor(amountSats / 2)
        });
    } catch (error) {
        console.error('Set fund error:', error);
        res.status(500).json({ success: false, error: 'Failed to set fund' });
    }
});

// ============================================================
// LNURL-Withdraw endpoints (LUD-03) — claim raffle prizes
// ============================================================

const { bech32 } = require('bech32');

/**
 * Encode a URL as an LNURL (bech32-encoded, uppercase)
 */
function encodeLnurl(url) {
    const words = bech32.toWords(Buffer.from(url, 'utf8'));
    return bech32.encode('lnurl', words, 2000).toUpperCase();
}

/**
 * GET /api/lnurl/withdraw/:token
 * LNURL-withdraw first call — wallet fetches withdraw parameters
 * Returns LUD-03 withdrawRequest JSON
 */
router.get('/lnurl/withdraw/:token', (req, res) => {
    try {
        const { token } = req.params;
        const raffle = db.findRaffleByClaimToken(token);
        
        if (!raffle) {
            return res.status(404).json({ status: 'ERROR', reason: 'Claim not found' });
        }
        
        if (raffle.claim_status === 'claimed') {
            return res.status(400).json({ status: 'ERROR', reason: 'Prize already claimed' });
        }
        
        if (raffle.claim_status === 'expired') {
            return res.status(400).json({ status: 'ERROR', reason: 'Claim link has expired' });
        }
        
        // Check expiry
        if (raffle.claim_expires_at && new Date(raffle.claim_expires_at) < new Date()) {
            db.markRaffleClaimExpired(raffle.id);
            return res.status(400).json({ status: 'ERROR', reason: 'Claim link has expired' });
        }
        
        const prizeSats = raffle.prize_amount_sats || 0;
        const prizeMillisats = prizeSats * 1000;
        
        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
        const callbackUrl = `${baseUrl}/api/lnurl/withdraw/${token}/callback`;
        
        // LUD-03 withdrawRequest response
        res.json({
            tag: 'withdrawRequest',
            callback: callbackUrl,
            k1: token,
            defaultWithdrawable: prizeMillisats,
            minWithdrawable: prizeMillisats,
            maxWithdrawable: prizeMillisats
        });
    } catch (error) {
        console.error('LNURL withdraw error:', error);
        res.status(500).json({ status: 'ERROR', reason: 'Internal server error' });
    }
});

/**
 * GET /api/lnurl/withdraw/:token/callback
 * LNURL-withdraw callback — wallet sends a BOLT11 invoice for us to pay
 */
router.get('/lnurl/withdraw/:token/callback', async (req, res) => {
    try {
        const { token } = req.params;
        const { k1, pr } = req.query;
        
        // Validate k1 matches token
        if (k1 !== token) {
            return res.json({ status: 'ERROR', reason: 'Invalid k1 parameter' });
        }
        
        if (!pr) {
            return res.json({ status: 'ERROR', reason: 'Missing invoice (pr parameter)' });
        }
        
        const raffle = db.findRaffleByClaimToken(token);
        
        if (!raffle) {
            return res.json({ status: 'ERROR', reason: 'Claim not found' });
        }
        
        if (raffle.claim_status === 'claimed') {
            return res.json({ status: 'ERROR', reason: 'Prize already claimed' });
        }
        
        if (raffle.claim_status === 'expired') {
            return res.json({ status: 'ERROR', reason: 'Claim has expired' });
        }
        
        // Check expiry
        if (raffle.claim_expires_at && new Date(raffle.claim_expires_at) < new Date()) {
            db.markRaffleClaimExpired(raffle.id);
            return res.json({ status: 'ERROR', reason: 'Claim has expired' });
        }
        
        const prizeSats = raffle.prize_amount_sats || 0;
        
        // Decode invoice to verify amount
        try {
            const decoded = await lightning.decodePayReq(pr);
            const invoiceSats = parseInt(decoded.num_satoshis || '0');
            
            // Allow the invoice amount to match (wallet may round slightly)
            if (invoiceSats > prizeSats) {
                return res.json({ status: 'ERROR', reason: `Invoice amount (${invoiceSats} sats) exceeds prize (${prizeSats} sats)` });
            }
        } catch (decodeErr) {
            console.error('Invoice decode error:', decodeErr.message);
            return res.json({ status: 'ERROR', reason: 'Failed to decode invoice' });
        }
        
        // Pay the invoice via LND
        try {
            console.log(`⚡ LNURL-withdraw: paying ${prizeSats} sats for claim ${token.substring(0, 8)}...`);
            const paymentResult = await lightning.payInvoice(pr);
            
            const paymentHash = paymentResult.payment_hash || '';
            db.markRaffleClaimed(raffle.id, paymentHash);
            
            console.log(`✅ LNURL-withdraw claim successful! Raffle #${raffle.id}, ${prizeSats} sats, hash: ${paymentHash}`);
            
            res.json({ status: 'OK' });
        } catch (payErr) {
            console.error('LNURL-withdraw payment failed:', payErr.message);
            db.markRafflePaymentFailed(raffle.id, payErr.message);
            return res.json({ status: 'ERROR', reason: 'Payment failed: ' + payErr.message });
        }
    } catch (error) {
        console.error('LNURL withdraw callback error:', error);
        res.json({ status: 'ERROR', reason: 'Internal server error' });
    }
});

/**
 * GET /api/claim/:token/status
 * Poll endpoint for the claim page to check if prize has been claimed
 */
router.get('/claim/:token/status', (req, res) => {
    try {
        const { token } = req.params;
        const raffle = db.findRaffleByClaimToken(token);
        
        if (!raffle) {
            return res.status(404).json({ success: false, error: 'Claim not found' });
        }
        
        res.json({
            success: true,
            status: raffle.claim_status || 'pending',
            claimedAt: raffle.claimed_at || null,
            prizeSats: raffle.prize_amount_sats || 0
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to check status' });
    }
});

/**
 * GET /api/health
 * Lightweight health check - no external dependencies
 * Used by Railway to confirm the server is up
 */
router.get('/health', (req, res) => {
    res.json({ ok: true, ts: Date.now() });
});

module.exports = router;
