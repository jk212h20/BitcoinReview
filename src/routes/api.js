/**
 * API routes for registration and review submission
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const db = require('../services/database');
const email = require('../services/email');
const bitcoin = require('../services/bitcoin');
const anthropic = require('../services/anthropic');
const btcmap = require('../services/btcmap');

/**
 * POST /api/register
 * Register a new user with email and LNURL
 */
router.post('/register', async (req, res) => {
    try {
        const { email: userEmail, lnurl } = req.body;
        
        // Validate inputs
        if (!userEmail || !lnurl) {
            return res.status(400).json({
                success: false,
                error: 'Email and LNURL address are required'
            });
        }
        
        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(userEmail)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid email address'
            });
        }
        
        // Basic LNURL validation (lightning address or lnurl)
        const isLightningAddress = userEmail.includes('@') || lnurl.includes('@');
        const isLnurl = lnurl.toLowerCase().startsWith('lnurl');
        if (!isLightningAddress && !isLnurl && !lnurl.includes('@')) {
            return res.status(400).json({
                success: false,
                error: 'Invalid LNURL or Lightning address'
            });
        }
        
        // Generate opt-out token
        const optOutToken = uuidv4();
        
        // Create user
        const result = db.createUser(userEmail.toLowerCase(), lnurl, optOutToken);
        
        if (result.error) {
            return res.status(400).json({
                success: false,
                error: result.error
            });
        }
        
        // Send confirmation email (async, don't wait)
        email.sendRegistrationEmail(userEmail, optOutToken).catch(err => {
            console.error('Failed to send registration email:', err);
        });
        
        res.json({
            success: true,
            message: 'Registration successful! Check your email for confirmation.'
        });
        
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({
            success: false,
            error: 'Registration failed. Please try again.'
        });
    }
});

/**
 * POST /api/submit-review
 * Submit a review for raffle entry
 */
router.post('/submit-review', async (req, res) => {
    try {
        const { email: userEmail, reviewLink, reviewText, merchantName } = req.body;
        
        // Validate inputs
        if (!userEmail || !reviewLink) {
            return res.status(400).json({
                success: false,
                error: 'Email and review link are required'
            });
        }
        
        if (!reviewText || reviewText.trim().length < 20) {
            return res.status(400).json({
                success: false,
                error: 'Please include your review text (at least 20 characters)'
            });
        }
        
        // Find user
        const user = db.findUserByEmail(userEmail.toLowerCase());
        if (!user) {
            return res.status(400).json({
                success: false,
                error: 'Email not registered. Please register first.'
            });
        }
        
        // Check if review already submitted
        const existingTicket = db.findTicketByUserAndLink(user.id, reviewLink);
        if (existingTicket) {
            return res.status(400).json({
                success: false,
                error: 'This review has already been submitted'
            });
        }
        
        // Validate Google review URL
        if (!anthropic.isValidGoogleReviewUrl(reviewLink)) {
            return res.status(400).json({
                success: false,
                error: 'Please provide a valid Google Maps/Reviews link'
            });
        }
        
        // Get current raffle block
        const currentHeight = await bitcoin.getCurrentBlockHeight();
        const raffleBlock = bitcoin.getNextRaffleBlock(currentHeight);
        
        // Create ticket (pending validation)
        const ticket = db.createTicket(
            user.id,
            reviewLink,
            reviewText,
            merchantName || null,
            raffleBlock
        );
        
        // Validate review with AI
        const validation = await anthropic.validateReview(reviewText, merchantName);
        
        // Update ticket with validation result
        db.validateTicket(ticket.id, validation.isValid, validation.reason);
        
        if (validation.isValid) {
            res.json({
                success: true,
                message: 'Review submitted and validated! You are entered in the raffle.',
                raffleBlock,
                ticketId: ticket.id
            });
        } else {
            res.json({
                success: false,
                error: `Review not validated: ${validation.reason}`,
                ticketId: ticket.id
            });
        }
        
    } catch (error) {
        console.error('Submit review error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to submit review. Please try again.'
        });
    }
});

/**
 * GET /api/merchants
 * Get list of Bitcoin merchants in Roatan
 */
router.get('/merchants', async (req, res) => {
    try {
        const merchants = await btcmap.getMerchantList();
        res.json({
            success: true,
            merchants,
            count: merchants.length
        });
    } catch (error) {
        console.error('Merchants fetch error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch merchants'
        });
    }
});

/**
 * GET /api/raffle-info
 * Get current raffle information
 */
router.get('/raffle-info', async (req, res) => {
    try {
        const info = await bitcoin.getRaffleInfo();
        const ticketCount = db.countValidTicketsForBlock(info.nextRaffleBlock);
        const latestRaffle = db.getLatestRaffle();
        
        res.json({
            success: true,
            ...info,
            ticketCount,
            latestRaffle: latestRaffle ? {
                blockHeight: latestRaffle.block_height,
                totalTickets: latestRaffle.total_tickets,
                prizeAmount: latestRaffle.prize_amount_sats,
                winnerEmail: latestRaffle.email ? 
                    latestRaffle.email.replace(/(.{2}).*(@.*)/, '$1***$2') : null
            } : null
        });
    } catch (error) {
        console.error('Raffle info error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch raffle info'
        });
    }
});

/**
 * GET /api/stats
 * Get public statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const userCount = db.getUserCount();
        const raffles = db.getAllRaffles();
        const info = await bitcoin.getRaffleInfo();
        const ticketCount = db.countValidTicketsForBlock(info.nextRaffleBlock);
        
        res.json({
            success: true,
            stats: {
                registeredUsers: userCount,
                currentRaffleTickets: ticketCount,
                totalRaffles: raffles.length,
                nextRaffleBlock: info.nextRaffleBlock,
                blocksUntilRaffle: info.blocksUntilNext,
                timeEstimate: info.timeEstimate
            }
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch stats'
        });
    }
});

module.exports = router;
