/**
 * Page routes for frontend views
 */

const express = require('express');
const router = express.Router();

const db = require('../services/database');
const bitcoin = require('../services/bitcoin');
const btcmap = require('../services/btcmap');

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
        
        res.render('index', {
            title: 'Bitcoin Review Raffle - Roatan',
            raffleInfo,
            userCount,
            ticketCount,
            latestRaffle,
            donationAddress: process.env.DONATION_ADDRESS || 'Not configured'
        });
    } catch (error) {
        console.error('Landing page error:', error);
        res.render('index', {
            title: 'Bitcoin Review Raffle - Roatan',
            error: 'Failed to load raffle info',
            donationAddress: process.env.DONATION_ADDRESS || 'Not configured'
        });
    }
});

/**
 * GET /submit
 * Review submission page
 */
router.get('/submit', async (req, res) => {
    try {
        const raffleInfo = await bitcoin.getRaffleInfo();
        const merchants = await btcmap.getMerchantList();
        
        res.render('submit', {
            title: 'Submit Review - Bitcoin Review Raffle',
            raffleInfo,
            merchants
        });
    } catch (error) {
        console.error('Submit page error:', error);
        res.render('submit', {
            title: 'Submit Review - Bitcoin Review Raffle',
            error: 'Failed to load page data',
            merchants: []
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
        
        res.render('merchants', {
            title: 'Bitcoin Merchants - Roatan',
            merchants
        });
    } catch (error) {
        console.error('Merchants page error:', error);
        res.render('merchants', {
            title: 'Bitcoin Merchants - Roatan',
            error: 'Failed to load merchants',
            merchants: []
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
 * GET /how-it-works
 * How it works page
 */
router.get('/how-it-works', async (req, res) => {
    try {
        const raffleInfo = await bitcoin.getRaffleInfo();
        
        res.render('how-it-works', {
            title: 'How It Works - Bitcoin Review Raffle',
            raffleInfo
        });
    } catch (error) {
        res.render('how-it-works', {
            title: 'How It Works - Bitcoin Review Raffle'
        });
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
