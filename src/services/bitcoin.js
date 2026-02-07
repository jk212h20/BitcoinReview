/**
 * Bitcoin blockchain service
 * Fetches block data from mempool.space API
 */

const MEMPOOL_API = 'https://mempool.space/api';

// Cache for raffle info to avoid slow API calls on every page load
let raffleInfoCache = null;
let raffleCacheTime = 0;
const CACHE_TTL_MS = 120 * 1000; // Cache for 2 minutes

/**
 * Get current block height
 */
async function getCurrentBlockHeight() {
    const response = await fetch(`${MEMPOOL_API}/blocks/tip/height`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
        throw new Error('Failed to fetch block height');
    }
    return parseInt(await response.text(), 10);
}

/**
 * Get block hash for a specific height
 */
async function getBlockHash(height) {
    const response = await fetch(`${MEMPOOL_API}/block-height/${height}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch block hash for height ${height}`);
    }
    return await response.text();
}

/**
 * Get block details
 */
async function getBlock(hashOrHeight) {
    let hash = hashOrHeight;
    
    // If it's a number, get the hash first
    if (typeof hashOrHeight === 'number') {
        hash = await getBlockHash(hashOrHeight);
    }
    
    const response = await fetch(`${MEMPOOL_API}/block/${hash}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch block ${hash}`);
    }
    return await response.json();
}

/**
 * Calculate the current difficulty adjustment block
 * Bitcoin adjusts difficulty every 2016 blocks
 */
function getCurrentRaffleBlock(currentHeight) {
    return Math.floor(currentHeight / 2016) * 2016;
}

/**
 * Calculate the next difficulty adjustment block
 */
function getNextRaffleBlock(currentHeight) {
    return (Math.floor(currentHeight / 2016) + 1) * 2016;
}

/**
 * Calculate blocks until next raffle
 */
function getBlocksUntilNextRaffle(currentHeight) {
    const nextRaffle = getNextRaffleBlock(currentHeight);
    return nextRaffle - currentHeight;
}

/**
 * Select winner using block hash
 * Deterministic: hash mod totalTickets
 */
function selectWinnerIndex(blockHash, totalTickets) {
    if (totalTickets === 0) return null;
    
    // Convert hex hash to BigInt for proper modulo with large numbers
    const hashBigInt = BigInt('0x' + blockHash);
    const winnerIndex = Number(hashBigInt % BigInt(totalTickets));
    return winnerIndex;
}

/**
 * Get raffle info for display
 */
async function getRaffleInfo() {
    // Return cached data if fresh enough
    const now = Date.now();
    if (raffleInfoCache && (now - raffleCacheTime) < CACHE_TTL_MS) {
        return raffleInfoCache;
    }
    
    const currentHeight = await getCurrentBlockHeight();
    const currentRaffleBlock = getCurrentRaffleBlock(currentHeight);
    const nextRaffleBlock = getNextRaffleBlock(currentHeight);
    const blocksUntilNext = nextRaffleBlock - currentHeight;
    
    // Estimate time (average 10 minutes per block)
    const minutesUntilNext = blocksUntilNext * 10;
    const hoursUntilNext = Math.floor(minutesUntilNext / 60);
    const daysUntilNext = Math.floor(hoursUntilNext / 24);
    
    let timeEstimate;
    if (daysUntilNext > 0) {
        timeEstimate = `~${daysUntilNext} days`;
    } else if (hoursUntilNext > 0) {
        timeEstimate = `~${hoursUntilNext} hours`;
    } else {
        timeEstimate = `~${minutesUntilNext} minutes`;
    }
    
    const result = {
        currentHeight,
        currentRaffleBlock,
        nextRaffleBlock,
        blocksUntilNext,
        timeEstimate
    };
    
    // Update cache
    raffleInfoCache = result;
    raffleCacheTime = now;
    
    return result;
}

/**
 * Pre-warm the cache on server startup so first page loads are instant
 */
async function warmCache() {
    try {
        console.log('Pre-warming raffle info cache...');
        await getRaffleInfo();
        console.log('Raffle info cache warmed successfully');
    } catch (err) {
        console.warn('Failed to warm raffle cache (will retry on first request):', err.message);
    }
}

/**
 * Check if a raffle block has been mined
 */
async function isRaffleBlockMined(raffleBlock) {
    const currentHeight = await getCurrentBlockHeight();
    return currentHeight >= raffleBlock;
}

module.exports = {
    getCurrentBlockHeight,
    getBlockHash,
    getBlock,
    getCurrentRaffleBlock,
    getNextRaffleBlock,
    getBlocksUntilNextRaffle,
    selectWinnerIndex,
    getRaffleInfo,
    isRaffleBlockMined,
    warmCache
};
