/**
 * Location mini-site routes
 * 
 * Each location in locations.config.js gets a full set of pages:
 *   /:slug           — Landing page
 *   /:slug/submit    — Submit review (pre-tagged with location)
 *   /:slug/merchants — Local merchant list
 *   /:slug/reviews   — Reviews from this location
 *   /:slug/raffles   — Raffle history (global — one raffle for all)
 *   /:slug/how-it-works — How it works with local flavor
 */

const express = require('express');
const router = express.Router();
const { bech32 } = require('bech32');

const allLocations = require('../../locations.config');
const db = require('../services/database');
const bitcoin = require('../services/bitcoin');
const btcmap = require('../services/btcmap');
const lightning = require('../services/lightning');

// Filter to only enabled locations (enabled defaults to true if not specified)
const locations = allLocations.filter(loc => loc.enabled !== false);

// Build a lookup map: slug → location config
const locationMap = {};
for (const loc of locations) {
    locationMap[loc.slug] = loc;
}

// Export for use by other modules (e.g., index.js to inject into res.locals)
router.locationMap = locationMap;
router.locations = locations;

// Debug: log available locations on startup
console.log('📍 Location routes loaded:', Object.keys(locationMap).join(', '));

/**
 * Middleware: resolve location from :slug param
 * Attaches `req.location` if valid, 404s otherwise
 */
function resolveLocation(req, res, next) {
    const slug = req.params.slug;
    const location = locationMap[slug];
    if (!location) {
        return next('route'); // Skip this route entirely — fall through to pageRoutes/404
    }
    req.location = location;
    res.locals.location = location;
    res.locals.allLocations = locations;
    next();
}

/**
 * Helper: get common page data (deposit info, donation address)
 */
function getCommonData() {
    const depositInfo = lightning.getDepositInfoCached();
    return {
        donationAddress: depositInfo.onchainAddress || process.env.DONATION_ADDRESS || 'Not configured'
    };
}

/**
 * GET /:slug
 * Location landing page
 */
router.get('/:slug', resolveLocation, async (req, res) => {
    const loc = req.location;
    try {
        const raffleInfo = await bitcoin.getRaffleInfo();
        const userCount = db.getUserCount();
        const ticketCount = db.countValidTicketsForBlock(raffleInfo.nextRaffleBlock);
        const latestRaffle = db.getLatestRaffle();
        const allRaffles = db.getAllRaffles();
        const depositInfo = lightning.getDepositInfoCached();
        const totalDonations = db.getTotalDonationsReceived();
        const recentlyReviewedMerchant = db.getMostRecentlyReviewedMerchantByLocation(loc.slug);

        res.render('index', {
            title: `Bitcoin Review Raffle - ${loc.name}`,
            raffleInfo,
            userCount,
            ticketCount,
            latestRaffle,
            totalRaffles: allRaffles.length,
            recentlyReviewedMerchant,
            onchainAddress: depositInfo.onchainAddress,
            lightningInvoice: depositInfo.lightningInvoice,
            totalDonationsSats: totalDonations,
            donationAddress: depositInfo.onchainAddress || process.env.DONATION_ADDRESS || 'Not configured',
            location: loc,
            allLocations: locations
        });
    } catch (error) {
        console.error(`Location landing page error (${loc.slug}):`, error);
        res.render('index', {
            title: `Bitcoin Review Raffle - ${loc.name}`,
            error: 'Failed to load raffle info',
            raffleInfo: null, userCount: 0, ticketCount: 0,
            latestRaffle: null, totalRaffles: 0,
            recentlyReviewedMerchant: null,
            onchainAddress: null, lightningInvoice: null,
            totalDonationsSats: 0,
            donationAddress: process.env.DONATION_ADDRESS || 'Not configured',
            location: loc,
            allLocations: locations
        });
    }
});

/**
 * GET /:slug/submit
 * Submit review page for this location
 */
router.get('/:slug/submit', resolveLocation, async (req, res) => {
    const loc = req.location;
    try {
        const raffleInfo = await bitcoin.getRaffleInfo();
        const depositInfo = lightning.getDepositInfoCached();

        // Load local merchants for the searchable dropdown
        let merchants = [];
        try {
            merchants = await btcmap.getMerchantsForAreas(loc.merchantAreas);
        } catch (err) {
            console.warn(`Could not load merchants for ${loc.slug} submit page:`, err.message);
        }

        res.render('submit', {
            title: `Submit Review - ${loc.name} - Bitcoin Review Raffle`,
            raffleInfo,
            merchants,
            donationAddress: depositInfo.onchainAddress || process.env.DONATION_ADDRESS || 'Not configured',
            location: loc,
            allLocations: locations
        });
    } catch (error) {
        console.error(`Submit page error (${loc.slug}):`, error);
        res.render('submit', {
            title: `Submit Review - ${loc.name} - Bitcoin Review Raffle`,
            error: 'Failed to load page data',
            merchants: [],
            donationAddress: process.env.DONATION_ADDRESS || 'Not configured',
            location: loc,
            allLocations: locations
        });
    }
});

