/**
 * Page routes for frontend views
 */

const express = require('express');
const router = express.Router();

const { bech32 } = require('bech32');
const db = require('../services/database');
const bitcoin = require('../services/bitcoin');
const btcmap = require('../services/btcmap');
const lightning = require('../services/lightning');

/**
 * Encode a URL as an LNURL (bech32-encoded, uppercase)
 */
function encodeLnurl(url) {
    const words = bech32.toWords(Buffer.from(url, 'utf8'));
    return bech32.encode('lnurl', words, 2000).toUpperCase();
}

/**
 * GET /
 * Landing page
 */
router.get('/', async (req, res) => {
    try {
        const raffleInfo = await bitcoin.getRaffleInfo();
        const userCount = db.getUserCount();
        const ticketCount = db.countValidTicketsForBlock(raffleInfo.nextRaffleBlock);
        const latestRaffle = db.getLatestRaffle();
        const allRaffles = db.getAllRaffles();
        
        // Use cached deposit info (instant, no LND API call)
        const depositInfo = lightning.getDepositInfoCached();
        const totalDonations = db.getTotalDonationsReceived();

        // Get most-recently-reviewed merchant for homepage spotlight
        const recentlyReviewedMerchant = db.getMostRecentlyReviewedMerchant();
        
        res.render('index', {
            title: 'Bitcoin Review Raffle - Roatan',
            raffleInfo,
            userCount,
            ticketCount,
            latestRaffle,
            totalRaffles: allRaffles.length,
            recentlyReviewedMerchant,
            onchainAddress: depositInfo.onchainAddress,
            lightningInvoice: depositInfo.lightningInvoice,
            totalDonationsSats: totalDonations,
            donationAddress: depositInfo.onchainAddress || process.env.DONATION_ADDRESS || 'Not configured'
        });
    } catch (error) {
        console.error('Landing page error:', error);
        res.render('index', {
            title: 'Bitcoin Review Raffle - Roatan',
            error: 'Failed to load raffle info',
            raffleInfo: null,
            userCount: 0,
            ticketCount: 0,
            latestRaffle: null,
            totalRaffles: 0,
            recentlyReviewedMerchant: null,
            onchainAddress: null,
            lightningInvoice: null,
            totalDonationsSats: 0,
            donationAddress: process.env.DONATION_ADDRESS || 'Not configured'
        });
    }
});

/**
 * GET /submit
 * Unified submission page (review link + optional email/lnurl)
 */
router.get('/submit', async (req, res) => {
    try {
        const raffleInfo = await bitcoin.getRaffleInfo();
        
        // Use cached deposit info (instant, no LND API call)
        const depositInfo = lightning.getDepositInfoCached();

        // Load merchant list for the searchable dropdown
        let merchants = [];
        try {
            merchants = await btcmap.getMerchantList();
        } catch (err) {
            console.warn('Could not load merchants for submit page:', err.message);
        }
        
        res.render('submit', {
            title: 'Submit Review - Bitcoin Review Raffle',
            raffleInfo,
            merchants,
            donationAddress: depositInfo.onchainAddress || process.env.DONATION_ADDRESS || 'Not configured'
        });
    } catch (error) {
        console.error('Submit page error:', error);
        res.render('submit', {
            title: 'Submit Review - Bitcoin Review Raffle',
            error: 'Failed to load page data',
            merchants: [],
            donationAddress: process.env.DONATION_ADDRESS || 'Not configured'
        });
    }
});

/**
 * GET /merchants
 * Merchant list page
 */
