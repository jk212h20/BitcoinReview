/**
 * Bitcoin Review Raffle - Main Application
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');

// Import services
const db = require('./services/database');
const email = require('./services/email');
const anthropic = require('./services/anthropic');
const bitcoin = require('./services/bitcoin');
const lightning = require('./services/lightning');

// Import routes
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const pageRoutes = require('./routes/pages');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Rate limiting for API endpoints
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: { error: 'Too many requests, please try again later.' }
});

const registrationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // Limit each IP to 10 registrations per hour
    message: { error: 'Too many registration attempts, please try again later.' }
});

// Apply rate limiting
app.use('/api', apiLimiter);
app.use('/api/register', registrationLimiter);

// Routes
app.use('/api', apiRoutes);
app.use('/api/admin', adminRoutes);
app.use('/', pageRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    
    if (req.path.startsWith('/api')) {
        return res.status(500).json({ error: 'Internal server error' });
    }
    
    res.status(500).render('error', {
        title: 'Error - Bitcoin Review Raffle',
        error: 'Something went wrong. Please try again.'
    });
});

// 404 handler
app.use((req, res) => {
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ error: 'Not found' });
    }
    
    res.status(404).render('404', {
        title: 'Not Found - Bitcoin Review Raffle'
    });
});

// Initialize services and start server
async function startServer() {
    console.log('🚀 Starting Bitcoin Review Raffle...');
    
    await db.initializeDatabase();
    email.initializeEmail();
    anthropic.initializeAnthropic();
    
    // Pre-warm the raffle info cache BEFORE accepting requests
    try {
        await bitcoin.warmCache();
        const info = await bitcoin.getRaffleInfo();
        console.log(`⛏️  Block height: ${info.currentHeight} | Next raffle: ${info.nextRaffleBlock}`);
    } catch (err) {
        console.warn('⚠️  Failed to pre-warm raffle cache:', err.message);
    }
    
    // Pre-warm deposit address cache from Voltage node
    try {
        const depositInfo = await lightning.getDepositInfo();
        if (depositInfo.onchainAddress) {
            console.log(`💰 On-chain deposit address: ${depositInfo.onchainAddress.substring(0, 16)}...`);
        }
        if (depositInfo.lightningInvoice) {
            console.log(`⚡ Lightning invoice cached (${depositInfo.lightningInvoice.substring(0, 20)}...)`);
        }
    } catch (err) {
        console.warn('⚠️  Failed to pre-warm deposit addresses:', err.message);
    }
    
    // Poll for incoming payments every 5 minutes
    setInterval(async () => {
        try {
            await lightning.checkForDeposits();
        } catch (err) {
            console.warn('Payment poll error:', err.message);
        }
    }, 5 * 60 * 1000);
    
    app.listen(PORT, () => {
        console.log(`✅ Server running on http://localhost:${PORT}`);
        console.log(`📊 Admin dashboard: http://localhost:${PORT}/admin`);
    });
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

module.exports = app;
