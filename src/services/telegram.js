/**
 * Telegram notification service
 * Sends admin notifications via the CoraTelegramBot
 */

const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || 'https://web-production-3a9f6.up.railway.app';

// Roatan timezone (UTC-6, no DST)
const ADMIN_TIMEZONE = process.env.ADMIN_TIMEZONE || 'America/Tegucigalpa';
const QUIET_HOUR_START = 18; // 6pm — no notifications after this hour
const QUIET_HOUR_END = 9;    // 9am — notifications resume at this hour

/**
 * Check if it's currently within quiet hours (6pm–9am Roatan time)
 * Returns true if we should suppress the notification until 9am
 */
function isQuietHours() {
    try {
        const now = new Date();
        // Get current hour in admin timezone
        const hour = parseInt(
            new Intl.DateTimeFormat('en-US', {
                timeZone: ADMIN_TIMEZONE,
                hour: 'numeric',
                hour12: false
            }).format(now),
            10
        );
        // Quiet if hour >= 18 (6pm) OR hour < 9 (before 9am)
        return hour >= QUIET_HOUR_START || hour < QUIET_HOUR_END;
    } catch (e) {
        console.warn('Quiet hours check failed:', e.message);
        return false; // Fail open — send the message
    }
}

/**
 * Send a Telegram message to a chat ID
 * @param {string} chatId - Telegram chat ID
 * @param {string} text - Message text (supports Markdown)
 * @returns {Promise<boolean>}
 */
async function sendMessage(chatId, text) {
    if (!BOT_TOKEN) {
        console.warn('⚠️  Telegram: TELEGRAM_BOT_TOKEN not configured, skipping notification');
        return false;
    }
    if (!chatId) {
        console.warn('⚠️  Telegram: no chat ID provided, skipping notification');
        return false;
    }

    const payload = JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
    });

    return new Promise((resolve) => {
        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${BOT_TOKEN}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (!parsed.ok) {
                        console.error('Telegram API error:', parsed.description);
                        resolve(false);
                    } else {
                        resolve(true);
                    }
                } catch (e) {
                    console.error('Telegram response parse error:', e.message);
                    resolve(false);
                }
            });
        });

        req.on('error', (e) => {
            console.error('Telegram request error:', e.message);
            resolve(false);
        });

        req.setTimeout(10000, () => {
            console.warn('Telegram request timed out');
            req.destroy();
            resolve(false);
        });

        req.write(payload);
        req.end();
    });
}

/**
 * Get all admin chat IDs to notify.
 * Returns env var primary chat ID + any extra IDs stored in DB settings.
 * Pass the db module to include DB-stored extras.
 * @param {Object} [dbModule] - optional database module (to read extra_telegram_chats setting)
 */
function getAdminChatIds(dbModule) {
    const ids = [];

    if (process.env.TELEGRAM_CHAT_ID) {
        ids.push(process.env.TELEGRAM_CHAT_ID);
    }

    // Also pull any extra chat IDs stored in DB settings
    if (dbModule) {
        try {
            const extra = dbModule.getSetting('extra_telegram_chats');
            if (extra) {
                extra.split(',').map(s => s.trim()).filter(Boolean).forEach(id => {
                    if (!ids.includes(id)) ids.push(id);
                });
            }
        } catch (e) {
            // DB might not be ready yet — silently ignore
        }
    }

    return ids;
}

/**
 * Notify all admins about a new review submission.
 * During quiet hours (6pm–9am), reviews are queued and a single summary
 * is sent at 9am instead of individual notifications.
 * @param {Object} ticket - ticket record
 * @param {Object} user - user record (may be null for anonymous)
 * @param {Object} [dbModule] - database module (to get extra admin chat IDs)
 */
