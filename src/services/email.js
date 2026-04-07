/**
 * Email service using Resend
 * https://resend.com/docs
 * 
 * Templates are stored in the database (message_templates table).
 * On startup, seed from /templates/ disk files if the DB doesn't have them yet.
 * Admins can edit templates via the admin panel Templates tab.
 * Reset to defaults re-seeds from /templates/ on disk.
 */

const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');

let resend = null;

// Template descriptions and metadata for seeding
const TEMPLATE_META = {
    'welcome-email':     { type: 'email',    subject: '🎉 Welcome to Bitcoin Review Raffle!', description: 'Sent when a new user registers' },
    'winner-email':      { type: 'email',    subject: '🎊 You Won the Bitcoin Review Raffle!', description: 'Sent to raffle winner with claim link' },
    'raffle-reminder':   { type: 'compose',  subject: '🎰 Raffle Drawing Coming Soon!', description: 'Admin compose: remind users about upcoming raffle' },
    'new-merchant':      { type: 'compose',  subject: '🏪 New Merchant Accepting Bitcoin!', description: 'Admin compose: announce a new merchant' },
    'general-update':    { type: 'compose',  subject: '📢 Bitcoin Review Raffle Update', description: 'Admin compose: general announcement' },
    'tg-new-review':     { type: 'telegram', subject: null, description: 'Telegram: new review submitted (admin notification)' },
    'tg-raffle-result':  { type: 'telegram', subject: null, description: 'Telegram: raffle result announcement' },
    'tg-raffle-warning': { type: 'telegram', subject: null, description: 'Telegram: raffle approaching warning' },
    'tg-block-mined':    { type: 'telegram', subject: null, description: 'Telegram: trigger block mined' },
    'tg-morning-summary':{ type: 'telegram', subject: null, description: 'Telegram: morning summary after quiet hours' },
    'tg-ticket-decision':{ type: 'telegram', subject: null, description: 'Telegram: ticket approved/rejected notification' },
    'tg-winner-dm':      { type: 'telegram', subject: null, description: 'Telegram: DM to winner with claim link' }
};

/**
 * Initialize email service
 */
function initializeEmail() {
    if (!process.env.RESEND_API_KEY) {
        console.log('⚠️  Email service not configured (RESEND_API_KEY missing)');
    } else {
        resend = new Resend(process.env.RESEND_API_KEY);
        console.log('✅ Email service initialized (Resend)');
    }
}

/**
 * Seed templates from disk into DB. Only inserts if the template doesn't already exist in DB.
 * Call this after initializeDatabase() in the startup sequence.
 */
function seedTemplates(db) {
    const templatesDir = path.join(__dirname, '../../templates');
    
    if (!fs.existsSync(templatesDir)) {
        console.log('⚠️  No templates/ directory found — skipping seed');
        return;
    }
    
    const files = fs.readdirSync(templatesDir).filter(f => f.endsWith('.html'));
    let seeded = 0;
    
    for (const file of files) {
        const name = file.replace('.html', '');
        const existing = db.getTemplate(name);
        
        if (!existing) {
            try {
                const body = fs.readFileSync(path.join(templatesDir, file), 'utf8');
                const meta = TEMPLATE_META[name] || { type: 'email', subject: null, description: null };
                db.upsertTemplate(name, meta.type, body, meta.subject, meta.description);
                seeded++;
            } catch (e) {
                console.warn(`⚠️  Failed to seed template ${file}:`, e.message);
            }
        }
    }
    
    const total = db.getAllTemplates().length;
    if (seeded > 0) {
        console.log(`📄 Seeded ${seeded} new templates into DB (${total} total)`);
    } else {
        console.log(`📄 ${total} templates in DB (all already seeded)`);
    }
}

/**
 * Reset a template to its disk default (re-reads from /templates/ and overwrites DB)
 */
function resetTemplateToDefault(db, templateName) {
    const filePath = path.join(__dirname, '../../templates', `${templateName}.html`);
    if (!fs.existsSync(filePath)) {
        return { success: false, error: 'No default template file found on disk' };
    }
    
    const body = fs.readFileSync(filePath, 'utf8');
    const meta = TEMPLATE_META[templateName] || { type: 'email', subject: null, description: null };
    db.upsertTemplate(templateName, meta.type, body, meta.subject, meta.description);
    return { success: true };
}

