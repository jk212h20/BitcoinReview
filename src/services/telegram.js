/**
 * Telegram notification service
 * Sends admin notifications via the CoraTelegramBot
 * 
 * Templates are loaded from /templates/ directory (shared with email.js).
 * Telegram templates use {{variable}} placeholders and Telegram HTML subset.
 */

const https = require('https');
const path = require('path');
const fs = require('fs');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || 'https://web-production-3a9f6.up.railway.app';

// Roatan timezone (UTC-6, no DST)
const ADMIN_TIMEZONE = process.env.ADMIN_TIMEZONE || 'America/Tegucigalpa';
const QUIET_HOUR_START = 18; // 6pm — no notifications after this hour
const QUIET_HOUR_END = 9;    // 9am — notifications resume at this hour

/**
 * Render a Telegram template by substituting {{variable}} placeholders.
 * Reads from DB via the dbModule parameter.
 * @param {string} templateName - template name (e.g. 'tg-new-review')
 * @param {Object} vars - key/value pairs to substitute
 * @param {Object} [dbModule] - database module (reads from message_templates table)
 * @returns {string|null} rendered text or null if template not found
 */
function renderTgTemplate(templateName, vars = {}, dbModule = null) {
    let tmplBody = null;
    if (dbModule) {
        try {
            const row = dbModule.getTemplate(templateName);
            if (row) tmplBody = row.body;
        } catch (e) { /* DB not ready */ }
    }
    
    if (!tmplBody) return null;
    
    return tmplBody.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return vars[key] !== undefined ? vars[key] : match;
    });
}

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
 * @param {string} text - Message text (supports HTML)
 * @param {string} [parseMode='HTML'] - Parse mode ('HTML' or 'Markdown')
 * @returns {Promise<boolean>}
 */