/**
 * GET /:slug/merchants
 * Local merchant list
 */
router.get('/:slug/merchants', resolveLocation, async (req, res) => {
    const loc = req.location;
    try {
        const merchants = await btcmap.getMerchantsForAreas(loc.merchantAreas);
        const depositInfo = lightning.getDepositInfoCached();

        // Get approved tickets to annotate merchants with review dates
        const approvedTickets = db.getApprovedPublicTicketsByLocation(loc.slug);
        const lastReviewedMap = {};
        for (const t of approvedTickets) {
            if (!t.merchant_name) continue;
            const name = t.merchant_name.trim();
            if (!lastReviewedMap[name] || t.submitted_at > lastReviewedMap[name]) {
                lastReviewedMap[name] = t.submitted_at;
            }
        }

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
            title: `Bitcoin Merchants - ${loc.name}`,
            merchants: annotated,
            donationAddress: depositInfo.onchainAddress || process.env.DONATION_ADDRESS || 'Not configured',
            location: loc,
            allLocations: locations
        });
    } catch (error) {
        console.error(`Merchants page error (${loc.slug}):`, error);
        res.render('merchants', {
            title: `Bitcoin Merchants - ${loc.name}`,
            error: 'Failed to load merchants',
            merchants: [],
            donationAddress: process.env.DONATION_ADDRESS || 'Not configured',
            location: loc,
            allLocations: locations
        });
    }
});

/**
 * GET /:slug/reviews
 * Reviews for this location
 */
router.get('/:slug/reviews', resolveLocation, (req, res) => {
    const loc = req.location;
    try {
        // Show location-specific reviews + all global reviews (for now)
        const reviews = db.getApprovedPublicTicketsByLocation(loc.slug);
        const featuredReviews = reviews.filter(r => r.is_featured);
        const regularReviews = reviews.filter(r => !r.is_featured);
        const depositInfo = lightning.getDepositInfoCached();

        res.render('reviews', {
            title: `Reviews - ${loc.name} - Bitcoin Review Raffle`,
            reviews,
            featuredReviews,
            regularReviews,
            donationAddress: depositInfo.onchainAddress || process.env.DONATION_ADDRESS || 'Not configured',
            location: loc,
            allLocations: locations
        });
    } catch (error) {
        console.error(`Reviews page error (${loc.slug}):`, error);
        res.render('reviews', {
            title: `Reviews - ${loc.name} - Bitcoin Review Raffle`,
            error: 'Failed to load reviews',
            reviews: [], featuredReviews: [], regularReviews: [],
            donationAddress: process.env.DONATION_ADDRESS || 'Not configured',
            location: loc,
            allLocations: locations
        });
    }
});

/**
 * GET /:slug/raffles
 * Raffle history (global — one raffle for all locations)
 */
router.get('/:slug/raffles', resolveLocation, (req, res) => {
    const loc = req.location;
    try {
        const raffles = db.getAllRaffles();
        const depositInfo = lightning.getDepositInfoCached();

        res.render('raffles', {
            title: `Raffle History - ${loc.name} - Bitcoin Review Raffle`,
            raffles,
            donationAddress: depositInfo.onchainAddress || process.env.DONATION_ADDRESS || 'Not configured',
            location: loc,
            allLocations: locations
        });
    } catch (error) {
        console.error(`Raffles page error (${loc.slug}):`, error);
        res.render('raffles', {
            title: `Raffle History - ${loc.name} - Bitcoin Review Raffle`,
            error: 'Failed to load raffle history',
            raffles: [],
            donationAddress: process.env.DONATION_ADDRESS || 'Not configured',
            location: loc,
            allLocations: locations
        });
    }
});

/**
 * GET /:slug/how-it-works
 * How it works with local flavor
 */
router.get('/:slug/how-it-works', resolveLocation, async (req, res) => {
    const loc = req.location;
    try {
        const raffleInfo = await bitcoin.getRaffleInfo();
        const depositInfo = lightning.getDepositInfoCached();

        res.render('how-it-works', {
            title: `How It Works - ${loc.name} - Bitcoin Review Raffle`,
            raffleInfo,
            donationAddress: depositInfo.onchainAddress || process.env.DONATION_ADDRESS || 'Not configured',
            location: loc,
            allLocations: locations
        });
    } catch (error) {
        res.render('how-it-works', {
            title: `How It Works - ${loc.name} - Bitcoin Review Raffle`,
            donationAddress: process.env.DONATION_ADDRESS || 'Not configured',
            location: loc,
            allLocations: locations
        });
    }
});

module.exports = router;