router.get('/merchants', async (req, res) => {
    try {
        const merchants = await btcmap.getMerchantList();

        // Use cached deposit info (instant, no LND API call)
        const depositInfo = lightning.getDepositInfoCached();

        // Get approved tickets with merchant names to find recently-reviewed merchants
        const approvedTickets = db.getApprovedPublicTickets();

        // Build a map of merchantName -> most recent submitted_at
        const lastReviewedMap = {};
        for (const t of approvedTickets) {
            if (!t.merchant_name) continue;
            const name = t.merchant_name.trim();
            if (!lastReviewedMap[name] || t.submitted_at > lastReviewedMap[name]) {
                lastReviewedMap[name] = t.submitted_at;
            }
        }

        // Annotate merchants and sort: reviewed first (most recent), then unreviewed
        const annotated = merchants.map(m => ({
            ...m,
            lastReviewed: lastReviewedMap[m.name] || null
        }));
        annotated.sort((a, b) => {
            if (a.lastReviewed && b.lastReviewed) return b.lastReviewed.localeCompare(a.lastReviewed);
            if (a.lastReviewed) return -1;
            if (b.lastReviewed) return 1;
            return a.name.localeCompare(b.name);
        });

        res.render('merchants', {
            title: 'Bitcoin Merchants - Roatan',
            merchants: annotated,
            donationAddress: depositInfo.onchainAddress || process.env.DONATION_ADDRESS || 'Not configured'
        });
    } catch (error) {
        console.error('Merchants page error:', error);
        res.render('merchants', {
            title: 'Bitcoin Merchants - Roatan',
            error: 'Failed to load merchants',
            merchants: [],
            donationAddress: process.env.DONATION_ADDRESS || 'Not configured'
        });
    }
});

/**
 * GET /opt-out/:token
 * Opt-out page
 */
router.get('/opt-out/:token', (req, res) => {
    const { token } = req.params;
    
    const user = db.findUserByOptOutToken(token);
    
    if (!user) {
        return res.render('opt-out', {
            title: 'Opt Out - Bitcoin Review Raffle',
            error: 'Invalid or expired opt-out link'
        });
    }
    
    if (!user.is_active) {
        return res.render('opt-out', {
            title: 'Opt Out - Bitcoin Review Raffle',
            message: 'You have already been removed from the raffle.'
        });
    }
    
    // Deactivate user
    db.deactivateUser(token);
    
    res.render('opt-out', {
        title: 'Opt Out - Bitcoin Review Raffle',
        message: 'You have been successfully removed from the Bitcoin Review Raffle. Sorry to see you go!'
    });
});

/**
 * GET /reviews
 * Public reviews page - shows only approved reviews, featured first
 */
router.get('/reviews', (req, res) => {
    try {
        const reviews = db.getApprovedPublicTickets();
        const featuredReviews = reviews.filter(r => r.is_featured);
        const regularReviews = reviews.filter(r => !r.is_featured);

        // Use cached deposit info (instant, no LND API call)
        const depositInfo = lightning.getDepositInfoCached();
        
        res.render('reviews', {
            title: 'Reviews - Bitcoin Review Raffle',
            reviews,
            featuredReviews,
            regularReviews,
            donationAddress: depositInfo.onchainAddress || process.env.DONATION_ADDRESS || 'Not configured'
        });
    } catch (error) {
        console.error('Reviews page error:', error);
        res.render('reviews', {
            title: 'Reviews - Bitcoin Review Raffle',
            error: 'Failed to load reviews',
            reviews: [],
            featuredReviews: [],
            regularReviews: [],
            donationAddress: process.env.DONATION_ADDRESS || 'Not configured'
        });
    }
});

/**
 * GET /raffles
 * Public raffle history page — transparent, verifiable results
 */
router.get('/raffles', (req, res) => {
    try {
        const raffles = db.getAllRaffles();

        // Use cached deposit info (instant, no LND API call)
        const depositInfo = lightning.getDepositInfoCached();
        
        res.render('raffles', {
            title: 'Raffle History - Bitcoin Review Raffle',
            raffles,
            donationAddress: depositInfo.onchainAddress || process.env.DONATION_ADDRESS || 'Not configured'
        });
    } catch (error) {
        console.error('Raffles page error:', error);
        res.render('raffles', {
            title: 'Raffle History - Bitcoin Review Raffle',
            error: 'Failed to load raffle history',
            raffles: [],
            donationAddress: process.env.DONATION_ADDRESS || 'Not configured'
        });
    }
});

/**
 * GET /how-it-works
 * How it works page
 */
router.get('/how-it-works', async (req, res) => {
    try {
        const raffleInfo = await bitcoin.getRaffleInfo();

        // Use cached deposit info (instant, no LND API call)
        const depositInfo = lightning.getDepositInfoCached();
        
        res.render('how-it-works', {
            title: 'How It Works - Bitcoin Review Raffle',
            raffleInfo,
            donationAddress: depositInfo.onchainAddress || process.env.DONATION_ADDRESS || 'Not configured'
        });
    } catch (error) {
        res.render('how-it-works', {
            title: 'How It Works - Bitcoin Review Raffle',
            donationAddress: process.env.DONATION_ADDRESS || 'Not configured'
        });
    }
});

