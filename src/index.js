/**
 * Bitcoin Review Raffle - Main Application
 * Build: 2026-02-22a
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');

// Import services
const db = require('./services/database');
const email = require('./services/email');
const anthropic = require('./services/anthropic');
const bitcoin = require('./services/bitcoin');
const lightning = require('./services/lightning');
const telegram = require('./services/telegram');

// Import routes
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const pageRoutes = require('./routes/pages');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Rate limiting for API endpoints
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: { error: 'Too many requests, please try again later.' }
});

const registrationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // Limit each IP to 10 registrations per hour
    message: { error: 'Too many registration attempts, please try again later.' }
});

// Apply rate limiting
app.use('/api', apiLimiter);
app.use('/api/register', registrationLimiter);

// Routes
app.use('/api', apiRoutes);
app.use('/api/admin', adminRoutes);
app.use('/', pageRoutes);

// Telegram webhook — handles bot messages and invite link flow
app.post('/telegram/webhook', express.json(), async (req, res) => {
    res.sendStatus(200); // Always ack immediately
    try {
        const update = req.body;

        // Handle inline button callbacks (e.g. unsubscribe button)
        if (update.callback_query) {
            const cb = update.callback_query;
            const cbChatId = String(cb.message.chat.id);
            const data = cb.data || '';
            const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

            if (data.startsWith('unsub_')) {
                const targetId = data.replace('unsub_', '');
                if (targetId === cbChatId) {
                    // Remove from extra chats
                    const extraRaw = db.getSetting('extra_telegram_chats') || '';
                    const extra = extraRaw.split(',').map(s => s.trim()).filter(Boolean).filter(id => id !== cbChatId);
                    db.setSetting('extra_telegram_chats', extra.join(','));

                    // Answer the callback (removes loading spinner)
                    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ callback_query_id: cb.id, text: 'Removed ✓' })
                    });

                    // Edit the original message to confirm
                    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: cbChatId,
                            message_id: cb.message.message_id,
                            text: `🔕 *Done* — you've been removed from Bitcoin Review admin notifications.\n\nYou can be re-added by the admin at any time.`,
                            parse_mode: 'Markdown'
                        })
                    });
                }
            }
            return;
        }

        const msg = update.message || update.edited_message;
        if (!msg) return;
        const chatId = String(msg.chat.id);
        const text = (msg.text || '').trim();
        const firstName = msg.from?.first_name || '';

        // Handle /start command (may include invite PIN)
        if (text.startsWith('/start')) {
            const pin = text.split(' ')[1] || '';

            if (pin) {
                // Validate invite PIN against stored pending invites
                const pendingRaw = db.getSetting('telegram_invite_pins') || '{}';
                let pending = {};
                try { pending = JSON.parse(pendingRaw); } catch(e) {}

                if (pending[pin] && pending[pin].expires > Date.now()) {
                    // Valid PIN — check if already registered
                    const extraRaw = db.getSetting('extra_telegram_chats') || '';
                    const extra = extraRaw.split(',').map(s => s.trim()).filter(Boolean);
                    const alreadyAdmin = extra.includes(chatId) || chatId === process.env.TELEGRAM_CHAT_ID;

                    if (alreadyAdmin) {
                        // Already registered — tell them and offer unsubscribe button
                        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
                        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                chat_id: chatId,
                                text: `ℹ️ *You're already signed up for admin alerts${firstName ? ', ' + firstName : ''}!*\n\nYou currently receive Bitcoin Review notifications.\n\nWould you like to stop receiving them?`,
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [[
                                        { text: '🔕 Stop notifications', callback_data: `unsub_${chatId}` }
                                    ]]
                                }
                            })
                        });
                        return;
                    }

                    extra.push(chatId);
                    db.setSetting('extra_telegram_chats', extra.join(','));

                    // Remove used PIN
                    delete pending[pin];
                    db.setSetting('telegram_invite_pins', JSON.stringify(pending));

                    await telegram.sendMessage(chatId,
                        `✅ <b>Welcome${firstName ? ', ' + firstName : ''}!</b>\n\nYou've been added as a Bitcoin Review admin.\n\nYou'll now receive notifications for new reviews and raffle events.\n\nYour chat ID: <code>${chatId}</code>`
                    );
                } else {
                    // Invalid or expired PIN — just reply with chat ID
                    await telegram.sendMessage(chatId,
                        `👋 Hi${firstName ? ' ' + firstName : ''}!\n\nThis invite link is invalid or has expired.\n\nAsk the admin to generate a new one.`, 'HTML'
                    );
                }
            } else {
                // Plain /start with no PIN — reply with chat ID
                await telegram.sendMessage(chatId,
                    `👋 Hi${firstName ? ' ' + firstName : ''}!\n\nYour Telegram chat ID is:\n<code>${chatId}</code>\n\nShare this with the Bitcoin Review admin to receive notifications.`
                );
            }
        } else {
            // Any other message — reply with chat ID
            await telegram.sendMessage(chatId,
                `👋 Hi${firstName ? ' ' + firstName : ''}!\n\nYour Telegram chat ID is:\n<code>${chatId}</code>\n\nShare this with the Bitcoin Review admin to receive notifications.`
            );
        }
    } catch (e) {
        console.error('Telegram webhook error:', e.message);
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    
    if (req.path.startsWith('/api')) {
        return res.status(500).json({ error: 'Internal server error' });
    }
    
    res.status(500).render('error', {
        title: 'Error - Bitcoin Review Raffle',
        error: 'Something went wrong. Please try again.'
    });
});

// 404 handler
app.use((req, res) => {
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ error: 'Not found' });
    }
    
    res.status(404).render('404', {
        title: 'Not Found - Bitcoin Review Raffle'
    });
});

// Initialize services and start server
async function startServer() {
    console.log('🚀 Starting Bitcoin Review Raffle...');
    
    await db.initializeDatabase();
    email.initializeEmail();
    anthropic.initializeAnthropic();
    
    // Pre-warm the raffle info cache BEFORE accepting requests
    try {
        await bitcoin.warmCache();
        const info = await bitcoin.getRaffleInfo();
        console.log(`⛏️  Block height: ${info.currentHeight} | Next raffle: ${info.nextRaffleBlock}`);
    } catch (err) {
        console.warn('⚠️  Failed to pre-warm raffle cache:', err.message);
    }
    
    // Pre-warm deposit address cache + start real-time LND subscriptions
    try {
        await lightning.warmDepositCache();
    } catch (err) {
        console.warn('⚠️  Failed to warm deposit cache:', err.message);
    }
    
    // Fast poll for deposits every 60s (fallback for subscription streams)
    // Lightning subscription handles most cases instantly, but on-chain
    // transactions need polling as a reliable fallback
    setInterval(async () => {
        try {
            await lightning.checkForDeposits();
        } catch (err) {
            console.warn('Payment poll error:', err.message);
        }
    }, 60 * 1000);

    // Raffle events + Telegram delivery every 5 minutes
    setInterval(async () => {
        // Deliver any held Telegram notifications (quiet hours ended)
        try {
            await telegram.deliverPendingNotifications(db);
        } catch (err) {
            console.warn('Telegram delivery check error:', err.message);
        }

        // Raffle watcher: check for 144-block warning + block mined event
        try {
            await checkRaffleEvents();
        } catch (err) {
            console.warn('Raffle watcher error:', err.message);
        }
    }, 5 * 60 * 1000);

    // Run raffle watcher once on startup too (catches up if server was down)
    setTimeout(async () => {
        try { await checkRaffleEvents(); } catch (e) { console.warn('Startup raffle check error:', e.message); }
    }, 15 * 1000); // 15s after startup (after cache is warm)
    
    app.listen(PORT, () => {
        console.log(`✅ Server running on http://localhost:${PORT}`);
        console.log(`📊 Admin dashboard: http://localhost:${PORT}/admin`);
    });
}

/**
 * Raffle watcher — runs every 5 minutes.
 * Checks for two events:
 *   1. 144-block warning (fires once per raffle cycle)
 *   2. Raffle block mined (fires once; auto-runs raffle if enabled)
 */
