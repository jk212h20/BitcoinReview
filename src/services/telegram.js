/**
 * Telegram notification service
 * Sends admin notifications via the CoraTelegramBot
 */

const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || 'https://web-production-3a9f6.up.railway.app';

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
 * Get all admin chat IDs to notify
 * Returns primary chat ID from env var (and later could include DB-stored admins)
 */
function getAdminChatIds() {
    const ids = [];
    if (process.env.TELEGRAM_CHAT_ID) {
        ids.push(process.env.TELEGRAM_CHAT_ID);
    }
    return ids;
}

/**
 * Notify all admins about a new review submission
 * @param {Object} ticket - ticket record
 * @param {Object} user - user record (may be null for anonymous)
 */
async function notifyNewReview(ticket, user) {
    const chatIds = getAdminChatIds();
    if (chatIds.length === 0) {
        console.warn('⚠️  Telegram: no admin chat IDs configured');
        return;
    }

    const approveToken = process.env.TELEGRAM_APPROVE_TOKEN;
    const ticketId = ticket.id;
    const merchantDisplay = ticket.merchant_name ? `*${escapeMarkdown(ticket.merchant_name)}*` : '_Unknown merchant_';
    const submitterDisplay = user && user.email
        ? escapeMarkdown(maskEmail(user.email))
        : (user && user.lnurl_address ? `⚡ ${escapeMarkdown(user.lnurl_address)}` : '_Anonymous_');

    let message = `🔔 *New Review Submitted*\n\n`;
    message += `Merchant: ${merchantDisplay}\n`;
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
 * Notify all admins about a raffle result
 * @param {Object} raffle - raffle record
 * @param {Object} winner - winning ticket + user info
 */
async function notifyRaffleResult(raffle, winner) {
    const chatIds = getAdminChatIds();
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

    for (const chatId of chatIds) {
        try {
            await sendMessage(chatId, message);
        } catch (e) {
            console.error(`Failed to notify chat ${chatId}:`, e.message);
        }
    }
}

/**
 * Notify admins that a ticket was approved or rejected
 */
async function notifyTicketDecision(ticket, isApproved, adminNote) {
    const chatIds = getAdminChatIds();
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
        // Only escape chars that would break Markdown in Telegram's parse_mode=Markdown
        if (['_', '*', '[', '`'].includes(c)) return '\\' + c;
        return c;
    });
}

module.exports = {
    sendMessage,
    getAdminChatIds,
    notifyNewReview,
    notifyRaffleResult,
    notifyTicketDecision
};