async function notifyNewReview(ticket, user, dbModule) {
    const chatIds = getAdminChatIds(dbModule);
    if (chatIds.length === 0) {
        console.warn('⚠️  Telegram: no admin chat IDs configured');
        return;
    }

    // During quiet hours, just increment a counter — summary sent at 9am
    if (isQuietHours()) {
        if (dbModule) {
            try {
                const count = parseInt(dbModule.getSetting('quiet_hours_review_count') || '0', 10);
                dbModule.setSetting('quiet_hours_review_count', String(count + 1));
                console.log(`📵 Review notification queued (quiet hours). ${count + 1} pending.`);
            } catch (e) {}
        }
        return;
    }

    const approveToken = process.env.TELEGRAM_APPROVE_TOKEN;
    const ticketId = ticket.id;
    const merchantDisplay = ticket.merchant_name ? `*${escapeMarkdown(ticket.merchant_name)}*` : '_Unknown merchant_';
    const submitterDisplay = user && user.email
        ? escapeMarkdown(maskEmail(user.email))
        : (user && user.lnurl_address ? `⚡ ${escapeMarkdown(user.lnurl_address)}` : '_Anonymous_');

    const triedBtc = ticket.tried_bitcoin === 1 ? '✅ Yes' : (ticket.tried_bitcoin === 0 ? '❌ No' : '❓ N/A');
    const acceptedBtc = ticket.merchant_accepted === 1 ? '✅ Yes' : (ticket.merchant_accepted === 0 ? '❌ No' : '❓ N/A');

    let message = `🔔 *New Review Submitted*\n\n`;
    message += `Merchant: ${merchantDisplay}\n`;
    message += `Tried Bitcoin: ${triedBtc}\n`;
    message += `Merchant Accepted: ${acceptedBtc}\n`;
    message += `Submitted by: ${submitterDisplay}\n`;
    message += `Review Link: [Open Review](${ticket.review_link})\n`;

    if (ticket.review_text) {
        const preview = ticket.review_text.length > 200
            ? ticket.review_text.substring(0, 200) + '…'
            : ticket.review_text;
        message += `\n📝 _"${escapeMarkdown(preview)}"_\n`;
    }

    message += `\n`;
    message += `[👁 View in Admin](${BASE_URL}/admin/review/${ticketId}?password=${approveToken})\n`;

    if (approveToken) {
        message += `[✅ Approve](${BASE_URL}/api/admin/tickets/${ticketId}/quick-approve?token=${approveToken})\n`;
        message += `[❌ Reject](${BASE_URL}/api/admin/tickets/${ticketId}/quick-reject?token=${approveToken})`;
    } else {
        message += `\n⚠️ Set TELEGRAM_APPROVE_TOKEN env var for one-tap approve/reject links`;
    }

    for (const chatId of chatIds) {
        try {
            await sendMessage(chatId, message);
        } catch (e) {
            console.error(`Failed to notify chat ${chatId}:`, e.message);
        }
    }
}

/**
 * Notify all admins about a raffle result.
 * Respects quiet hours — held until 9am if fired during 6pm–9am.
 * @param {Object} raffle - raffle record
 * @param {Object} winner - winning ticket + user info
 * @param {Object} [dbModule] - database module
 */
async function notifyRaffleResult(raffle, winner, dbModule) {
    const chatIds = getAdminChatIds(dbModule);
    if (chatIds.length === 0) return;

    let message = `🎰 *Raffle Complete!*\n\n`;
    message += `Block: #${raffle.block_height.toLocaleString()}\n`;
    message += `Total Tickets: ${raffle.total_tickets}\n`;
    message += `Winner: ${winner.email ? escapeMarkdown(maskEmail(winner.email)) : (winner.lnurl_address ? `⚡ ${escapeMarkdown(winner.lnurl_address)}` : '_Anonymous_')}\n`;
    if (raffle.prize_amount_sats) {
        message += `Prize: ${raffle.prize_amount_sats.toLocaleString()} sats\n`;
    }
    if (winner.lnurl_address) {
        message += `Lightning Address: \`${escapeMarkdown(winner.lnurl_address)}\`\n`;
    }
    message += `\nManage at: ${BASE_URL}/admin`;

    if (isQuietHours()) {
        console.log('📵 Raffle result notification suppressed (quiet hours) — will send at 9am');
        // Store the pending message in DB for the watcher to send at 9am
        if (dbModule) {
            try {
                dbModule.setSetting('pending_telegram_message', JSON.stringify({ chatIds, message, type: 'raffle_result' }));
            } catch (e) {}
        }
        return;
    }

    for (const chatId of chatIds) {
        try {
            await sendMessage(chatId, message);
        } catch (e) {
            console.error(`Failed to notify chat ${chatId}:`, e.message);
        }
    }
}