async function checkRaffleEvents() {
    let info;
    try {
        info = await bitcoin.getRaffleInfo();
    } catch (e) {
        console.warn('Raffle watcher: could not fetch block info:', e.message);
        return;
    }

    const { nextRaffleBlock, blocksUntilNext, currentHeight } = info;
    const approvedTickets = db.countValidTicketsForBlock(nextRaffleBlock);

    // ── 1. 144-block warning (send once per raffle cycle) ──────────────────
    const warningAlreadySentBlock = parseInt(db.getSetting('raffle_warning_sent_block') || '0', 10);
    if (
        blocksUntilNext <= 144 &&
        blocksUntilNext > 0 &&
        warningAlreadySentBlock !== nextRaffleBlock
    ) {
        console.log(`⏰ Raffle warning: ~${blocksUntilNext} blocks until block #${nextRaffleBlock}`);
        db.setSetting('raffle_warning_sent_block', String(nextRaffleBlock));
        await telegram.notifyRaffleWarning(nextRaffleBlock, approvedTickets, db);
    }

    // ── 2. Raffle block mined — ALWAYS commit result (transparent & deterministic) ─
    const blockAlreadyNotified = parseInt(db.getSetting('raffle_block_notified') || '0', 10);
    const raffleBlockMined = currentHeight >= nextRaffleBlock;
    const raffleAlreadyRun = !!db.findRaffleByBlock(nextRaffleBlock);

    if (raffleBlockMined && blockAlreadyNotified !== nextRaffleBlock && !raffleAlreadyRun) {
        db.setSetting('raffle_block_notified', String(nextRaffleBlock));

        // Raffle commitment is ALWAYS automatic — only payment is manual vs auto
        const autoPay = db.getSetting('raffle_auto_trigger') === 'true';

        // Always commit the raffle result
        await commitRaffleResult(nextRaffleBlock, autoPay);
    }
}

