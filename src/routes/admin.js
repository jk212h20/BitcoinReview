/**
 * Admin routes for managing raffles and tickets
 */

const express = require('express');
const router = express.Router();

const db = require('../services/database');
const bitcoin = require('../services/bitcoin');
const email = require('../services/email');

/**
 * Simple password authentication middleware
 */
function adminAuth(req, res, next) {
    const password = req.query.password || req.body.password || req.headers['x-admin-password'];
    
    if (!process.env.ADMIN_PASSWORD) {
        return res.status(500).json({ error: 'Admin password not configured' });
    }
    
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    next();
}

// Apply auth to all admin routes
router.use(adminAuth);

/**
 * GET /admin/dashboard
 * Get admin dashboard data
 */
router.get('/dashboard', async (req, res) => {
    try {
        const users = db.getAllUsers();
        const tickets = db.getAllTickets();
        const pendingTickets = db.getPendingTickets();
        const raffles = db.getAllRaffles();
        const raffleInfo = await bitcoin.getRaffleInfo();
        
        res.json({
            success: true,
            data: {
                users: {
                    total: users.length,
                    list: users.slice(0, 50) // Last 50
                },
                tickets: {
                    total: tickets.length,
                    pending: pendingTickets.length,
                    list: tickets.slice(0, 50)
                },
                raffles: {
                    total: raffles.length,
                    list: raffles
                },
                blockchain: raffleInfo
            }
        });
    } catch (error) {
        console.error('Admin dashboard error:', error);
        res.status(500).json({ error: 'Failed to load dashboard' });
    }
});

/**
 * GET /admin/users
 * Get all registered users
 */
router.get('/users', (req, res) => {
    try {
        const users = db.getAllUsers();
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

/**
 * GET /admin/tickets
 * Get all tickets
 */
router.get('/tickets', (req, res) => {
    try {
        const tickets = db.getAllTickets();
        res.json({ success: true, tickets });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch tickets' });
    }
});

/**
 * GET /admin/tickets/pending
 * Get pending tickets needing validation
 */
router.get('/tickets/pending', (req, res) => {
    try {
        const tickets = db.getPendingTickets();
        res.json({ success: true, tickets });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch pending tickets' });
    }
});

/**
 * POST /admin/tickets/:id/validate
 * Manually validate or reject a ticket
 */
router.post('/tickets/:id/validate', (req, res) => {
    try {
        const { id } = req.params;
        const { isValid, reason } = req.body;
        
        const ticket = db.getTicketById(parseInt(id));
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found' });
        }
        
        db.validateTicket(parseInt(id), isValid, reason || 'Manual validation');
        
        res.json({
            success: true,
            message: `Ticket ${isValid ? 'approved' : 'rejected'}`
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to validate ticket' });
    }
});

/**
 * POST /admin/raffle/run
 * Run the raffle for a specific block
 */
router.post('/raffle/run', async (req, res) => {
    try {
        const { blockHeight, prizeAmountSats } = req.body;
        
        if (!blockHeight) {
            return res.status(400).json({ error: 'Block height required' });
        }
        
        // Check if raffle already run for this block
        const existingRaffle = db.findRaffleByBlock(blockHeight);
        if (existingRaffle) {
            return res.status(400).json({ 
                error: 'Raffle already run for this block',
                raffle: existingRaffle
            });
        }
        
        // Check if block has been mined
        const isMined = await bitcoin.isRaffleBlockMined(blockHeight);
        if (!isMined) {
            return res.status(400).json({ error: 'Block has not been mined yet' });
        }
        
        // Get block hash
        const blockHash = await bitcoin.getBlockHash(blockHeight);
        
        // Get valid tickets for this raffle period
        const tickets = db.getValidTicketsForBlock(blockHeight);
        
        if (tickets.length === 0) {
            return res.status(400).json({ error: 'No valid tickets for this raffle period' });
        }
        
        // Select winner
        const winnerIndex = bitcoin.selectWinnerIndex(blockHash, tickets.length);
        const winningTicket = tickets[winnerIndex];
        
        // Create raffle record
        const raffle = db.createRaffle(
            blockHeight,
            blockHash,
            tickets.length,
            winnerIndex,
            winningTicket.id,
            prizeAmountSats || null
        );
        
        // Send winner email
        email.sendWinnerEmail(
            winningTicket.email,
            prizeAmountSats,
            winningTicket.lnurl_address,
            blockHeight
        ).catch(err => {
            console.error('Failed to send winner email:', err);
        });
        
        res.json({
            success: true,
            raffle: {
                id: raffle.id,
                blockHeight,
                blockHash,
                totalTickets: tickets.length,
                winnerIndex,
                winner: {
                    ticketId: winningTicket.id,
                    email: winningTicket.email,
                    lnurl: winningTicket.lnurl_address,
                    reviewLink: winningTicket.review_link
                },
                prizeAmountSats
            }
        });
        
    } catch (error) {
        console.error('Raffle run error:', error);
        res.status(500).json({ error: 'Failed to run raffle: ' + error.message });
    }
});

/**
 * POST /admin/raffle/:id/mark-paid
 * Mark a raffle as paid
 */
router.post('/raffle/:id/mark-paid', (req, res) => {
    try {
        const { id } = req.params;
        
        db.markRafflePaid(parseInt(id));
        
        res.json({
            success: true,
            message: 'Raffle marked as paid'
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to mark raffle as paid' });
    }
});

/**
 * GET /admin/raffles
 * Get all raffles
 */
router.get('/raffles', (req, res) => {
    try {
        const raffles = db.getAllRaffles();
        res.json({ success: true, raffles });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch raffles' });
    }
});

/**
 * GET /admin/raffle/next
 * Get info about the next raffle
 */
router.get('/raffle/next', async (req, res) => {
    try {
        const info = await bitcoin.getRaffleInfo();
        const ticketCount = db.countValidTicketsForBlock(info.nextRaffleBlock);
        const tickets = db.getValidTicketsForBlock(info.nextRaffleBlock);
        
        res.json({
            success: true,
            nextRaffle: {
                ...info,
                ticketCount,
                tickets: tickets.map(t => ({
                    id: t.id,
                    email: t.email.replace(/(.{2}).*(@.*)/, '$1***$2'),
                    merchantName: t.merchant_name,
                    submittedAt: t.submitted_at
                }))
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch next raffle info' });
    }
});

module.exports = router;