/**
 * Notify admins about approaching raffle (144 blocks warning).
 * Always sent regardless of auto/manual mode. Respects quiet hours.
 * @param {number} raffleBlock - the upcoming raffle block
 * @param {number} approvedTickets - number of approved tickets in the pool
 * @param {Object} [dbModule] - database module
 */
async function notifyRaffleWarning(raffleBlock, approvedTickets, dbModule) {
    const chatIds = getAdminChatIds(dbModule);
    if (chatIds.length === 0) return;

    const autoEnabled = dbModule ? dbModule.getSetting('raffle_auto_trigger') === 'true' : false;
    const modeText = autoEnabled ? '🤖 Auto-trigger is ON' : '👋 Manual trigger required';

    let message = `⏰ *Raffle in ~24 hours!*\n\n`;
    message += `Block #${raffleBlock.toLocaleString()} is ~144 blocks away.\n`;
    message += `Approved tickets in pool: *${approvedTickets}*\n`;
    message += `${modeText}\n\n`;
    if (!autoEnabled) {
        message += `When the block is mined, go to:\n${BASE_URL}/admin`;
    }

    if (isQuietHours()) {
        console.log('📵 Raffle warning suppressed (quiet hours) — storing for 9am delivery');
        if (dbModule) {
            try {
                // Only store if nothing already pending (avoid clobbering raffle result)
                const existing = dbModule.getSetting('pending_telegram_message');
                if (!existing) {
                    dbModule.setSetting('pending_telegram_message', JSON.stringify({ chatIds, message, type: 'raffle_warning' }));
                }
            } catch (e) {}
        }
        return;
    }

    for (const chatId of chatIds) {
        try {
            await sendMessage(chatId, message);
        } catch (e) {
            console.error(`Failed to send raffle warning to ${chatId}:`, e.message);
        }
    }
}

/**
 * Notify admins that the raffle block has been mined.
 * Always sent regardless of auto/manual mode. Respects quiet hours.
 * @param {number} raffleBlock - the raffle block that was mined
 * @param {number} approvedTickets - number of approved tickets in the pool
 * @param {boolean} autoTriggered - whether the raffle was auto-run
 * @param {Object} [dbModule] - database module
 */
async function notifyRaffleBlockMined(raffleBlock, approvedTickets, autoTriggered, dbModule) {
    const chatIds = getAdminChatIds(dbModule);
    if (chatIds.length === 0) return;

    let message;
    if (autoTriggered) {
        message = `🎲 *Raffle block #${raffleBlock.toLocaleString()} mined!*\n`;
        message += `Running raffle automatically with ${approvedTickets} approved tickets...\n`;
        message += `(Winner announcement coming shortly)`;
    } else {
        message = `🎲 *Raffle block #${raffleBlock.toLocaleString()} has been mined!*\n\n`;
        message += `${approvedTickets} approved tickets in the pool.\n`;
        message += `👉 [Run the raffle now](${BASE_URL}/admin)`;
    }

    if (isQuietHours()) {
        console.log('📵 Raffle block-mined notification suppressed (quiet hours) — storing for 9am delivery');
        if (dbModule) {
            try {
                const existing = dbModule.getSetting('pending_telegram_message');
                if (!existing) {
                    dbModule.setSetting('pending_telegram_message', JSON.stringify({ chatIds, message, type: 'raffle_block_mined' }));
                }
            } catch (e) {}
        }
        return;
    }

    for (const chatId of chatIds) {
        try {
            await sendMessage(chatId, message);
        } catch (e) {
            console.error(`Failed to send block-mined notification to ${chatId}:`, e.message);
        }
    }
}

