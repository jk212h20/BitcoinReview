/**
 * Location Registry
 *
 * Each entry defines a community mini-site served at /:slug
 * All locations share one raffle, one database, one LND node.
 *
 * To add a new city:
 *   1. Add an entry here with BTCMap bounding box(es)
 *   2. Deploy — the routes are auto-generated
 *
 * Find bounding boxes at: https://btcmap.org (draw a rectangle around the area)
 * or via API: https://api.btcmap.org/v2/areas
 */
module.exports = [
    {
        slug: 'roatan',
        name: 'Roatan',
        region: 'Bay Islands, Honduras',
        tagline: 'Bitcoin on the island!',
        emoji: '🏝',
        heroText: 'Review Bitcoin merchants in the Bay Islands, win sats!',
        footerMadeIn: 'Made with ⚡ in Roatan',
        description: 'Incentivizing Bitcoin adoption in Roatan through community reviews.',
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
        isDefault: true  // Serves at / as well as /roatan
    },
    {
        slug: 'austin',
        name: 'Austin',
        enabled: false,  // Flip to true (or remove this line) to re-enable /austin
        region: 'Texas, USA',
        tagline: 'Keep Austin Bitcoin!',
        emoji: '🤠',
        heroText: 'Review Bitcoin merchants in Austin, win sats!',
        footerMadeIn: 'Made with ⚡ in Austin',
        description: 'Incentivizing Bitcoin adoption in Austin through community reviews.',
        merchantAreas: [
            {
                name: 'Austin',
                bounds: {
                    minLat: 30.15,
                    maxLat: 30.52,
                    minLon: -97.95,
                    maxLon: -97.55
                }
            }
        ],
        isDefault: false
    }
];
