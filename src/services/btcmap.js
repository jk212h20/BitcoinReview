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
 * Get coordinates for an element (handles both nodes and ways/relations)
 * Nodes have direct lat/lon, ways/relations have bounds
 */
function getElementCoords(element) {
    const osm = element.osm_json;
    if (!osm) return null;
    
    // Nodes have direct lat/lon
    if (osm.lat && osm.lon) {
        return { lat: osm.lat, lon: osm.lon };
    }
    
    // Ways/relations have bounds - use center point
    if (osm.bounds) {
        const b = osm.bounds;
        return {
            lat: (b.minlat + b.maxlat) / 2,
            lon: (b.minlon + b.maxlon) / 2
        };
    }
    
    return null;
}

/**
 * Filter merchants by various criteria
 */
function filterMerchants(merchants, options = {}) {
    let filtered = merchants;
    
    // Exclude deleted elements
    filtered = filtered.filter(m => !m.deleted_at || m.deleted_at === '');
    
    // Filter by bounding box (for Roatan area)
    // Supports both nodes (lat/lon) and ways/relations (bounds)
    if (options.bounds) {
        const { minLat, maxLat, minLon, maxLon } = options.bounds;
        filtered = filtered.filter(m => {
            const coords = getElementCoords(m);
            if (!coords) return false;
            return coords.lat >= minLat && coords.lat <= maxLat && coords.lon >= minLon && coords.lon <= maxLon;
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
 * Get merchants in the AmityAge community area (Roatan, Honduras)
 * Bounding box from BTCMap API: /v2/areas/amityage
 */
async function getRoatanMerchants() {
    return fetchMerchants({
        bounds: {
            minLat: 16.21599324835452,
            maxLat: 16.509832826905846,
            minLon: -86.6374969482422,
            maxLon: -86.22825622558594
        }
    });
}

/**
 * Get merchants on Utila island (Honduras Bay Islands)
 * Bounding box covers the main island area
 */
async function getUtilaMerchants() {
    return fetchMerchants({
        bounds: {
            minLat: 16.06,
            maxLat: 16.13,
            minLon: -86.97,
            maxLon: -86.85
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
 * @param {object} merchant - Raw BTCMap element
 * @param {string} [location] - Island/area name (e.g., "Roatan", "Utila")
 */
function formatMerchant(merchant, location) {
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
        openingHours: tags.opening_hours,
        location: location || null
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
 * Check if a merchant has valid, recent Bitcoin payment data
 * Requires: at least one payment method (lightning or onchain) = yes
 * AND a survey:date or check_date:currency:XBT within the last year
 */
function isValidBitcoinMerchant(merchant) {
    const tags = merchant.osm_json?.tags || {};
    
    // Must have at least one payment method confirmed as 'yes'
    const hasLightning = tags['payment:lightning'] === 'yes';
    const hasOnchain = tags['payment:onchain'] === 'yes' || tags['payment:bitcoin'] === 'yes';
    if (!hasLightning && !hasOnchain) return false;
    
    // Must have a recent survey/check date (within 2 years)
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 2);
    
    const surveyDate = tags['survey:date'] ? new Date(tags['survey:date']) : null;
    const checkDate = tags['check_date:currency:XBT'] ? new Date(tags['check_date:currency:XBT']) : null;
    
    // Use the most recent date available
    const dates = [surveyDate, checkDate].filter(d => d && !isNaN(d.getTime()));
    if (dates.length === 0) return false; // No valid date = exclude
    
    const mostRecent = dates.sort((a, b) => b - a)[0];
    return mostRecent >= oneYearAgo;
}

/**
 * Get formatted merchant list for a set of merchant areas.
 * Generic — works for any location's merchantAreas config.
 * Filters out merchants without confirmed payment methods or with stale data (>2 years).
 * Each merchant is tagged with its area name.
 *
 * @param {Array} merchantAreas - Array of { name, bounds } objects from locations.config.js
 *                                If not provided, falls back to default Roatan + Utila
 */
async function getMerchantsForAreas(merchantAreas) {
    // Fallback for backwards compatibility (existing callers with no args)
    if (!merchantAreas) {
        merchantAreas = [
            { name: 'Roatan', bounds: { minLat: 16.21599324835452, maxLat: 16.509832826905846, minLon: -86.6374969482422, maxLon: -86.22825622558594 } },
            { name: 'Utila', bounds: { minLat: 16.06, maxLat: 16.13, minLon: -86.97, maxLon: -86.85 } }
        ];
    }

    // Fetch all areas in parallel
    const rawResults = await Promise.all(
        merchantAreas.map(area => fetchMerchants({ bounds: area.bounds }).then(raw => ({ name: area.name, raw })))
    );

    // Deduplicate by element ID (in case bounding boxes overlap)
    const seen = new Set();
    const allMerchants = [];

    for (const { name, raw } of rawResults) {
        const valid = raw.filter(isValidBitcoinMerchant).filter(m => {
            if (seen.has(m.id)) return false;
            seen.add(m.id);
            return true;
        });
        allMerchants.push(...valid.map(m => formatMerchant(m, name)));
    }

    return allMerchants;
}

/**
 * Get formatted merchant list for display (Roatan + Utila) — backwards compatible
 * @deprecated Use getMerchantsForAreas() with location config instead
 */
async function getMerchantList() {
    return getMerchantsForAreas(null);
}

/**
 * Search merchants by name (across all islands)
 */
async function searchMerchants(query) {
    const [roatanRaw, utilaRaw] = await Promise.all([
        getRoatanMerchants(),
        getUtilaMerchants()
    ]);

    const queryLower = query.toLowerCase();
    const filterByName = m => {
        const name = m.osm_json?.tags?.name || '';
        return name.toLowerCase().includes(queryLower);
    };

    const seen = new Set();
    const roatanFiltered = roatanRaw.filter(filterByName).filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
    });
    const utilaFiltered = utilaRaw.filter(filterByName).filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
    });

    return [
        ...roatanFiltered.map(m => formatMerchant(m, 'Roatan')),
        ...utilaFiltered.map(m => formatMerchant(m, 'Utila'))
    ];
}

module.exports = {
    fetchMerchants,
    getRoatanMerchants,
    getUtilaMerchants,
    getHondurasMerchants,
    getMerchantList,
    getMerchantsForAreas,
    searchMerchants,
    formatMerchant
};