/**
 * Render a template by substituting {{variable}} placeholders
 * Reads from DB via the passed db module
 * @param {Object} db - database module
 * @param {string} templateName - template name (e.g. 'welcome-email')
 * @param {Object} vars - key/value pairs to substitute
 * @returns {string|null} rendered HTML or null if template not found
 */
function renderTemplate(templateName, vars = {}, db = null) {
    // If db is provided, read from DB; otherwise fall back to null
    let tmplBody = null;
    if (db) {
        const row = db.getTemplate(templateName);
        if (row) tmplBody = row.body;
    }
    
    if (!tmplBody) return null;
    
    return tmplBody.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return vars[key] !== undefined ? vars[key] : match;
    });
}

/**
 * Get all available admin-compose email templates (raffle-reminder, new-merchant, general-update)
 * Returns object of { key: { subject, html } } for the admin email tab
 */
function getAdminComposeTemplates(db) {
    const baseUrl = process.env.BASE_URL || 'https://bitcoinreviewsraffle.com';
    
    const composeKeys = {
        'raffle_reminder': 'raffle-reminder',
        'new_merchant': 'new-merchant',
        'general_update': 'general-update'
    };
    
    const result = {};
    for (const [key, templateName] of Object.entries(composeKeys)) {
        const row = db ? db.getTemplate(templateName) : null;
        if (row) {
            const html = row.body.replace(/\{\{(\w+)\}\}/g, (match, k) => {
                return k === 'baseUrl' ? baseUrl : match;
            });
            result[key] = {
                subject: row.subject || TEMPLATE_META[templateName]?.subject || '',
                html
            };
        }
    }
    
    return result;
}

/**
 * Send registration confirmation email
 */