async function sendMessage(chatId, text, parseMode = 'HTML') {
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
        parse_mode: parseMode,
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
 * During quiet hours (6pm–9am Roatan), reviews are queued and a single summary
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
    const merchantDisplay = ticket.merchant_name ? `<b>${escapeHtml(ticket.merchant_name)}</b>` : '<i>Unknown merchant</i>';
    const submitterDisplay = user && user.email
        ? escapeHtml(maskEmail(user.email))
        : (user && user.lnurl_address ? `⚡ ${escapeHtml(user.lnurl_address)}` : '<i>Anonymous</i>');

    const triedBtc = ticket.tried_bitcoin === 1 ? '✅ Yes' : (ticket.tried_bitcoin === 0 ? '❌ No' : '❓ N/A');
    const acceptedBtc = ticket.merchant_accepted === 1 ? '✅ Yes' : (ticket.merchant_accepted === 0 ? '❌ No' : '❓ N/A');

    let reviewPreview = '';
    if (ticket.review_text) {
        const preview = ticket.review_text.length > 200
            ? ticket.review_text.substring(0, 200) + '…'
            : ticket.review_text;
        reviewPreview = `\n📝 <i>"${escapeHtml(preview)}"</i>\n`;
    }

    // Try template
    let message = renderTgTemplate('tg-new-review', {
        merchantDisplay,
        triedBtc,
        acceptedBtc,
        submitterDisplay,
        reviewLink: ticket.review_link,
        reviewPreview,
        baseUrl: BASE_URL,
        ticketId,
        approveToken: approveToken || ''
    }, dbModule);

    // Fallback to inline
    if (!message) {
        message = `🔔 <b>New Review Submitted</b>\n\n`;
        message += `Merchant: ${merchantDisplay}\n`;
        message += `Tried Bitcoin: ${triedBtc}\n`;
        message += `Merchant Accepted: ${acceptedBtc}\n`;
        message += `Submitted by: ${submitterDisplay}\n`;
        message += `Review Link: <a href="${ticket.review_link}">Open Review</a>\n`;
        if (reviewPreview) message += reviewPreview;
        message += `\n`;
        message += `<a href="${BASE_URL}/admin/review/${ticketId}?token=${approveToken}">👁 View in Admin</a>\n`;
        if (approveToken) {
            message += `<a href="${BASE_URL}/api/admin/tickets/${ticketId}/quick-approve?token=${approveToken}">✅ Approve</a>\n`;
            message += `<a href="${BASE_URL}/api/admin/tickets/${ticketId}/quick-reject?token=${approveToken}">❌ Reject</a>`;
        }
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

    const winnerDisplay = winner.email ? escapeHtml(maskEmail(winner.email)) : (winner.lnurl_address ? `⚡ ${escapeHtml(winner.lnurl_address)}` : '<i>Anonymous</i>');
    const prizeDisplay = raffle.prize_amount_sats ? `Prize: ${raffle.prize_amount_sats.toLocaleString()} sats\n` : '';
    const lightningDisplay = winner.lnurl_address ? `Lightning Address: <code>${escapeHtml(winner.lnurl_address)}</code>\n` : '';

    // Try template
    let message = renderTgTemplate('tg-raffle-result', {
        blockHeight: raffle.block_height.toLocaleString(),
        totalTickets: raffle.total_tickets,
        winnerDisplay,
        prizeDisplay,
        lightningDisplay,
        baseUrl: BASE_URL
    }, dbModule);

    // Fallback to inline
    if (!message) {
        message = `🎰 <b>Raffle Complete!</b>\n\n`;
        message += `Block: #${raffle.block_height.toLocaleString()}\n`;
        message += `Total Tickets: ${raffle.total_tickets}\n`;
        message += `Winner: ${winnerDisplay}\n`;
        message += prizeDisplay;
        message += lightningDisplay;
        message += `\nManage at: ${BASE_URL}/admin`;
    }

    if (isQuietHours()) {
        console.log('📵 Raffle result notification suppressed (quiet hours) — will send at 9am');
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
    const manualNote = !autoEnabled ? `When the block is mined, go to:\n${BASE_URL}/admin` : '';

    // Try template
    let message = renderTgTemplate('tg-raffle-warning', {
        raffleBlock: raffleBlock.toLocaleString(),
        approvedTickets: String(approvedTickets),
        modeText,
        manualNote
    }, dbModule);

    // Fallback to inline
    if (!message) {
        message = `⏰ <b>Raffle in ~24 hours!</b>\n\n`;
        message += `Block #${raffleBlock.toLocaleString()} is ~144 blocks away.\n`;
        message += `Approved tickets in pool: <b>${approvedTickets}</b>\n`;
        message += `${modeText}\n\n`;
        if (!autoEnabled) {
            message += `When the block is mined, go to:\n${BASE_URL}/admin`;
        }
    }

    if (isQuietHours()) {
        console.log('📵 Raffle warning suppressed (quiet hours) — storing for 9am delivery');
        if (dbModule) {
            try {
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

    let headerSuffix, bodyText;
    if (autoTriggered) {
        headerSuffix = 'mined!';
        bodyText = `Running raffle automatically with ${approvedTickets} approved tickets...\n(Winner announcement coming shortly)`;
    } else {
        headerSuffix = 'has been mined!';
        bodyText = `${approvedTickets} approved tickets in the pool.\n👉 <a href="${BASE_URL}/admin">Run the raffle now</a>`;
    }

    // Try template
    let message = renderTgTemplate('tg-block-mined', {
        raffleBlock: raffleBlock.toLocaleString(),
        headerSuffix,
        bodyText
    }, dbModule);

    // Fallback to inline
    if (!message) {
        if (autoTriggered) {
            message = `🎲 <b>Raffle block #${raffleBlock.toLocaleString()} mined!</b>\n`;
            message += `Running raffle automatically with ${approvedTickets} approved tickets...\n`;
            message += `(Winner announcement coming shortly)`;
        } else {
            message = `🎲 <b>Raffle block #${raffleBlock.toLocaleString()} has been mined!</b>\n\n`;
            message += `${approvedTickets} approved tickets in the pool.\n`;
            message += `👉 <a href="${BASE_URL}/admin">Run the raffle now</a>`;
        }
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

            const overnightPlural = queuedCount > 1 ? 's' : '';
            const pendingPlural = pendingCount !== 1 ? 's' : '';

            // Try template
            let message = renderTgTemplate('tg-morning-summary', {
                overnightCount: String(queuedCount),
                overnightPlural,
                pendingCount: String(pendingCount),
                pendingPlural,
                baseUrl: BASE_URL,
                approveToken: approveToken || ''
            }, dbModule);

            // Fallback to inline
            if (!message) {
                message = `☀️ <b>Good morning!</b>\n\n`;
                message += `${queuedCount} review${overnightPlural} submitted overnight.\n`;
                message += `${pendingCount} review${pendingPlural} pending approval.\n\n`;
                message += `<a href="${BASE_URL}/admin?password=${approveToken || ''}">👉 Review them now</a>`;
            }

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
    const merchantDisplay = escapeHtml(ticket.merchant_name || 'Unknown merchant');
    const adminNoteText = adminNote ? `\nReason: ${escapeHtml(adminNote)}` : '';

    // Try template
    let message = renderTgTemplate('tg-ticket-decision', {
        emoji,
        action,
        ticketId: ticket.id,
        merchantDisplay,
        adminNote: adminNoteText
    }, dbModule);

    // Fallback to inline
    if (!message) {
        message = `${emoji} <b>Review ${action}</b>\n`;
        message += `Ticket #${ticket.id} — ${merchantDisplay}`;
        if (adminNote) message += `\nReason: ${escapeHtml(adminNote)}`;
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
 * Notify a raffle winner via Telegram DM (if they have a linked chat ID).
 * Sends the claim link directly to the player's Telegram.
 * @param {string} chatId - The winner's Telegram chat ID
 * @param {number} prizeSats - Prize amount in sats
 * @param {string} claimToken - The claim token for LNURL-withdraw
 * @param {number} blockHeight - The raffle block height
 */
async function notifyWinner(chatId, prizeSats, claimToken, blockHeight, dbModule) {
    if (!chatId) return false;

    const baseUrl = BASE_URL;
    const claimLink = `${baseUrl}/claim/${claimToken}`;

    // Try template
    let message = renderTgTemplate('tg-winner-dm', {
        blockHeight: blockHeight.toLocaleString(),
        prizeSats: prizeSats.toLocaleString(),
        claimLink
    }, dbModule);

    // Fallback to inline
    if (!message) {
        message = `🎉 <b>You won the Bitcoin Review Raffle!</b>\n\n`;
        message += `Block #${blockHeight.toLocaleString()}\n`;
        message += `Prize: <b>${prizeSats.toLocaleString()} sats</b>\n\n`;
        message += `👉 <a href="${claimLink}">Claim Your Prize</a>\n\n`;
        message += `Open the link above, then scan the QR code with any Lightning wallet to receive your sats. ⚡\n\n`;
        message += `<i>This claim link expires in 30 days.</i>`;
    }

    try {
        const sent = await sendMessage(chatId, message);
        if (sent) {
            console.log(`📱 Winner notification sent via Telegram to chat ${chatId}`);
        }
        return sent;
    } catch (e) {
        console.error(`Failed to send winner Telegram notification to ${chatId}:`, e.message);
        return false;
    }
}

// Mask email like ni***@gmail.com
function maskEmail(email) {
    if (!email) return '';
    return email.replace(/(.{2}).*(@.*)/, '$1***$2');
}

// Escape HTML special chars for Telegram HTML mode
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Legacy: Escape Markdown special chars for Telegram (kept for backward compat)
function escapeMarkdown(text) {
    if (!text) return '';
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
    notifyTicketDecision,
    notifyWinner,
    renderTgTemplate
};
