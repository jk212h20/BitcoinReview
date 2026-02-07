/**
 * API routes for the unified submission flow
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const db = require('../services/database');
const email = require('../services/email');
const bitcoin = require('../services/bitcoin');
const btcmap = require('../services/btcmap');

/**
 * POST /api/submit
 * Unified endpoint: accepts any combination of review link, email, ln address
 * Smart logic determines what to do based on what's provided
 */
router.post('/submit', async (req, res) => {
    try {
        const { email: userEmail, lnurl, reviewLink } = req.body;
        
        const hasEmail = userEmail && userEmail.trim().length > 0;
        const hasLnurl = lnurl && lnurl.trim().length > 0;
        const hasReview = reviewLink && reviewLink.trim().length > 0;
        
        // Review link is required
        if (!hasReview) {
            return res.status(400).json({
                success: false,
                error: 'Please provide your Google review link'
            });
        }
        
        // Validate email format if provided
        if (hasEmail) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(userEmail.trim())) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid email address format'
                });
            }
        }
        
        // Validate review link if provided
        if (hasReview) {
            const link = reviewLink.trim();
            // Accept any Google Maps/review-like URL
            const isValidLink = /google\.com\/maps|maps\.app\.goo\.gl|g\.page|goo\.gl\/maps/.test(link);
            if (!isValidLink) {
                return res.status(400).json({
                    success: false,
                    error: 'Please provide a valid Google Maps or Google Reviews link'
                });
            }
        }
        
        // --- Determine what to do based on provided fields ---
        
        const cleanEmail = hasEmail ? userEmail.trim().toLowerCase() : null;
        const cleanLnurl = hasLnurl ? lnurl.trim() : null;
        const cleanReview = hasReview ? reviewLink.trim() : null;
        
        let user = null;
        let userCreated = false;
        let ticketCreated = false;
        let hasRaffleTicket = false;
        let raffleBlock = null;
        
        // If we have email or lnurl, find or create user
        if (cleanEmail || cleanLnurl) {
            const optOutToken = uuidv4();
            const result = db.findOrCreateUser(cleanEmail, cleanLnurl, optOutToken);
            
            if (result.error) {
                return res.status(400).json({
                    success: false,
                    error: result.error
                });
            }
            
            user = result.user;
            userCreated = result.created;
            
            // Send registration email if new user with email
            if (userCreated && cleanEmail) {
                email.sendRegistrationEmail(cleanEmail, user.opt_out_token).catch(err => {
                    console.error('Failed to send registration email:', err);
                });
            }
        }
        
        // If we have a review link, create a ticket
        if (cleanReview) {
            // Check for duplicate review link for this user
            if (user) {
                const existingTicket = db.findTicketByUserAndLink(user.id, cleanReview);
                if (existingTicket) {
                    return res.status(400).json({
                        success: false,
                        error: 'This review has already been submitted'
                    });
                }
            }
            
            // Get current raffle block
            const currentHeight = await bitcoin.getCurrentBlockHeight();
            raffleBlock = bitcoin.getNextRaffleBlock(currentHeight);
            
            // A ticket gets a raffle entry if we have a user (email or lnurl)
            hasRaffleTicket = !!user;
            
            const ticket = db.createTicket(
                user ? user.id : null,
                cleanReview,
                null, // no review text needed
                null, // no merchant name needed
                raffleBlock
            );
            
            // Auto-validate if user has identity (email or lnurl)
            if (hasRaffleTicket) {
                db.validateTicket(ticket.id, true, 'Auto-validated: user identified');
            }
            
            ticketCreated = true;
        }
        
        // --- Build response message based on what happened ---
        const response = { success: true };
        
        if (cleanReview && hasRaffleTicket) {
            // Best case: review + identity = raffle ticket
            response.message = '🎉 Review submitted! You\'re entered in the raffle.';
            response.raffleTicket = true;
            response.raffleBlock = raffleBlock;
            
            if (!user.lnurl_address) {
                response.message += ' Add a Lightning address to receive prizes if you win!';
                response.needsLnurl = true;
            }
        } else if (cleanReview && !hasRaffleTicket) {
            // Review only, no identity
            response.message = 'Thanks for sharing your review! Add your email or Lightning address to enter the raffle.';
            response.raffleTicket = false;
            response.needsIdentity = true;
        } else if (!cleanReview && user) {
            // No review, just saving user info
            response.message = 'Info saved! Submit a Google review link to enter the raffle.';
            response.raffleTicket = false;
            response.needsReview = true;
        }
        
        res.json(response);
        
    } catch (error) {
        console.error('Submit error:', error);
        res.status(500).json({
            success: false,
            error: 'Something went wrong. Please try again.'
        });
    }
});

/**
 * POST /api/register (legacy - redirects to unified submit)
 */
router.post('/register', async (req, res) => {
    const { email: userEmail, lnurl } = req.body;
    // Forward to unified endpoint
    req.body.reviewLink = null;
    const { v4: uuidv4 } = require('uuid');
    
    try {
        if (!userEmail || !lnurl) {
            return res.status(400).json({
                success: false,
                error: 'Email and Lightning address are required'
            });
        }
        
        const optOutToken = uuidv4();
        const result = db.findOrCreateUser(userEmail.toLowerCase(), lnurl, optOutToken);
        
        if (result.error) {
            return res.status(400).json({ success: false, error: result.error });
        }
        
        if (result.created && userEmail) {
            email.sendRegistrationEmail(userEmail, result.user.opt_out_token).catch(err => {
                console.error('Failed to send registration email:', err);
            });
        }
        
        res.json({
            success: true,
            message: 'Registration successful! Check your email for confirmation.'
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ success: false, error: 'Registration failed. Please try again.' });
    }
});

/**
 * POST /api/submit-review (legacy - redirects to unified submit)
 */
router.post('/submit-review', async (req, res) => {
    req.body.lnurl = null;
    // Forward to the unified handler logic
    const { email: userEmail, reviewLink } = req.body;
    req.body = { email: userEmail, lnurl: null, reviewLink };
    
    // Just call the unified submit logic
    try {
        const hasEmail = userEmail && userEmail.trim().length > 0;
        const hasReview = reviewLink && reviewLink.trim().length > 0;
        
        if (!hasReview) {
            return res.status(400).json({ success: false, error: 'Review link is required' });
        }
        
        const cleanEmail = hasEmail ? userEmail.trim().toLowerCase() : null;
        const cleanReview = reviewLink.trim();
        
        let user = null;
        if (cleanEmail) {
            user = db.findUserByEmail(cleanEmail);
            if (!user) {
                return res.status(400).json({ success: false, error: 'Email not registered. Please register first.' });
            }
        }
        
        const currentHeight = await bitcoin.getCurrentBlockHeight();
        const raffleBlock = bitcoin.getNextRaffleBlock(currentHeight);
        
        const ticket = db.createTicket(user ? user.id : null, cleanReview, null, null, raffleBlock);
        if (user) {
            db.validateTicket(ticket.id, true, 'Auto-validated');
        }
        
        res.json({
            success: true,
            message: 'Review submitted and validated! You are entered in the raffle.',
            raffleBlock
        });
    } catch (error) {
        console.error('Submit review error:', error);
        res.status(500).json({ success: false, error: 'Failed to submit review. Please try again.' });
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
