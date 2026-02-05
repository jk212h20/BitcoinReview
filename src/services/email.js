/**
 * Email service using Nodemailer
 */

const nodemailer = require('nodemailer');

let transporter = null;

/**
 * Initialize email transporter
 */
function initializeEmail() {
    // Skip if no SMTP config (for development)
    if (!process.env.SMTP_HOST) {
        console.log('⚠️  Email service not configured (SMTP_HOST missing)');
        return;
    }
    
    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_PORT === '465',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });
    
    console.log('✅ Email service initialized');
}

/**
 * Send registration confirmation email
 */
async function sendRegistrationEmail(email, optOutToken) {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const optOutLink = `${baseUrl}/opt-out/${optOutToken}`;
    
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #f7931a; color: white; padding: 20px; text-align: center; }
                .content { padding: 20px; background: #f9f9f9; }
                .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
                .button { display: inline-block; padding: 10px 20px; background: #f7931a; color: white; text-decoration: none; border-radius: 5px; }
                .opt-out { color: #999; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🎉 Welcome to Bitcoin Review Raffle!</h1>
                </div>
                <div class="content">
                    <p>Thanks for registering for the Bitcoin Review Raffle in Roatan!</p>
                    
                    <h2>How it works:</h2>
                    <ol>
                        <li>Visit a Bitcoin-accepting merchant in Roatan</li>
                        <li>Pay with Bitcoin</li>
                        <li>Write a Google review mentioning your Bitcoin purchase</li>
                        <li>Submit your review link on our website</li>
                        <li>Get entered into the raffle!</li>
                    </ol>
                    
                    <p>Every Bitcoin difficulty adjustment (~2 weeks), we randomly select a winner who receives Bitcoin!</p>
                    
                    <p style="text-align: center;">
                        <a href="${baseUrl}/submit" class="button">Submit a Review</a>
                    </p>
                </div>
                <div class="footer">
                    <p class="opt-out">
                        Didn't sign up for this? <a href="${optOutLink}">Click here to remove your email</a>
                    </p>
                </div>
            </div>
        </body>
        </html>
    `;
    
    const text = `
Welcome to Bitcoin Review Raffle!

Thanks for registering for the Bitcoin Review Raffle in Roatan!

How it works:
1. Visit a Bitcoin-accepting merchant in Roatan
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
 * Send winner notification email
 */
async function sendWinnerEmail(email, prizeAmount, lnurlAddress, blockHeight) {
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #f7931a; color: white; padding: 20px; text-align: center; }
                .content { padding: 20px; background: #f9f9f9; }
                .prize { font-size: 24px; color: #f7931a; text-align: center; padding: 20px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🎊 Congratulations! You Won! 🎊</h1>
                </div>
                <div class="content">
                    <p>Great news! You've been selected as the winner of the Bitcoin Review Raffle!</p>
                    
                    <div class="prize">
                        <strong>${prizeAmount ? prizeAmount.toLocaleString() + ' sats' : 'Prize'}</strong>
                    </div>
                    
                    <p><strong>Raffle Block:</strong> ${blockHeight}</p>
                    <p><strong>Your LNURL:</strong> ${lnurlAddress}</p>
                    
                    <p>We'll be sending your prize to your Lightning address shortly!</p>
                    
                    <p>Thank you for supporting Bitcoin adoption in Roatan! 🌴⚡</p>
                </div>
            </div>
        </body>
        </html>
    `;
    
    const text = `
🎊 Congratulations! You Won! 🎊

Great news! You've been selected as the winner of the Bitcoin Review Raffle!

Prize: ${prizeAmount ? prizeAmount.toLocaleString() + ' sats' : 'TBD'}
Raffle Block: ${blockHeight}
Your LNURL: ${lnurlAddress}

We'll be sending your prize to your Lightning address shortly!

Thank you for supporting Bitcoin adoption in Roatan! 🌴⚡
    `;
    
    return sendEmail(email, '🎊 You Won the Bitcoin Review Raffle!', html, text);
}

/**
 * Generic send email function
 */
async function sendEmail(to, subject, html, text) {
    if (!transporter) {
        console.log(`📧 [DEV] Would send email to ${to}: ${subject}`);
        return { success: true, dev: true };
    }
    
    try {
        const result = await transporter.sendMail({
            from: process.env.SMTP_FROM || 'Bitcoin Review Raffle <noreply@bitcoinreview.com>',
            to,
            subject,
            html,
            text
        });
        
        console.log(`📧 Email sent to ${to}: ${subject}`);
        return { success: true, messageId: result.messageId };
    } catch (error) {
        console.error(`❌ Failed to send email to ${to}:`, error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    initializeEmail,
    sendRegistrationEmail,
    sendWinnerEmail,
    sendEmail
};