async function sendRegistrationEmail(email, optOutToken, db = null) {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const optOutLink = `${baseUrl}/opt-out/${optOutToken}`;
    
    // Try DB template first
    let html = renderTemplate('welcome-email', { baseUrl, optOutLink }, db);
    
    // Fallback to inline HTML if template not available
    if (!html) {
        html = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                    .header { background: #f7931a; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
                    .content { padding: 20px; background: #f9f9f9; }
                    .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
                    .button { display: inline-block; padding: 10px 20px; background: #f7931a; color: white; text-decoration: none; border-radius: 5px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header"><h1>🎉 Welcome to Bitcoin Review Raffle!</h1></div>
                    <div class="content">
                        <p>Thanks for registering for the Bitcoin Review Raffle in the Bay Islands!</p>
                        <ol>
                            <li>Visit a Bitcoin-accepting merchant</li>
                            <li>Pay with Bitcoin</li>
                            <li>Write a Google review mentioning your Bitcoin purchase</li>
                            <li>Submit your review link on our website</li>
                            <li>Get entered into the raffle!</li>
                        </ol>
                        <p>Every Bitcoin difficulty adjustment (~2 weeks), we randomly select a winner who receives Bitcoin!</p>
                        <p style="text-align:center"><a href="${baseUrl}/submit" class="button">Submit a Review</a></p>
                    </div>
                    <div class="footer">
                        <a href="${optOutLink}">Didn't sign up? Remove your email</a>
                    </div>
                </div>
            </body>
            </html>
        `;
    }
    
    const text = `
Welcome to Bitcoin Review Raffle!

Thanks for registering for the Bitcoin Review Raffle in the Bay Islands!

How it works:
1. Visit a Bitcoin-accepting merchant in Roatan or Utila
2. Pay with Bitcoin
3. Write a Google review mentioning your Bitcoin purchase
4. Submit your review link on our website
5. Get entered into the raffle!

Every Bitcoin difficulty adjustment (~2 weeks), we randomly select a winner who receives Bitcoin!

Submit a review: ${baseUrl}/submit

---
Didn't sign up for this? Remove your email: ${optOutLink}
    `;
    
    return sendEmail(email, 'Welcome to Bitcoin Review Raffle! 🎉', html, text);
}

/**
 * Send winner notification email with claim link (LNURL-withdraw)
 */
async function sendWinnerEmail(emailAddr, prizeAmount, claimToken, blockHeight, db = null) {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const claimLink = `${baseUrl}/claim/${claimToken}`;
    const prizeFormatted = prizeAmount ? prizeAmount.toLocaleString() : 'Prize';
    const blockFormatted = blockHeight ? blockHeight.toLocaleString() : 'N/A';
    
    // Try DB template first
    let html = renderTemplate('winner-email', {
        baseUrl,
        claimLink,
        prizeAmount: prizeFormatted,
        blockHeight: blockFormatted
    }, db);
    
    // Fallback to inline HTML if template not available
    if (!html) {
        html = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                    .header { background: #f7931a; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
                    .content { padding: 20px; background: #f9f9f9; }
                    .prize { font-size: 28px; color: #f7931a; text-align: center; padding: 20px; font-weight: bold; }
                    .claim-button { display: inline-block; padding: 15px 30px; background: #f7931a; color: white; text-decoration: none; border-radius: 8px; font-size: 18px; font-weight: bold; }
                    .footer { padding: 15px; text-align: center; font-size: 12px; color: #999; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header"><h1>🎊 Congratulations! You Won! 🎊</h1></div>
                    <div class="content">
                        <p>Great news! You've been selected as the winner of the Bitcoin Review Raffle!</p>
                        <div class="prize">⚡ ${prizeFormatted} sats</div>
                        <p style="text-align:center;margin:25px 0"><a href="${claimLink}" class="claim-button">⚡ Claim Your Prize</a></p>
                        <p style="text-align:center;color:#666">Click the button above to see a QR code.<br>Scan it with <strong>any Lightning wallet</strong> to receive your sats instantly.</p>
                        <p style="font-size:14px;color:#666"><strong>Raffle Block:</strong> #${blockFormatted}<br><strong>Works with:</strong> Phoenix, Wallet of Satoshi, Muun, Breez, Zeus, BlueWallet, and more</p>
                        <p>Thank you for supporting Bitcoin adoption in the Bay Islands! 🌴⚡</p>
                    </div>
                    <div class="footer">
                        <p>This claim link expires in 30 days. If you have trouble, reply to this email.</p>
                        <p>Can't click the button? Copy this link: ${claimLink}</p>
                    </div>
                </div>
            </body>
            </html>
        `;
    }
    
    const text = `
🎊 Congratulations! You Won the Bitcoin Review Raffle! 🎊

Your prize: ${prizeFormatted} sats

Click here to claim your prize:
${claimLink}

You'll see a QR code — just scan it with any Lightning wallet to receive your sats.
Works with: Phoenix, Wallet of Satoshi, Muun, Breez, Zeus, BlueWallet, and more.

Raffle Block: #${blockFormatted}
This link expires in 30 days.

Thank you for supporting Bitcoin adoption in the Bay Islands! 🌴⚡

— Bitcoin Review
    `;
    
    return sendEmail(emailAddr, '🎊 You Won the Bitcoin Review Raffle! Claim your sats →', html, text);
}

/**
 * Generic send email function using Resend API
 */
async function sendEmail(to, subject, html, text) {
    if (!resend) {
        console.log(`📧 [DEV] Would send email to ${to}: ${subject}`);
        return { success: true, dev: true };
    }
    
    try {
        const from = process.env.EMAIL_FROM || 'Bitcoin Review Raffle <onboarding@resend.dev>';
        
        const { data, error } = await resend.emails.send({
            from,
            to,
            subject,
            html,
            text
        });
        
        if (error) {
            console.error(`❌ Failed to send email to ${to}:`, error.message);
            return { success: false, error: error.message };
        }
        
        console.log(`📧 Email sent to ${to}: ${subject} (id: ${data.id})`);
        return { success: true, messageId: data.id };
    } catch (error) {
        console.error(`❌ Failed to send email to ${to}:`, error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    initializeEmail,
    seedTemplates,
    resetTemplateToDefault,
    sendRegistrationEmail,
    sendWinnerEmail,
    sendEmail,
    renderTemplate,
    getAdminComposeTemplates,
    TEMPLATE_META
};
