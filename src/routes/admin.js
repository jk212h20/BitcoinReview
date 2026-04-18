/**
 * Admin routes for managing raffles and tickets
 */

const express = require('express');
const router = express.Router();

const db = require('../services/database');
const bitcoin = require('../services/bitcoin');
const email = require('../services/email');
const lightning = require('../services/lightning');
const anthropic = require('../services/anthropic');
const telegram = require('../services/telegram');
const auth = require('../services/auth');

/**
 * Session/password authentication middleware.
 *
 * Accepts EITHER:
 *   - A valid signed session cookie (set via POST /admin/login), OR
 *   - A raw password via header/body/query (back-compat for existing fetch calls
 *     that carry X-Admin-Password, and for legacy Telegram links).
 *
 * When password auth succeeds, a fresh session cookie is issued so subsequent
 * requests don't need to keep re-sending the password.
 */
function adminAuth(req, res, next) {
    // Require either a DB-stored hash OR the env var to be configured.
    const hasConfig = !!(db.getSetting && db.getSetting('admin_password_hash')) || !!process.env.ADMIN_PASSWORD;
    if (!hasConfig) {
        return res.status(500).json({ error: 'Admin password not configured' });
    }

    if (auth.isAuthenticated(req, res, db)) {
        return next();
    }
    return res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Token authentication middleware for Telegram one-tap links
 * Uses TELEGRAM_APPROVE_TOKEN env var (separate from admin password)
 */
function tokenAuth(req, res, next) {
    const token = req.query.token || req.body.token || req.headers['x-approve-token'];
    const approveToken = process.env.TELEGRAM_APPROVE_TOKEN;
    
    if (!approveToken) {
        return res.status(500).send(minimalPage('❌ Error', 'TELEGRAM_APPROVE_TOKEN not configured'));
    }
    
    if (token !== approveToken) {
        return res.status(401).send(minimalPage('❌ Invalid Token', 'The approve token is invalid or expired.'));
    }
    
    next();
}

/** Generate a minimal but complete HTML page (fixes Safari reload loop) */
function minimalPage(title, body, linkHtml) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:-apple-system,sans-serif;text-align:center;padding:40px 20px}h1{margin-bottom:12px}p{color:#666}a{color:#f7931a}</style></head><body><h1>${title}</h1><p>${body}</p>${linkHtml||''}</body></html>`;
}

// ── Public admin auth endpoints (no auth required on these paths themselves) ──

/**
 * POST /api/admin/login
 * Body: { password }
 * Sets an HttpOnly signed session cookie and returns { success, redirect }.
 * Used by the admin login form (which now POSTs instead of GETs).
 */
router.post('/login', express.json(), (req, res) => {
    const { password } = req.body || {};
    if (!password) {
        return res.status(400).json({ success: false, error: 'Password required' });
    }
    if (!auth.verifyPassword(password, db)) {
        return res.status(401).json({ success: false, error: 'Invalid password' });
    }
    auth.setSessionCookie(res, req);
    // For classic form POST (Accept: text/html) redirect; otherwise return JSON
    const accept = (req.headers.accept || '').toLowerCase();
    if (accept.includes('text/html')) {
        return res.redirect(303, '/admin');
    }
    return res.json({ success: true, redirect: '/admin' });
});

/**
 * POST /api/admin/logout
 * Clears the session cookie and redirects to login.
 */
router.post('/logout', (req, res) => {
    auth.clearSessionCookie(res);
    const accept = (req.headers.accept || '').toLowerCase();
    if (accept.includes('text/html')) {
        return res.redirect(303, '/admin');
    }
    return res.json({ success: true });
});
// Allow GET for convenience (e.g. direct click from address bar or top-nav link)
router.get('/logout', (req, res) => {
    auth.clearSessionCookie(res);
    return res.redirect(303, '/admin');
});

// Apply password auth to all OTHER admin routes EXCEPT quick-approve/reject (token auth)
router.use((req, res, next) => {
    // Skip adminAuth for quick-approve and quick-reject (they use tokenAuth instead)
    if (req.path.match(/^\/tickets\/\d+\/quick-(approve|reject)$/)) {
        return next();
    }
    return adminAuth(req, res, next);
});

/**
 * POST /api/admin/change-password
 * Body: { currentPassword, newPassword }
 * Stores a scrypt hash in the settings table (overrides ADMIN_PASSWORD env).
 * Rotates the session cookie so the caller stays logged in.
 */
router.post('/change-password', (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, error: 'currentPassword and newPassword are required' });
        }
        if (typeof newPassword !== 'string' || newPassword.length < 8) {
            return res.status(400).json({ success: false, error: 'New password must be at least 8 characters' });
        }
        if (!auth.verifyPassword(currentPassword, db)) {
            return res.status(401).json({ success: false, error: 'Current password is incorrect' });
        }
        auth.setPassword(newPassword, db);
        // Rotate the session so the cookie is re-signed against the (same) key
        // and sliding window restarts.
        auth.setSessionCookie(res, req);
        console.log('🔑 Admin password changed');
        return res.json({ success: true, message: 'Password updated. Stored in database; ADMIN_PASSWORD env is no longer used unless the DB value is cleared.' });
    } catch (error) {
        console.error('Change password error:', error);
        return res.status(500).json({ success: false, error: 'Failed to change password' });
    }
});

