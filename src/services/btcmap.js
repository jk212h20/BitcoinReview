/**
 * BTCMap.org API service
 * Fetches Bitcoin-accepting merchants
 */

const BTCMAP_API = 'https://api.btcmap.org/v2';

// Cache for merchants (refresh every hour)
let merchantCache = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

/**
 * Fetch all Bitcoin merchants from BTCMap
 * Optionally filter by area (e.g., Roatan)
 */
async function fetchMerchants(options = {}) {
    const now = Date.now();
    
    // Return cached data if fresh
    if (merchantCache && (now - cacheTimestamp) < CACHE_DURATION) {
        return filterMerchants(merchantCache, options);
    }
    
    try {
        const response = await fetch(`${BTCMAP_API}/elements`);
        if (!response.ok) {
            throw new Error('Failed to fetch merchants from BTCMap');
        }
        
        const data = await response.json();
        merchantCache = data;
        cacheTimestamp = now;
        
        return filterMerchants(data, options);
    } catch (error) {
        console.error('BTCMap API error:', error.message);
        // Return cached data even if stale, or empty array
        return merchantCache ? filterMerchants(merchantCache, options) : [];
    }
}

/**
 * Filter merchants by various criteria
 */
function filterMerchants(merchants, options = {}) {
    let filtered = merchants;
    
    // Filter by bounding box (for Roatan area)
    if (options.bounds) {
        const { minLat, maxLat, minLon, maxLon } = options.bounds;
        filtered = filtered.filter(m => {
            const lat = m.osm_json?.lat;
            const lon = m.osm_json?.lon;
            if (!lat || !lon) return false;
            return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
        });
    }
    
    // Filter by country/region in tags
    if (options.country) {
        filtered = filtered.filter(m => {
            const tags = m.osm_json?.tags || {};
            const addr = tags['addr:country'] || tags['addr:state'] || '';
            return addr.toLowerCase().includes(options.country.toLowerCase());
        });
    }
    
    // Search by name
    if (options.search) {
        const searchLower = options.search.toLowerCase();
        filtered = filtered.filter(m => {
            const name = m.osm_json?.tags?.name || '';
            return name.toLowerCase().includes(searchLower);
        });
    }
    
    return filtered;
}

/**
 * Get merchants in Roatan, Honduras area
 * Roatan approximate bounds: 16.25-16.45 lat, -86.6 to -86.2 lon
 */
async function getRoatanMerchants() {
    return fetchMerchants({
        bounds: {
            minLat: 16.20,
            maxLat: 16.50,
            minLon: -86.70,
            maxLon: -86.10
        }
    });
}

/**
 * Get all Honduras merchants (broader search)
 */
async function getHondurasMerchants() {
    return fetchMerchants({
        bounds: {
            minLat: 13.0,
            maxLat: 17.0,
            minLon: -90.0,
            maxLon: -83.0
        }
    });
}

/**
 * Format merchant for display
 */
function formatMerchant(merchant) {
    const tags = merchant.osm_json?.tags || {};
    
    return {
        id: merchant.id,
        name: tags.name || 'Unknown',
        type: tags.amenity || tags.shop || tags.tourism || 'business',
        address: formatAddress(tags),
        lat: merchant.osm_json?.lat,
        lon: merchant.osm_json?.lon,
        phone: tags.phone || tags['contact:phone'],
        website: tags.website || tags['contact:website'],
        lightning: tags['payment:lightning'] === 'yes',
        onchain: tags['payment:onchain'] === 'yes' || tags['payment:bitcoin'] === 'yes',
        openingHours: tags.opening_hours
    };
}

/**
 * Format address from OSM tags
 */
function formatAddress(tags) {
    const parts = [];
    if (tags['addr:housenumber']) parts.push(tags['addr:housenumber']);
    if (tags['addr:street']) parts.push(tags['addr:street']);
    if (tags['addr:city']) parts.push(tags['addr:city']);
    if (tags['addr:state']) parts.push(tags['addr:state']);
    if (tags['addr:country']) parts.push(tags['addr:country']);
    return parts.join(', ') || null;
}

/**
 * Get formatted merchant list for display
 */
async function getMerchantList() {
    const merchants = await getRoatanMerchants();
    return merchants.map(formatMerchant);
}

/**
 * Search merchants by name
 */
async function searchMerchants(query) {
    const merchants = await getRoatanMerchants();
    const filtered = merchants.filter(m => {
        const name = m.osm_json?.tags?.name || '';
        return name.toLowerCase().includes(query.toLowerCase());
    });
    return filtered.map(formatMerchant);
}

module.exports = {
    fetchMerchants,
    getRoatanMerchants,
    getHondurasMerchants,
    getMerchantList,
    searchMerchants,
    formatMerchant
};