/**
 * Commit raffle result for a given block height.
 * ALWAYS called when the raffle block is mined — the result is deterministic.
 * The `autoPay` flag controls whether payment is also sent automatically.
 */
async function commitRaffleResult(blockHeight, autoPay) {
    try {
        const blockHash = await bitcoin.getBlockHash(blockHeight);
        const tickets = db.getValidTicketsForBlock(blockHeight);

        if (tickets.length === 0) {
            console.log(`⚠️ Raffle block #${blockHeight}: no valid tickets — raffle skipped.`);
            const chatIds = telegram.getAdminChatIds(db);
            for (const chatId of chatIds) {
                await telegram.sendMessage(chatId, `⚠️ <b>Raffle block #${blockHeight} mined</b>\n\nNo approved tickets in the pool — raffle skipped.`);
            }
            return;
        }

        const winnerIndex = bitcoin.selectWinnerIndex(blockHash, tickets.length);
        const winningTicket = tickets[winnerIndex];
        
        // Prize = 50% of the raffle fund (the other 50% carries over to the next raffle)
        const currentFund = parseInt(db.getSetting('raffle_fund_sats') || '0');
        const prizeSats = Math.floor(currentFund / 2);
        
        // Deduct prize from fund
        if (prizeSats > 0) {
            db.setSetting('raffle_fund_sats', String(currentFund - prizeSats));
            console.log(`🎯 Raffle fund: ${currentFund} - ${prizeSats} (prize) = ${currentFund - prizeSats} sats remaining`);
        }

        const raffle = db.createRaffle(
            blockHeight, blockHash, tickets.length, winnerIndex, winningTicket.id, prizeSats || null
        );

        console.log(`🎰 Raffle committed! Block #${blockHeight}, hash: ${blockHash.substring(0, 16)}..., winner index: ${winnerIndex}/${tickets.length}, ticket #${winningTicket.id}`);

        // Notify via Telegram (always)
        await telegram.notifyRaffleResult(
            { block_height: blockHeight, total_tickets: tickets.length, prize_amount_sats: prizeSats },
            winningTicket,
            db
        );

        // Send winner email (always)
        email.sendWinnerEmail(
            winningTicket.email, prizeSats, winningTicket.lnurl_address, blockHeight
        ).catch(err => console.error('Winner email error:', err));

        // Auto-pay only if enabled (raffle_auto_trigger=true AND AUTO_PAY_ENABLED=true)
        if (autoPay && process.env.AUTO_PAY_ENABLED === 'true' && winningTicket.lnurl_address && prizeSats > 0) {
            try {
                console.log(`⚡ Auto-paying ${prizeSats} sats to ${winningTicket.lnurl_address}...`);
                const paymentResult = await lightning.payLightningAddress(
                    winningTicket.lnurl_address, prizeSats,
                    `Bitcoin Review Raffle winner! Block #${blockHeight}`
                );
                db.markRafflePaid(raffle.id, paymentResult.paymentHash);
                console.log(`✅ Auto-payment: ${paymentResult.paymentHash}`);
            } catch (payErr) {
                console.error('⚠️ Auto-payment failed:', payErr.message);
                db.markRafflePaymentFailed(raffle.id, payErr.message);
            }
        } else if (!autoPay) {
            console.log(`💤 Auto-pay disabled — admin must pay manually via dashboard.`);
        }
    } catch (err) {
        console.error('Raffle commit error:', err.message);
        // Notify admin of the failure
        try {
            const chatIds = telegram.getAdminChatIds(db);
            for (const chatId of chatIds) {
                await telegram.sendMessage(chatId, `❌ <b>Raffle commit FAILED</b> for block #${blockHeight}\n\nError: ${err.message}\n\nPlease run manually: ${process.env.BASE_URL}/admin`);
            }
        } catch (e) {}
    }
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

module.exports = app;