/**
 * GET /admin/dashboard
 * Get admin dashboard data
 */
router.get('/dashboard', async (req, res) => {
    try {
        const users = db.getAllUsers();
        const tickets = db.getAllTickets();
        const pendingTickets = db.getPendingTickets();
        const raffles = db.getAllRaffles();
        const raffleInfo = await bitcoin.getRaffleInfo();
        
        res.json({
            success: true,
            data: {
                users: {
                    total: users.length,
                    list: users.slice(0, 50) // Last 50
                },
                tickets: {
                    total: tickets.length,
                    pending: pendingTickets.length,
                    list: tickets.slice(0, 50)
                },
                raffles: {
                    total: raffles.length,
                    list: raffles
                },
                blockchain: raffleInfo
            }
        });
    } catch (error) {
        console.error('Admin dashboard error:', error);
        res.status(500).json({ error: 'Failed to load dashboard' });
    }
});

/**
 * GET /admin/users
 * Get all registered users
 */
router.get('/users', (req, res) => {
    try {
        const users = db.getAllUsers();
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

/**
 * GET /admin/tickets
 * Get all tickets
 */
router.get('/tickets', (req, res) => {
    try {
        const tickets = db.getAllTickets();
        res.json({ success: true, tickets });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch tickets' });
    }
});

/**
 * GET /admin/tickets/pending
 * Get pending tickets needing validation
 */
router.get('/tickets/pending', (req, res) => {
    try {
        const tickets = db.getPendingTickets();
        res.json({ success: true, tickets });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch pending tickets' });
    }
});

/**
 * POST /admin/tickets/:id/validate
 * Manually validate or reject a ticket
 */
router.post('/tickets/:id/validate', (req, res) => {
    try {
        const { id } = req.params;
        const { isValid, reason } = req.body;
        
        const ticket = db.getTicketById(parseInt(id));
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found' });
        }
        
        db.validateTicket(parseInt(id), isValid, reason || 'Manual validation');
        
        res.json({
            success: true,
            message: `Ticket ${isValid ? 'approved' : 'rejected'}`
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to validate ticket' });
    }
});

/**
 * POST /admin/raffle/test
 * LIVE test raffle — picks a winner from ALL approved tickets using the latest block hash.
 * Creates a real raffle record (100 sats prize), generates a claim link,
 * and emails the winner. The winner scans the QR code with any Lightning wallet.
 * Use DELETE /admin/raffle/:id to clean up test entries afterwards.
 */
router.post('/raffle/test', async (req, res) => {
    try {
        const crypto = require('crypto');
        const prizeSats = 100;

        // Get all approved tickets (regardless of raffle_block)
        const allApproved = db.getAllTickets().filter(t => t.is_valid === 1);

        if (allApproved.length === 0) {
            return res.status(400).json({ error: 'No approved tickets to draw from' });
        }

        // Site-budget guard: refuse the test if even the 100-sat fee would push
        // this site below 0 in its ledger (donations − payouts).
        const available = lightning.getSiteAvailableSats();
        if (prizeSats > available) {
            return res.status(400).json({
                error: `Test raffle needs ${prizeSats} sats but this site only has ${available.toLocaleString()} sats available. Top up the raffle fund first.`,
                requested: prizeSats,
                available
            });
        }

        // Use the current block height to get a real block hash for randomness
        const currentHeight = await bitcoin.getCurrentBlockHeight();
        const blockHash = await bitcoin.getBlockHash(currentHeight);

        // Select winner deterministically
        const winnerIndex = bitcoin.selectWinnerIndex(blockHash, allApproved.length);
        const winningTicket = allApproved[winnerIndex];

        // Deduct prize from raffle fund
        const currentFund = parseInt(db.getSetting('raffle_fund_sats') || '0');
        if (currentFund >= prizeSats) {
            db.setSetting('raffle_fund_sats', String(currentFund - prizeSats));
            console.log(`🧪 Test raffle: fund ${currentFund} - ${prizeSats} = ${currentFund - prizeSats} sats`);
        }

        // Create a real raffle record
        const raffle = db.createRaffle(
            currentHeight, blockHash, allApproved.length, winnerIndex, winningTicket.id, prizeSats
        );

        console.log(`🧪 Test raffle committed! Block #${currentHeight}, winner index: ${winnerIndex}/${allApproved.length}, ticket #${winningTicket.id}, prize: ${prizeSats} sats`);

        // Generate claim token (LNURL-withdraw) — winner scans QR to claim
        const claimToken = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        db.setRaffleClaimToken(raffle.id, claimToken, expiresAt);
        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const claimLink = `${baseUrl}/claim/${claimToken}`;

        console.log(`🧪 Test raffle claim link: ${claimLink}`);

        // Email winner with claim link (if they have email)
        let emailResult = null;
        if (winningTicket.email) {
            try {
                emailResult = await email.sendWinnerEmail(
                    winningTicket.email, prizeSats, claimToken, currentHeight
                );
                console.log(`📧 Test raffle winner email sent to ${winningTicket.email}`);
            } catch (emailErr) {
                console.error('⚠️ Test raffle email failed:', emailErr.message);
                emailResult = { error: emailErr.message };
            }
        }

        res.json({
            success: true,
            test: true,
            message: 'LIVE TEST — raffle record created, claim link generated' + (emailResult && !emailResult.error ? ', email sent!' : emailResult ? ' (email failed: ' + emailResult.error + ')' : ' (no email on file)') + ' Delete from Raffles tab to clean up.',
            raffle: {
                id: raffle.id,
                blockHeight: currentHeight,
                blockHash,
                totalTickets: allApproved.length,
                winnerIndex,
                formula: `int("0x0000...${blockHash.slice(-16)}") mod ${allApproved.length} = ${winnerIndex}`,
                winner: {
                    ticketId: winningTicket.id,
                    email: winningTicket.email || 'Anonymous',
                    lnurl: winningTicket.lnurl_address || 'None',
                    merchantName: winningTicket.merchant_name || '-',
                    reviewLink: winningTicket.review_link
                },
                prizeAmountSats: prizeSats,
                claimLink,
                email: emailResult,
                note: 'Winner must scan the claim QR code with any Lightning wallet to receive sats. Use the 🗑️ Delete button in the Raffles tab to remove this test.'
            }
        });

    } catch (error) {
        console.error('Test raffle error:', error);
        res.status(500).json({ error: 'Test raffle failed: ' + error.message });
    }
});

/**
 * DELETE /admin/raffle/:id
 * Delete a raffle record (for cleaning up test raffles)
 * Optionally refunds the prize amount back to the raffle fund
 */
router.delete('/raffle/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { refund } = req.body || {};
        
        // Find the raffle first
        const raffles = db.getAllRaffles();
        const raffle = raffles.find(r => r.id === parseInt(id));
        
        if (!raffle) {
            return res.status(404).json({ error: 'Raffle not found' });
        }
        
        // Optionally refund the prize to the raffle fund
        if (refund && raffle.prize_amount_sats) {
            const currentFund = parseInt(db.getSetting('raffle_fund_sats') || '0');
            db.setSetting('raffle_fund_sats', String(currentFund + raffle.prize_amount_sats));
            console.log(`🗑️ Raffle #${id} deleted — refunded ${raffle.prize_amount_sats} sats to fund (${currentFund} + ${raffle.prize_amount_sats} = ${currentFund + raffle.prize_amount_sats})`);
        } else {
            console.log(`🗑️ Raffle #${id} deleted (no refund)`);
        }
        
        db.deleteRaffle(parseInt(id));
        
        res.json({
            success: true,
            message: `Raffle #${id} deleted` + (refund && raffle.prize_amount_sats ? ` (${raffle.prize_amount_sats} sats refunded to fund)` : ''),
            refunded: refund ? (raffle.prize_amount_sats || 0) : 0
        });
    } catch (error) {
        console.error('Delete raffle error:', error);
        res.status(500).json({ error: 'Failed to delete raffle: ' + error.message });
    }
});

/**
 * POST /admin/raffle/run
 * Run the raffle for a specific block
 */
router.post('/raffle/run', async (req, res) => {
    try {
        const { blockHeight, prizeAmountSats } = req.body;
        
        if (!blockHeight) {
            return res.status(400).json({ error: 'Block height required' });
        }
        
        // Check if raffle already run for this block
        const existingRaffle = db.findRaffleByBlock(blockHeight);
        if (existingRaffle) {
            return res.status(400).json({ 
                error: 'Raffle already run for this block',
                raffle: existingRaffle
            });
        }
        
        // Check if block has been mined
        const isMined = await bitcoin.isRaffleBlockMined(blockHeight);
        if (!isMined) {
            return res.status(400).json({ error: 'Block has not been mined yet' });
        }
        
        // Get block hash
        const blockHash = await bitcoin.getBlockHash(blockHeight);
        
        // Get valid tickets for this raffle period
        const tickets = db.getValidTicketsForBlock(blockHeight);
        
        if (tickets.length === 0) {
            return res.status(400).json({ error: 'No valid tickets for this raffle period' });
        }

        // Site-budget guard: refuse to commit a raffle whose prize exceeds the
        // site's available ledger balance. The shared LND node may have more —
        // those funds belong to other sites.
        if (prizeAmountSats) {
            const available = lightning.getSiteAvailableSats();
            if (prizeAmountSats > available) {
                return res.status(400).json({
                    error: `Prize ${prizeAmountSats.toLocaleString()} sats exceeds this site's available fund (${available.toLocaleString()} sats). Top up the raffle fund with a real donation first.`,
                    requested: prizeAmountSats,
                    available
                });
            }
        }

        // Select winner
        const winnerIndex = bitcoin.selectWinnerIndex(blockHash, tickets.length);
        const winningTicket = tickets[winnerIndex];

        // Create raffle record
        const raffle = db.createRaffle(
            blockHeight,
            blockHash,
            tickets.length,
            winnerIndex,
            winningTicket.id,
            prizeAmountSats || null
        );
        
        const crypto = require('crypto');
        const prizeSats = prizeAmountSats || parseInt(process.env.DEFAULT_PRIZE_SATS) || 0;
        
        // Generate claim token (LNURL-withdraw)
        const claimToken = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        db.setRaffleClaimToken(raffle.id, claimToken, expiresAt);
        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const claimLink = `${baseUrl}/claim/${claimToken}`;
        
        console.log(`🎰 Manual raffle committed! Block #${blockHeight}, claim link: ${claimLink}`);
        
        // Notify admin via Telegram
        telegram.notifyRaffleResult(
            { block_height: blockHeight, total_tickets: tickets.length, prize_amount_sats: prizeSats },
            winningTicket,
            db
        ).catch(err => console.error('Telegram raffle notify error:', err));
        
        // Send winner email with claim link
        if (winningTicket.email) {
            email.sendWinnerEmail(
                winningTicket.email,
                prizeSats,
                claimToken,
                blockHeight
            ).catch(err => {
                console.error('Failed to send winner email:', err);
            });
        }
        
        res.json({
            success: true,
            raffle: {
                id: raffle.id,
                blockHeight,
                blockHash,
                totalTickets: tickets.length,
                winnerIndex,
                winner: {
                    ticketId: winningTicket.id,
                    email: winningTicket.email,
                    lnurl: winningTicket.lnurl_address,
                    reviewLink: winningTicket.review_link
                },
                prizeAmountSats: prizeSats,
                claimLink
            }
        });
        
    } catch (error) {
        console.error('Raffle run error:', error);
        res.status(500).json({ error: 'Failed to run raffle: ' + error.message });
    }
});

/**
 * POST /admin/raffle/:id/mark-paid
 * Mark a raffle as paid
 */
router.post('/raffle/:id/mark-paid', (req, res) => {
    try {
        const { id } = req.params;
        
        db.markRafflePaid(parseInt(id));
        
        res.json({
            success: true,
            message: 'Raffle marked as paid'
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to mark raffle as paid' });
    }
});

/**
 * GET /admin/raffles
 * Get all raffles
 */
router.get('/raffles', (req, res) => {
    try {
        const raffles = db.getAllRaffles();
        res.json({ success: true, raffles });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch raffles' });
    }
});

/**
 * POST /admin/raffle/:id/pay
 * Pay the raffle winner via Lightning
 */
router.post('/raffle/:id/pay', async (req, res) => {
    try {
        const { id } = req.params;
        const { amountSats } = req.body;
        
        // Get raffle with winner info
        const raffles = db.getAllRaffles();
        const raffle = raffles.find(r => r.id === parseInt(id));
        
        if (!raffle) {
            return res.status(404).json({ error: 'Raffle not found' });
        }
        
        if (raffle.paid_at) {
            return res.status(400).json({ error: 'Raffle already paid' });
        }
        
        if (!raffle.lnurl_address) {
            return res.status(400).json({ error: 'Winner has no Lightning Address' });
        }
        
        // Prize amount resolution (NEVER fall back to DEFAULT_PRIZE_SATS — that env var
        // was a leftover from testing and would cause the advertised prize promise to
        // silently be replaced by a 100-sat dev value).
        //
        // Priority:
        //   1. Explicit amountSats passed from the client (admin override)
        //   2. raffle.prize_amount_sats — the value stamped at raffle commit time
        //      (this IS the advertised prize that was shown when the raffle ran)
        //   3. 50% of the CURRENT raffle fund — fallback only if the raffle was
        //      committed with a null/0 prize (e.g. fund was empty at commit time).
        let prizeSats = 0;
        let prizeSource = '';
        if (amountSats && parseInt(amountSats) > 0) {
            prizeSats = parseInt(amountSats);
            prizeSource = 'admin-override';
        } else if (raffle.prize_amount_sats && raffle.prize_amount_sats > 0) {
            prizeSats = raffle.prize_amount_sats;
            prizeSource = 'stamped-at-commit';
        } else {
            const currentFund = parseInt(db.getSetting('raffle_fund_sats') || '0');
            prizeSats = Math.floor(currentFund / 2);
            prizeSource = 'current-half-fund';
        }
        if (prizeSats <= 0) {
            return res.status(400).json({
                error: 'No prize amount available: raffle has no stamped prize and the raffle fund is empty. Donate to the fund or pass an explicit amountSats.'
            });
        }

        // Don't let an admin override pay MORE than what was reserved at commit
        // time (the advertised prize). Otherwise the override could silently
        // drain a sibling site's funds on the shared LND node.
        if (prizeSource === 'admin-override' && raffle.prize_amount_sats &&
                prizeSats > raffle.prize_amount_sats) {
            return res.status(400).json({
                error: `Override amount (${prizeSats.toLocaleString()} sats) exceeds the reserved prize (${raffle.prize_amount_sats.toLocaleString()} sats). The advertised prize is the cap.`,
                requested: prizeSats,
                reserved: raffle.prize_amount_sats
            });
        }

        // Final defense: never spend more than this site's ledger allows. The
        // lightning service also enforces this, but a clear 400 here is nicer
        // for the admin UI than a 500 from the LND service.
        const siteAvailable = lightning.getSiteAvailableSats();
        // For an already-reserved raffle, the reserved amount is part of the
        // ledger's "available for THIS payout" — but if total over-commitment
        // happened (e.g. multiple pending raffles), we still cap at available.
        if (prizeSats > siteAvailable && prizeSource !== 'stamped-at-commit') {
            return res.status(400).json({
                error: `Cannot pay ${prizeSats.toLocaleString()} sats: site only has ${siteAvailable.toLocaleString()} sats available in its ledger.`,
                requested: prizeSats,
                available: siteAvailable
            });
        }
        console.log(`💰 Pay prize: ${prizeSats} sats (source: ${prizeSource}) for raffle #${id}`);
        
        // Pay via Lightning
        console.log(`⚡ Paying ${prizeSats} sats to ${raffle.lnurl_address} for raffle #${id}...`);
        const paymentResult = await lightning.payLightningAddress(
            raffle.lnurl_address,
            prizeSats,
            `Reviews Raffle winner! Block #${raffle.block_height}`
        );
        
        db.markRafflePaid(parseInt(id), paymentResult.paymentHash);
        console.log(`✅ Payment successful: ${paymentResult.paymentHash}`);
        
        res.json({
            success: true,
            payment: {
                address: raffle.lnurl_address,
                amountSats: prizeSats,
                paymentHash: paymentResult.paymentHash
            }
        });
        
    } catch (error) {
        console.error('Payment error:', error);
        // Record the failure
        try { db.markRafflePaymentFailed(parseInt(req.params.id), error.message); } catch(e) {}
        res.status(500).json({ error: 'Payment failed: ' + error.message });
    }
});

/**
 * GET /admin/lightning/status
 * Check LND node connection status and balance
 */
router.get('/lightning/status', async (req, res) => {
    try {
        const status = await lightning.isConfigured();

        if (!status.configured) {
            return res.json({
                success: true,
                lightning: {
                    configured: false,
                    reason: status.reason
                }
            });
        }

        // Site-scoped view only. The underlying Voltage node is shared with
        // other sites — its node alias, pubkey, and channel balance are NOT
        // appropriate to show to a per-site admin (information disclosure).
        // What the admin actually needs to know:
        //   1. Is the Lightning rail working? (configured + synced)
        //   2. How much can THIS site spend? (siteAvailableSats from ledger)
        //   3. Is auto-pay on?
        const siteAvailableSats = lightning.getSiteAvailableSats();

        res.json({
            success: true,
            lightning: {
                configured: true,
                synced: status.synced,
                siteAvailableSats,
                autoPayEnabled: process.env.AUTO_PAY_ENABLED === 'true'
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to check Lightning status: ' + error.message });
    }
});

/**
 * POST /admin/tickets/:id/ai-check
 * AI-validate a single ticket using its review_text
 */
router.post('/tickets/:id/ai-check', async (req, res) => {
    try {
        const { id } = req.params;
        const ticket = db.getTicketById(parseInt(id));
        
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found' });
        }
        
        if (!ticket.review_text) {
            return res.status(400).json({ error: 'Ticket has no review text to check. Ask the user to paste their review text.' });
        }
        
        // AI validate using the review text
        const validation = await anthropic.validateReview(ticket.review_text, ticket.merchant_name);
        db.validateTicket(parseInt(id), validation.isValid, validation.reason);
        
        res.json({
            success: true,
            validation: {
                isValid: validation.isValid,
                reason: validation.reason,
                confidence: validation.confidence
            }
        });
    } catch (error) {
        console.error('AI check ticket error:', error);
        res.status(500).json({ error: 'Failed to AI-check ticket: ' + error.message });
    }
});

/**
 * GET /admin/tickets/:id/quick-approve
 * One-tap approve from Telegram link (token auth, no admin password needed)
 * Returns a simple HTML response (not JSON) since it's tapped from a phone
 */
router.get('/tickets/:id/quick-approve', tokenAuth, (req, res) => {
    try {
        const { id } = req.params;
        const ticket = db.getTicketById(parseInt(id));
        
        if (!ticket) {
            return res.status(404).send(minimalPage('❌ Not Found', `Ticket #${id} not found.`));
        }
        
        if (ticket.is_valid === 1) {
            const merchant = ticket.merchant_name || 'Unknown merchant';
            return res.send(minimalPage('✅ Already Approved', `Ticket #${id} — ${merchant} was already approved.`));
        }
        
        db.validateTicket(parseInt(id), true, 'Approved via Telegram');

        // Notify other admins of the decision (non-blocking)
        const updatedTicket = db.getTicketById(parseInt(id));
        telegram.notifyTicketDecision(updatedTicket || ticket, true, null, db).catch(() => {});
        
        const merchant = ticket.merchant_name || 'Unknown merchant';
        res.send(minimalPage('✅ Approved!', `Ticket #${id} — ${merchant}`, `<p style="margin-top:20px"><a href="${process.env.BASE_URL || ''}/admin">Go to Admin Dashboard</a></p>`));
    } catch (error) {
        console.error('Quick approve error:', error);
        res.status(500).send(minimalPage('❌ Error', 'Error approving ticket. Please try again.'));
    }
});

/**
 * GET /admin/tickets/:id/quick-reject
 * One-tap reject from Telegram link (token auth, no admin password needed)
 */
router.get('/tickets/:id/quick-reject', tokenAuth, (req, res) => {
    try {
        const { id } = req.params;
        const ticket = db.getTicketById(parseInt(id));
        
        if (!ticket) {
            return res.status(404).send(minimalPage('❌ Not Found', `Ticket #${id} not found.`));
        }
        
        if (ticket.validation_reason && ticket.is_valid === 0 && ticket.validation_reason !== 'null') {
            const merchant = ticket.merchant_name || 'Unknown merchant';
            return res.send(minimalPage('❌ Already Rejected', `Ticket #${id} — ${merchant}: ${ticket.validation_reason}`));
        }
        
        db.validateTicket(parseInt(id), false, 'Rejected via Telegram');

        // Notify other admins of the decision (non-blocking)
        const updatedTicket = db.getTicketById(parseInt(id));
        telegram.notifyTicketDecision(updatedTicket || ticket, false, 'Rejected via Telegram', db).catch(() => {});
        
        const merchant = ticket.merchant_name || 'Unknown merchant';
        res.send(minimalPage('❌ Rejected', `Ticket #${id} — ${merchant}`, `<p style="margin-top:20px"><a href="${process.env.BASE_URL || ''}/admin">Go to Admin Dashboard</a></p>`));
    } catch (error) {
        console.error('Quick reject error:', error);
        res.status(500).send(minimalPage('❌ Error', 'Error rejecting ticket. Please try again.'));
    }
});

/**
 * GET /admin/settings
 * Get all settings
 */
router.get('/settings', (req, res) => {
    try {
        const settings = db.getAllSettings();
        res.json({ success: true, settings });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

/**
 * POST /admin/settings
 * Update settings (accepts key-value pairs)
 */
router.post('/settings', (req, res) => {
    try {
        const { settings } = req.body;
        
        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ error: 'Settings object required' });
        }
        
        const allowedKeys = [
            'review_mode', 'review_link_mode', 'google_api_key',
            'raffle_auto_trigger',
            'contact_telegram', 'contact_email', 'contact_whatsapp'
        ];
        
        for (const [key, value] of Object.entries(settings)) {
            if (!allowedKeys.includes(key)) {
                return res.status(400).json({ error: `Unknown setting: ${key}` });
            }
            db.setSetting(key, value);
        }
        
        res.json({ success: true, message: 'Settings updated', settings: db.getAllSettings() });
    } catch (error) {
        console.error('Settings update error:', error);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

/**
 * POST /admin/tickets/:id/feature
 * Toggle the featured flag on a ticket (for public showcase)
 */
router.post('/tickets/:id/feature', (req, res) => {
    try {
        const { id } = req.params;
        const { featured } = req.body;

        const ticket = db.getTicketById(parseInt(id));
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        if (ticket.is_valid !== 1) {
            return res.status(400).json({ error: 'Only approved tickets can be featured' });
        }

        db.featureTicket(parseInt(id), !!featured);

        res.json({
            success: true,
            message: featured ? `Ticket #${id} is now featured` : `Ticket #${id} is no longer featured`,
            is_featured: !!featured
        });
    } catch (error) {
        console.error('Feature ticket error:', error);
        res.status(500).json({ error: 'Failed to update featured status' });
    }
});

/**
 * GET /admin/telegram/invite
 * Generate a one-time invite PIN and redirect straight to Telegram
 * Used as a direct href — one click opens Telegram with invite pre-loaded
 */
router.get('/telegram/invite', (req, res) => {
    try {
        const pin = Math.random().toString(36).substring(2, 10).toUpperCase();
        const expires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

        const pendingRaw = db.getSetting('telegram_invite_pins') || '{}';
        let pending = {};
        try { pending = JSON.parse(pendingRaw); } catch(e) {}

        // Prune expired pins
        for (const [k, v] of Object.entries(pending)) {
            if (v.expires < Date.now()) delete pending[k];
        }

        pending[pin] = { expires, createdAt: Date.now() };
        db.setSetting('telegram_invite_pins', JSON.stringify(pending));

        // Redirect straight to Telegram deep link
        res.redirect(`https://t.me/CoraTelegramBot?start=${pin}`);
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate invite link' });
    }
});

/**
 * POST /admin/telegram/invite
 * Same as GET but returns JSON (for programmatic use)
 */
router.post('/telegram/invite', (req, res) => {
    try {
        const pin = Math.random().toString(36).substring(2, 10).toUpperCase();
        const expires = Date.now() + 24 * 60 * 60 * 1000;

        const pendingRaw = db.getSetting('telegram_invite_pins') || '{}';
        let pending = {};
        try { pending = JSON.parse(pendingRaw); } catch(e) {}
        for (const [k, v] of Object.entries(pending)) {
            if (v.expires < Date.now()) delete pending[k];
        }
        pending[pin] = { expires, createdAt: Date.now() };
        db.setSetting('telegram_invite_pins', JSON.stringify(pending));

        const inviteLink = `https://t.me/CoraTelegramBot?start=${pin}`;
        res.json({ success: true, inviteLink, pin, expiresAt: new Date(expires).toISOString() });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate invite link' });
    }
});

/**
 * GET /admin/telegram/chats
 * Get all configured admin Telegram chat IDs
 */
router.get('/telegram/chats', (req, res) => {
    try {
        const primary = process.env.TELEGRAM_CHAT_ID || null;
        const extraRaw = db.getSetting('extra_telegram_chats') || '';
        const extra = extraRaw.split(',').map(s => s.trim()).filter(Boolean);

        res.json({
            success: true,
            chats: {
                primary,
                extra,
                all: telegram.getAdminChatIds(db)
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch Telegram chats' });
    }
});

/**
 * POST /admin/telegram/chats
 * Add an extra admin Telegram chat ID
 * Body: { chatId: "123456789" }
 */
router.post('/telegram/chats', (req, res) => {
    try {
        const { chatId } = req.body;
        if (!chatId || !/^\d+$/.test(String(chatId).trim())) {
            return res.status(400).json({ error: 'Valid numeric chat ID required' });
        }

        const extraRaw = db.getSetting('extra_telegram_chats') || '';
        const extra = extraRaw.split(',').map(s => s.trim()).filter(Boolean);

        if (extra.includes(String(chatId).trim())) {
            return res.status(400).json({ error: 'Chat ID already added' });
        }

        if (String(chatId).trim() === process.env.TELEGRAM_CHAT_ID) {
            return res.status(400).json({ error: 'That is already the primary admin chat ID' });
        }

        extra.push(String(chatId).trim());
        db.setSetting('extra_telegram_chats', extra.join(','));

        // Send a confirmation message to the new chat
        telegram.sendMessage(String(chatId).trim(), `✅ You've been added as a Reviews Raffle admin. You'll receive notifications for new reviews, raffle events, and more.`).catch(() => {});

        res.json({
            success: true,
            message: `Chat ID ${chatId} added`,
            extra
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to add chat ID' });
    }
});

/**
 * DELETE /admin/telegram/chats/:chatId
 * Remove an extra admin Telegram chat ID
 */
router.delete('/telegram/chats/:chatId', (req, res) => {
    try {
        const { chatId } = req.params;

        if (String(chatId) === process.env.TELEGRAM_CHAT_ID) {
            return res.status(400).json({ error: 'Cannot remove primary admin chat ID (change TELEGRAM_CHAT_ID env var instead)' });
        }

        const extraRaw = db.getSetting('extra_telegram_chats') || '';
        const extra = extraRaw.split(',').map(s => s.trim()).filter(Boolean).filter(id => id !== String(chatId));
        db.setSetting('extra_telegram_chats', extra.join(','));

        res.json({
            success: true,
            message: `Chat ID ${chatId} removed`,
            extra
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to remove chat ID' });
    }
});

/**
 * GET /admin/raffle/next
 * Get info about the next raffle
 */
router.get('/raffle/next', async (req, res) => {
    try {
        const info = await bitcoin.getRaffleInfo();
        const ticketCount = db.countValidTicketsForBlock(info.nextRaffleBlock);
        const tickets = db.getValidTicketsForBlock(info.nextRaffleBlock);
        
        res.json({
            success: true,
            nextRaffle: {
                ...info,
                ticketCount,
                tickets: tickets.map(t => ({
                    id: t.id,
                    email: t.email.replace(/(.{2}).*(@.*)/, '$1***$2'),
                    merchantName: t.merchant_name,
                    submittedAt: t.submitted_at
                }))
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch next raffle info' });
    }
});

/**
 * GET /api/admin/treasury
 * Returns a unified, time-sorted list of donations (incoming) and payouts
 * (outgoing — raffle prizes). Default JSON; pass ?format=csv for download.
 *
 * Query params:
 *   format=csv|json   (default json)
 *   direction=in|out  (optional filter)
 *   limit=N           (default 500, max 5000)
 */
router.get('/treasury', (req, res) => {
    try {
        const format = (req.query.format || 'json').toLowerCase();
        const directionFilter = req.query.direction;
        const limit = Math.min(parseInt(req.query.limit) || 500, 5000);

        // ── Donations: every row from deposit_addresses with received_at set ──
        // Also include unfilled invoices/addresses if you want a full picture; we
        // only return CONFIRMED received donations here for the financial log.
        const allDeposits = db.getAllDepositAddresses() || [];
        const donations = allDeposits
            .filter(d => d.received_at && d.amount_received_sats > 0)
            .map(d => ({
                timestamp: d.received_at,
                direction: 'in',
                type: d.type === 'lightning' ? 'Lightning donation' : 'On-chain donation',
                channel: d.type, // 'lightning' or 'onchain'
                amountSats: d.amount_received_sats,
                address: d.type === 'onchain' ? d.address : null,
                invoice: d.type === 'lightning' ? d.invoice : null,
                paymentHash: d.payment_hash || null,
                memo: d.memo || null,
                status: 'received',
                refId: 'deposit#' + d.id
            }));

        // ── Payouts: raffles that have been paid ──
        const allRaffles = db.getAllRaffles() || [];
        const payouts = allRaffles
            .filter(r => r.paid_at && r.prize_amount_sats > 0)
            .map(r => ({
                timestamp: r.paid_at,
                direction: 'out',
                type: 'Raffle prize payout',
                channel: 'lightning',
                amountSats: r.prize_amount_sats,
                address: r.lnurl_address || null,    // winner LN address
                invoice: null,
                paymentHash: r.payment_hash || r.claim_payment_hash || null,
                memo: `Block #${r.block_height} winner (raffle #${r.id})`,
                status: r.payment_status || 'paid',
                refId: 'raffle#' + r.id
            }));

        // ── Failed/in-flight payouts (committed raffles awaiting pay) ──
        const pendingPayouts = allRaffles
            .filter(r => !r.paid_at && r.prize_amount_sats > 0)
            .map(r => ({
                timestamp: r.created_at,
                direction: 'out',
                type: 'Raffle prize (pending)',
                channel: 'lightning',
                amountSats: r.prize_amount_sats,
                address: r.lnurl_address || null,
                invoice: null,
                paymentHash: null,
                memo: `Block #${r.block_height} winner (raffle #${r.id})${r.payment_error ? ' — error: ' + r.payment_error : ''}`,
                status: r.payment_error ? 'failed' : 'pending',
                refId: 'raffle#' + r.id
            }));

        let entries = [...donations, ...payouts, ...pendingPayouts];

        if (directionFilter === 'in' || directionFilter === 'out') {
            entries = entries.filter(e => e.direction === directionFilter);
        }

        // Newest first
        entries.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        entries = entries.slice(0, limit);

        // Summary totals (computed across UNFILTERED entries — admins want totals
        // even if they're viewing a filtered slice)
        const totalIn = donations.reduce((s, e) => s + (e.amountSats || 0), 0);
        const totalOut = payouts.reduce((s, e) => s + (e.amountSats || 0), 0);
        // Reserved = pending + failed raffle payouts. These are sats already
        // subtracted from the fund at commit time but not yet sent (so they
        // explain the gap between Net and Current fund).
        const reserved = pendingPayouts.reduce((s, e) => s + (e.amountSats || 0), 0);
        const reservedPending = pendingPayouts.filter(e => e.status === 'pending').reduce((s, e) => s + (e.amountSats || 0), 0);
        const reservedFailed = pendingPayouts.filter(e => e.status === 'failed').reduce((s, e) => s + (e.amountSats || 0), 0);
        const fund = parseInt(db.getSetting('raffle_fund_sats') || '0');
        const summary = {
            totalDonations: donations.length,
            totalDonatedSats: totalIn,
            totalPayouts: payouts.length,
            totalPaidOutSats: totalOut,
            reservedSats: reserved,
            reservedPendingSats: reservedPending,
            reservedFailedSats: reservedFailed,
            reservedCount: pendingPayouts.length,
            netSats: totalIn - totalOut - reserved,  // Now matches Current fund
            currentFundSats: fund,
            // Drift between expected (donated − paid − reserved) and actual fund.
            // Should be ~0 if the ledger is consistent. Non-zero indicates a
            // manual seed (set via /api/raffle-fund/set or /add) or another
            // mutation that bypassed the deposit_addresses table.
            unaccountedSats: fund - (totalIn - totalOut - reserved)
        };

        if (format === 'csv') {
            // Compact CSV with quoted fields where needed
            const escape = (v) => {
                if (v == null) return '';
                const s = String(v);
                return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const header = ['timestamp', 'direction', 'type', 'channel', 'amount_sats', 'address', 'invoice', 'payment_hash', 'memo', 'status', 'ref'];
            const lines = [header.join(',')];
            for (const e of entries) {
                lines.push([
                    e.timestamp,
                    e.direction,
                    e.type,
                    e.channel,
                    e.amountSats,
                    e.address || '',
                    e.invoice || '',
                    e.paymentHash || '',
                    e.memo || '',
                    e.status,
                    e.refId
                ].map(escape).join(','));
            }
            const filename = `reviews-raffle-treasury-${new Date().toISOString().slice(0,10)}.csv`;
            res.set('Content-Type', 'text/csv; charset=utf-8');
            res.set('Content-Disposition', `attachment; filename="${filename}"`);
            return res.send(lines.join('\n') + '\n');
        }

        res.json({ success: true, summary, entries });
    } catch (error) {
        console.error('Treasury endpoint error:', error);
        res.status(500).json({ success: false, error: 'Failed to load treasury log: ' + error.message });
    }
});

module.exports = router;