/**
 * Check and deliver any pending quiet-hours notifications.
 * Called by the poll loop every 5 minutes — delivers queued messages once 9am arrives.
 * @param {Object} dbModule - database module
 */
async function deliverPendingNotifications(dbModule) {
    if (!dbModule) return;
    if (isQuietHours()) return; // Still in quiet hours

    // 1. Deliver any held raffle/system messages
    try {
        const pending = dbModule.getSetting('pending_telegram_message');
        if (pending) {
            const { chatIds, message } = JSON.parse(pending);
            console.log('📬 Delivering held Telegram notification (quiet hours ended)');
            for (const chatId of chatIds) {
                try { await sendMessage(chatId, message); } catch (e) {
                    console.error(`Failed to deliver held notification to ${chatId}:`, e.message);
                }
            }
            dbModule.setSetting('pending_telegram_message', '');
        }
    } catch (e) {
        console.error('Error delivering pending notifications:', e.message);
    }

    // 2. Send a summary of reviews that came in overnight
    try {
        const queuedCount = parseInt(dbModule.getSetting('quiet_hours_review_count') || '0', 10);
        if (queuedCount > 0) {
            const chatIds = getAdminChatIds(dbModule);
            const approveToken = process.env.TELEGRAM_APPROVE_TOKEN;
            const pendingTickets = dbModule.getPendingTickets ? dbModule.getPendingTickets() : [];
            const pendingCount = pendingTickets.length;

            let message = `☀️ *Good morning!*\n\n`;
            message += `${queuedCount} review${queuedCount > 1 ? 's' : ''} submitted overnight.\n`;
            message += `${pendingCount} review${pendingCount !== 1 ? 's' : ''} pending approval.\n\n`;
            message += `[👉 Review them now](${BASE_URL}/admin?password=${approveToken || ''})`;

            console.log(`📬 Sending morning review summary: ${queuedCount} overnight, ${pendingCount} pending`);
            for (const chatId of chatIds) {
                try { await sendMessage(chatId, message); } catch (e) {
                    console.error(`Failed to send morning summary to ${chatId}:`, e.message);
                }
            }
            dbModule.setSetting('quiet_hours_review_count', '0');
        }
    } catch (e) {
        console.error('Error sending morning review summary:', e.message);
    }
}

/**
 * Notify admins that a ticket was approved or rejected
 */
async function notifyTicketDecision(ticket, isApproved, adminNote, dbModule) {
    const chatIds = getAdminChatIds(dbModule);
    if (chatIds.length === 0) return;

    const emoji = isApproved ? '✅' : '❌';
    const action = isApproved ? 'Approved' : 'Rejected';
    const merchantDisplay = ticket.merchant_name || 'Unknown merchant';

    let message = `${emoji} *Review ${action}*\n`;
    message += `Ticket #${ticket.id} — ${escapeMarkdown(merchantDisplay)}`;
    if (adminNote) message += `\nReason: ${escapeMarkdown(adminNote)}`;

    for (const chatId of chatIds) {
        try {
            await sendMessage(chatId, message);
        } catch (e) {
            console.error(`Failed to notify chat ${chatId}:`, e.message);
        }
    }
}

// Mask email like ni***@gmail.com
function maskEmail(email) {
    if (!email) return '';
    return email.replace(/(.{2}).*(@.*)/, '$1***$2');
}

// Escape Markdown special chars for Telegram
function escapeMarkdown(text) {
    if (!text) return '';
    // For Markdown mode (not MarkdownV2), only escape these
    return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, (c) => {
        if (['_', '*', '[', '`'].includes(c)) return '\\' + c;
        return c;
    });
}

module.exports = {
    sendMessage,
    getAdminChatIds,
    isQuietHours,
    notifyNewReview,
    notifyRaffleResult,
    notifyRaffleWarning,
    notifyRaffleBlockMined,
    deliverPendingNotifications,
    notifyTicketDecision
};
