/**
 * Site Configuration
 *
 * Edit this file to customize the site for your region.
 * All location-specific text, branding, and merchant areas are defined here.
 * No code changes needed — just update these values and deploy.
 */
module.exports = {
    // ── Branding ──
    siteName: 'Bitcoin Review Raffle',
    siteTagline: 'Write a review, win Bitcoin!',
    siteDescription: 'Incentivizing Bitcoin adoption through community reviews.',
    footerTagline: 'Incentivizing Bitcoin adoption in Roatan through community reviews.',
    footerMadeIn: 'Made with ⚡ in Roatan',

    // ── Icons & Emoji ──
    // Override these to customize the visual branding for your region.
    // SVG icon paths are relative to /public/icons/
    // The defaults are generic Bitcoin-themed (no location-specific imagery).
    icons: {
        logo: 'logo-bitcoin-palm.svg',     // Navbar logo (32x32). Default: 'logo-bitcoin.svg'
        hero: 'palm-tree.svg',             // Homepage hero icon (64x64). Default: 'hero-lightning.svg'
        footer: 'palm-tree.svg',           // Footer decoration. Default: 'hero-lightning.svg'
        notFound: 'lost-island.svg',       // 404 page. Default: '404-compass.svg'
    },
    emoji: {
        location: '🏝',    // Used next to location tags on merchants. Default: '📍'
        claim: '🌴⚡',     // Shown on claim success page. Default: '⚡'
    },

    // ── Location ──
    regionName: 'Bay Islands',       // Shown on merchants page header, etc.
    locations: ['Roatan', 'Utila'],  // Individual area names
    primaryLocation: 'Roatan',       // Default/main location for text
    timezone: 'America/Tegucigalpa', // For quiet hours (6pm-9am local)

    // ── Merchant Areas (BTCMap bounding boxes) ──
    // Each entry fetches merchants from BTCMap within its geographic bounds.
    // Find bounding boxes at: https://api.btcmap.org/v2/areas
    merchantAreas: [
        {
            name: 'Roatan',
            bounds: {
                minLat: 16.21599324835452,
                maxLat: 16.509832826905846,
                minLon: -86.6374969482422,
                maxLon: -86.22825622558594
            }
        },
        {
            name: 'Utila',
            bounds: {
                minLat: 16.06,
                maxLat: 16.13,
                minLon: -86.97,
                maxLon: -86.85
            }
        }
    ],

    // ── Theme Colors ──
    colors: {
        primary: '#f7931a',    // Bitcoin orange
        primaryDark: '#e8850f',
        accent: '#22c55e',     // Green
        ocean: '#0EA5E9',      // Blue accent
    },

    // ── How It Works — Step 1 text ──
    howItWorksStep1: 'Visit any merchant that accepts Bitcoin or Lightning payments.',
    howItWorksStep1Detail: 'This can be anywhere in the world, but we especially love supporting Roatan businesses!',
    howItWorksLocationNote: 'Check our merchant list for Bitcoin-accepting businesses in Roatan',
    howItWorksFaq: {
        locationRequired: false,
        locationFaqAnswer: 'No! You can review any Bitcoin-accepting merchant anywhere. We just have a special focus on Roatan.'
    },

    // ── Submit page ──
    submitTagline: 'Reviewed a Bitcoin-accepting merchant? Submit your review link to enter the raffle!',
    submitLocationNote: 'Only merchants on the Bitcoin map are eligible.',
    submitInstructions: 'Visit a Bitcoin-accepting merchant',

    // ── Reviews page ──
    reviewsSubtitle: 'Real experiences spending Bitcoin at local merchants',
    reviewsDefaultMerchant: 'Local Merchant',
    reviewsCta: 'Visited a Bitcoin merchant recently?',
};
