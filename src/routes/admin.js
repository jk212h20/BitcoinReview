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

/**
 * Simple password authentication middleware
 */
function adminAuth(req, res, next) {
    const password = req.query.password || req.body.password || req.headers['x-admin-password'];
    
    if (!process.env.ADMIN_PASSWORD) {
        return res.status(500).json({ error: 'Admin password not configured' });
    }
    
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    next();
}

/**
 * Token authentication middleware for Telegram one-tap links
 * Uses TELEGRAM_APPROVE_TOKEN env var (separate from admin password)
 */
function tokenAuth(req, res, next) {
    const token = req.query.token || req.body.token || req.headers['x-approve-token'];
    const approveToken = process.env.TELEGRAM_APPROVE_TOKEN;
    
    if (!approveToken) {
        return res.status(500).send('<h2>❌ TELEGRAM_APPROVE_TOKEN not configured</h2>');
    }
    
    if (token !== approveToken) {
        return res.status(401).send('<h2>❌ Invalid token</h2>');
    }
    
    next();
}

// Apply password auth to all admin routes EXCEPT quick-approve/reject (which use token auth)
router.use((req, res, next) => {
    // Skip adminAuth for quick-approve and quick-reject (they use tokenAuth instead)
    if (req.path.match(/^\/tickets\/\d+\/quick-(approve|reject)$/)) {
        return next();
    }
    return adminAuth(req, res, next);
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
        
        // Auto-pay via Lightning if enabled and winner has a Lightning Address
        let paymentResult = null;
        const autoPayEnabled = process.env.AUTO_PAY_ENABLED === 'true';
        const prizeSats = prizeAmountSats || parseInt(process.env.DEFAULT_PRIZE_SATS) || 0;
        
        // Notify admin via Telegram
        telegram.notifyRaffleResult(
            { block_height: blockHeight, total_tickets: tickets.length, prize_amount_sats: prizeSats },
            winningTicket,
            db
        ).catch(err => console.error('Telegram raffle notify error:', err));
        
        // Send winner email
        email.sendWinnerEmail(
            winningTicket.email,
            prizeAmountSats,
            winningTicket.lnurl_address,
            blockHeight
        ).catch(err => {
            console.error('Failed to send winner email:', err);
        });
        
        if (autoPayEnabled && winningTicket.lnurl_address && prizeSats > 0) {
            try {
                console.log(`⚡ Auto-paying ${prizeSats} sats to ${winningTicket.lnurl_address}...`);
                paymentResult = await lightning.payLightningAddress(
                    winningTicket.lnurl_address,
                    prizeSats,
                    `Bitcoin Review Raffle winner! Block #${blockHeight}`
                );
                db.markRafflePaid(raffle.id, paymentResult.paymentHash);
                console.log(`✅ Auto-payment successful: ${paymentResult.paymentHash}`);
            } catch (payErr) {
                console.error('⚠️ Auto-payment failed:', payErr.message);
                db.markRafflePaymentFailed(raffle.id, payErr.message);
                paymentResult = { error: payErr.message };
            }
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
                payment: paymentResult
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
        
        const prizeSats = amountSats || raffle.prize_amount_sats || parseInt(process.env.DEFAULT_PRIZE_SATS) || 0;
        if (prizeSats <= 0) {
            return res.status(400).json({ error: 'No prize amount specified' });
        }
        
        // Pay via Lightning
        console.log(`⚡ Paying ${prizeSats} sats to ${raffle.lnurl_address} for raffle #${id}...`);
        const paymentResult = await lightning.payLightningAddress(
            raffle.lnurl_address,
            prizeSats,
            `Bitcoin Review Raffle winner! Block #${raffle.block_height}`
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
        
        // Get balances
        let channelBalance = null;
        try {
            const bal = await lightning.getChannelBalance();
            channelBalance = {
                localBalance: parseInt(bal.local_balance?.sat || bal.balance || 0),
                remoteBalance: parseInt(bal.remote_balance?.sat || 0)
            };
        } catch (e) {
            channelBalance = { error: e.message };
        }
        
        res.json({
            success: true,
            lightning: {
                configured: true,
                alias: status.alias,
                pubkey: status.pubkey,
                synced: status.synced,
                blockHeight: status.blockHeight,
                channelBalance,
                autoPayEnabled: process.env.AUTO_PAY_ENABLED === 'true',
                defaultPrizeSats: parseInt(process.env.DEFAULT_PRIZE_SATS) || 0
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
            return res.status(404).send('<h2>❌ Ticket not found</h2>');
        }
        
        if (ticket.is_valid === 1) {
            return res.send(`<h2>✅ Already approved</h2><p>Ticket #${id} was already approved.</p>`);
        }
        
        db.validateTicket(parseInt(id), true, 'Approved via Telegram');

        // Notify other admins of the decision (non-blocking)
        const updatedTicket = db.getTicketById(parseInt(id));
        telegram.notifyTicketDecision(updatedTicket || ticket, true, null, db).catch(() => {});
        
        const merchant = ticket.merchant_name || 'Unknown merchant';
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
                body { font-family: sans-serif; text-align: center; padding: 40px 20px; }
                h1 { color: #22c55e; } p { color: #666; }
            </style></head>
            <body>
                <h1>✅ Approved!</h1>
                <p>Ticket #${id} — ${merchant}</p>
                <p style="margin-top:20px;"><a href="${process.env.BASE_URL || ''}/admin">Go to Admin Dashboard</a></p>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('Quick approve error:', error);
        res.status(500).send('<h2>❌ Error approving ticket</h2>');
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
            return res.status(404).send('<h2>❌ Ticket not found</h2>');
        }
        
        if (ticket.validation_reason && ticket.is_valid === 0 && ticket.validation_reason !== 'null') {
            return res.send(`<h2>❌ Already rejected</h2><p>Ticket #${id} was already rejected: ${ticket.validation_reason}</p>`);
        }
        
        db.validateTicket(parseInt(id), false, 'Rejected via Telegram');

        // Notify other admins of the decision (non-blocking)
        const updatedTicket = db.getTicketById(parseInt(id));
        telegram.notifyTicketDecision(updatedTicket || ticket, false, 'Rejected via Telegram', db).catch(() => {});
        
        const merchant = ticket.merchant_name || 'Unknown merchant';
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
                body { font-family: sans-serif; text-align: center; padding: 40px 20px; }
                h1 { color: #ef4444; } p { color: #666; }
            </style></head>
            <body>
                <h1>❌ Rejected</h1>
                <p>Ticket #${id} — ${merchant}</p>
                <p style="margin-top:20px;"><a href="${process.env.BASE_URL || ''}/admin">Go to Admin Dashboard</a></p>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('Quick reject error:', error);
        res.status(500).send('<h2>❌ Error rejecting ticket</h2>');
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
            'review_mode', 'google_api_key',
            'raffle_auto_trigger'
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
        telegram.sendMessage(String(chatId).trim(), `✅ You've been added as a Bitcoin Review Raffle admin. You'll receive notifications for new reviews, raffle events, and more.`).catch(() => {});

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

module.exports = router;
