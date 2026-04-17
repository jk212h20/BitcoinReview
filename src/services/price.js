/**
 * Bitcoin price service — fetches BTC/USD from CoinGecko with in-memory caching.
 *
 * - No API key required.
 * - Cache duration: 5 minutes (price doesn't move that fast for our "~$X" display).
 * - Fails silently: returns null if upstream is unavailable; callers handle gracefully.
 */

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SATS_PER_BTC = 100_000_000;

let cache = {
    usdPerBtc: null,
    fetchedAt: 0,
    inflight: null
};

/**
 * Fetch BTC/USD price, cached for 5 minutes.
 * @returns {Promise<number|null>} USD per 1 BTC, or null if unavailable
 */
async function getBtcUsdPrice() {
    const now = Date.now();

    // Return cached value if fresh
    if (cache.usdPerBtc && (now - cache.fetchedAt) < CACHE_TTL_MS) {
        return cache.usdPerBtc;
    }

    // Dedupe concurrent fetches
    if (cache.inflight) {
        return cache.inflight;
    }

    cache.inflight = (async () => {
        try {
            const res = await fetch(COINGECKO_URL, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(5000)
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const usd = data?.bitcoin?.usd;
            if (typeof usd === 'number' && usd > 0) {
                cache.usdPerBtc = usd;
                cache.fetchedAt = Date.now();
                return usd;
            }
            throw new Error('Invalid response shape');
        } catch (err) {
            console.warn('BTC price fetch failed:', err.message);
            // If we have a stale cached value, keep using it rather than returning null
            return cache.usdPerBtc || null;
        } finally {
            cache.inflight = null;
        }
    })();

    return cache.inflight;
}

/**
 * Convert sats to USD using the cached BTC price.
 * @param {number} sats
 * @returns {Promise<number|null>} USD value, or null if price unavailable
 */
async function satsToUsd(sats) {
    const usdPerBtc = await getBtcUsdPrice();
    if (!usdPerBtc || !sats) return null;
    return (Number(sats) / SATS_PER_BTC) * usdPerBtc;
}

module.exports = {
    getBtcUsdPrice,
    satsToUsd
};
