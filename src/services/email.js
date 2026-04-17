/**
 * Email service using Resend
 * https://resend.com/docs
 */

const { Resend } = require('resend');

let resend = null;

/**
 * Initialize email service
 */
function initializeEmail() {
    if (!process.env.RESEND_API_KEY) {
        console.log('⚠️  Email service not configured (RESEND_API_KEY missing)');
        return;
    }
    
    resend = new Resend(process.env.RESEND_API_KEY);
    console.log('✅ Email service initialized (Resend)');
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
                    <h1>🎉 Welcome to Reviews Raffle!</h1>
                </div>
                <div class="content">
                    <p>Thanks for registering for the Reviews Raffle in Roatan!</p>
                    
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
Welcome to Reviews Raffle!

Thanks for registering for the Reviews Raffle in Roatan!

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
    
    return sendEmail(email, 'Welcome to Reviews Raffle! 🎉', html, text);
}

/**
 * Send winner notification email with claim link (LNURL-withdraw)
 * Winner clicks link → sees QR code → scans with any Lightning wallet → gets sats
 */
async function sendWinnerEmail(emailAddr, prizeAmount, claimToken, blockHeight) {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const claimLink = `${baseUrl}/claim/${claimToken}`;
    
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #f7931a; color: white; padding: 20px; text-align: center; }
                .content { padding: 20px; background: #f9f9f9; }
                .prize { font-size: 28px; color: #f7931a; text-align: center; padding: 20px; font-weight: bold; }
                .claim-button { display: inline-block; padding: 15px 30px; background: #f7931a; color: white; text-decoration: none; border-radius: 8px; font-size: 18px; font-weight: bold; }
                .footer { padding: 15px; text-align: center; font-size: 12px; color: #999; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🎊 Congratulations! You Won! 🎊</h1>
                </div>
                <div class="content">
                    <p>Great news! You've been selected as the winner of the Reviews Raffle!</p>
                    
                    <div class="prize">
                        ${prizeAmount ? prizeAmount.toLocaleString() + ' sats' : 'Prize'}
                    </div>
                    
                    <p style="text-align: center; margin: 25px 0;">
                        <a href="${claimLink}" class="claim-button">⚡ Claim Your Prize</a>
                    </p>
                    
                    <p style="text-align: center; color: #666;">
                        Click the button above to see a QR code.<br>
                        Scan it with <strong>any Lightning wallet</strong> to receive your sats instantly.
                    </p>
                    
                    <p style="margin-top: 20px; font-size: 14px; color: #666;">
                        <strong>Raffle Block:</strong> #${blockHeight ? blockHeight.toLocaleString() : 'N/A'}<br>
                        <strong>Works with:</strong> Phoenix, Wallet of Satoshi, Muun, Breez, Zeus, BlueWallet, and more
                    </p>
                    
                    <p>Thank you for supporting Bitcoin adoption in Roatan! 🌴⚡</p>
                </div>
                <div class="footer">
                    <p>This claim link expires in 30 days. If you have trouble, reply to this email.</p>
                    <p>Can't click the button? Copy this link: ${claimLink}</p>
                </div>
            </div>
        </body>
        </html>
    `;
    
    const text = `
🎊 Congratulations! You Won the Reviews Raffle! 🎊

Your prize: ${prizeAmount ? prizeAmount.toLocaleString() + ' sats' : 'TBD'}

Click here to claim your prize:
${claimLink}

You'll see a QR code — just scan it with any Lightning wallet to receive your sats.
Works with: Phoenix, Wallet of Satoshi, Muun, Breez, Zeus, BlueWallet, and more.

Raffle Block: #${blockHeight ? blockHeight.toLocaleString() : 'N/A'}
This link expires in 30 days.

Thank you for supporting Bitcoin adoption in Roatan! 🌴⚡

— Reviews Raffle
    `;
    
    return sendEmail(emailAddr, '🎊 You Won the Reviews Raffle! Claim your sats →', html, text);
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
        // EMAIL_FROM should be your verified domain address once you have one.
        // Before domain verification, use 'onboarding@resend.dev' for testing.
        const from = process.env.EMAIL_FROM || 'Reviews Raffle <onboarding@resend.dev>';
        
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
    sendRegistrationEmail,
    sendWinnerEmail,
    sendEmail
};