/**
 * GET /claim/:token
 * Claim page — winner sees QR code to withdraw prize via LNURL-withdraw
 */
router.get('/claim/:token', (req, res) => {
    try {
        const { token } = req.params;
        const raffle = db.findRaffleByClaimToken(token);
        
        if (!raffle) {
            return res.render('claim', {
                title: 'Claim Prize - Bitcoin Review Raffle',
                error: 'Invalid or unknown claim link',
                raffle: null,
                lnurlEncoded: null
            });
        }
        
        // Check expiry
        if (raffle.claim_status === 'pending' && raffle.claim_expires_at && new Date(raffle.claim_expires_at) < new Date()) {
            db.markRaffleClaimExpired(raffle.id);
            raffle.claim_status = 'expired';
        }
        
        // Generate LNURL-withdraw encoded string for QR code
        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
        const withdrawUrl = `${baseUrl}/api/lnurl/withdraw/${token}`;
        const lnurlEncoded = encodeLnurl(withdrawUrl);
        
        res.render('claim', {
            title: 'Claim Your Prize - Bitcoin Review Raffle',
            raffle,
            lnurlEncoded,
            error: null
        });
    } catch (error) {
        console.error('Claim page error:', error);
        res.render('claim', {
            title: 'Claim Prize - Bitcoin Review Raffle',
            error: 'Something went wrong loading this page',
            raffle: null,
            lnurlEncoded: null
        });
    }
});

/**
 * GET /admin/review/:id
 * Quick-review page for a single ticket (used by Telegram "View" link)
 * Accepts password in query OR TELEGRAM_APPROVE_TOKEN
 */
router.get('/admin/review/:id', (req, res) => {
    const { id } = req.params;
    const password = req.query.password;
    const token = req.query.token;
    
    // Accept either admin password or Telegram approve token
    const isAdmin = password && password === process.env.ADMIN_PASSWORD;
    const isToken = process.env.TELEGRAM_APPROVE_TOKEN && (token === process.env.TELEGRAM_APPROVE_TOKEN || password === process.env.TELEGRAM_APPROVE_TOKEN);
    
    if (!isAdmin && !isToken) {
        return res.render('admin-login', {
            title: 'Admin Login - Bitcoin Review Raffle'
        });
    }
    
    try {
        const ticket = db.getTicketById(parseInt(id));
        
        if (!ticket) {
            return res.status(404).render('404', { title: 'Not Found' });
        }
        
        // Use the token/password that was passed so approve buttons work
        res.render('admin-review', {
            title: `Review #${id} - Admin`,
            ticket,
            password: isAdmin ? password : null,
            approveToken: process.env.TELEGRAM_APPROVE_TOKEN || token || '',
            isAdminAuth: isAdmin,
            baseUrl: process.env.BASE_URL || ''
        });
    } catch (error) {
        console.error('Admin review page error:', error);
        res.status(500).render('error', { title: 'Error', error: 'Failed to load review' });
    }
});

/**
 * GET /admin
 * Admin dashboard page (requires password in query)
 */
router.get('/admin', async (req, res) => {
    const password = req.query.password;
    
    if (!password || password !== process.env.ADMIN_PASSWORD) {
        return res.render('admin-login', {
            title: 'Admin Login - Bitcoin Review Raffle'
        });
    }
    
    try {
        const users = db.getAllUsers();
        const tickets = db.getAllTickets();
        const pendingTickets = db.getPendingTickets();
        const raffles = db.getAllRaffles();
        const raffleInfo = await bitcoin.getRaffleInfo();
        
        res.render('admin', {
            title: 'Admin Dashboard - Bitcoin Review Raffle',
            password,
            users,
            tickets,
            pendingTickets,
            raffles,
            raffleInfo
        });
    } catch (error) {
        console.error('Admin page error:', error);
        res.render('admin', {
            title: 'Admin Dashboard - Bitcoin Review Raffle',
            password,
            error: 'Failed to load admin data'
        });
    }
});

module.exports = router;
