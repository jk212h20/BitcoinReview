/**
 * Lightning Network service
 * Connects to Voltage LND node via REST API
 * Handles Lightning Address resolution and payments
 */

const db = require('./database');

const LND_REST_URL = process.env.LND_REST_URL;
const LND_MACAROON = process.env.LND_MACAROON;

// In-memory cache for deposit info
let depositCache = {
    onchainAddress: null,
    lightningInvoice: null,  // zero-amount invoice bolt11
    lightningPaymentHash: null,
    lastChecked: 0,
    lastExpiryCheck: 0       // track when we last checked expiry
};

// How often to re-check invoice expiry (5 minutes)
const EXPIRY_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Make an authenticated request to the LND REST API
 */
async function lndRequest(path, method = 'GET', body = null) {
    if (!LND_REST_URL || !LND_MACAROON) {
        throw new Error('LND node not configured. Set LND_REST_URL and LND_MACAROON.');
    }

    const url = `${LND_REST_URL}${path}`;
    const options = {
        method,
        headers: {
            'Grpc-Metadata-macaroon': LND_MACAROON,
            'Content-Type': 'application/json'
        }
    };

    // Skip TLS verification for Voltage nodes (they use self-signed certs)
    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LND API error (${response.status}): ${errorText}`);
    }

    return await response.json();
}

/**
 * Get node info (alias, pubkey, etc.)
 */
async function getNodeInfo() {
    return await lndRequest('/v1/getinfo');
}

/**
 * Get wallet balance (on-chain)
 */
async function getWalletBalance() {
    return await lndRequest('/v1/balance/blockchain');
}

/**
 * Get channel balance (Lightning)
 */
async function getChannelBalance() {
    return await lndRequest('/v1/balance/channels');
}

/**
 * Decode a BOLT11 payment request
 */
async function decodePayReq(payReq) {
    return await lndRequest(`/v1/payreq/${payReq}`);
}

/**
 * Pay a BOLT11 invoice
 * Returns payment result with payment_hash and payment_preimage
 */
async function payInvoice(payReq, amountSats = null) {
    const body = {
        payment_request: payReq,
        fee_limit: {
            fixed: '100' // Max 100 sats fee
        }
    };

    // If amount specified (for zero-amount invoices)
    if (amountSats) {
        body.amt = String(amountSats);
    }

    // Use v1 synchronous send endpoint
    return await lndRequest('/v1/channels/transactions', 'POST', body);
}

/**
 * Resolve a Lightning Address to LNURL-pay metadata
 * Lightning Address format: user@domain.com
 * Resolves to: https://domain.com/.well-known/lnurlp/user
 */
async function resolveLightningAddress(address) {
    if (!address || !address.includes('@')) {
        throw new Error('Invalid Lightning Address format. Expected user@domain.com');
    }

    const [user, domain] = address.split('@');
    const url = `https://${domain}/.well-known/lnurlp/${user}`;

    console.log(`Resolving Lightning Address: ${address} -> ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to resolve Lightning Address ${address}: ${response.status}`);
    }

    const data = await response.json();

    if (data.status === 'ERROR') {
        throw new Error(`Lightning Address error: ${data.reason}`);
    }

    if (data.tag !== 'payRequest') {
        throw new Error(`Unexpected LNURL tag: ${data.tag}`);
    }

    return {
        callback: data.callback,
        minSendable: data.minSendable, // millisats
        maxSendable: data.maxSendable, // millisats
        metadata: data.metadata,
        domain
    };
}

/**
 * Request an invoice from a Lightning Address LNURL-pay endpoint
 * Amount is in sats, converted to millisats for the request
 */
async function requestInvoice(callback, amountSats, comment = '') {
    const amountMsats = amountSats * 1000;
    let url = `${callback}${callback.includes('?') ? '&' : '?'}amount=${amountMsats}`;
    
    if (comment) {
        url += `&comment=${encodeURIComponent(comment)}`;
    }

    console.log(`Requesting invoice for ${amountSats} sats from ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to request invoice: ${response.status}`);
    }

    const data = await response.json();

    if (data.status === 'ERROR') {
        throw new Error(`Invoice request error: ${data.reason}`);
    }

    return {
        pr: data.pr, // BOLT11 payment request
        routes: data.routes,
        successAction: data.successAction
    };
}

/**
 * Pay a Lightning Address a specific amount in sats
 * Full flow: resolve address -> request invoice -> pay invoice
 */
async function payLightningAddress(address, amountSats, comment = '') {
    console.log(`💸 Paying ${amountSats} sats to ${address}...`);

    // Step 1: Resolve Lightning Address
    const lnurlData = await resolveLightningAddress(address);

    // Validate amount is within bounds
    const minSats = Math.ceil(lnurlData.minSendable / 1000);
    const maxSats = Math.floor(lnurlData.maxSendable / 1000);

    if (amountSats < minSats) {
        throw new Error(`Amount ${amountSats} sats is below minimum ${minSats} sats`);
    }
    if (amountSats > maxSats) {
        throw new Error(`Amount ${amountSats} sats exceeds maximum ${maxSats} sats`);
    }

    // Step 2: Request invoice
    const invoiceData = await requestInvoice(lnurlData.callback, amountSats, comment);
    console.log(`📄 Got invoice: ${invoiceData.pr.substring(0, 40)}...`);

    // Step 3: Pay the invoice
    const paymentResult = await payInvoice(invoiceData.pr);
    console.log(`✅ Payment sent!`);

    return {
        success: true,
        address,
        amountSats,
        paymentHash: paymentResult.payment_hash,
        paymentPreimage: paymentResult.payment_preimage,
        invoice: invoiceData.pr,
        successAction: invoiceData.successAction
    };
}

/**
 * Check if LND node is configured and reachable
 */
async function isConfigured() {
    if (!LND_REST_URL || !LND_MACAROON) {
        return { configured: false, reason: 'LND_REST_URL or LND_MACAROON not set' };
    }

    try {
        const info = await getNodeInfo();
        return {
            configured: true,
            alias: info.alias,
            pubkey: info.identity_pubkey,
            synced: info.synced_to_chain,
            blockHeight: info.block_height
        };
    } catch (error) {
        return { configured: false, reason: error.message };
    }
}

// ============================================================
// Deposit Address Management (on-chain + lightning donations)
// ============================================================

/**
 * Generate a new on-chain address from LND and track it in DB
 */
async function generateOnChainAddress() {
    const result = await lndRequest('/v2/wallet/address/next', 'POST', {
        type: 'TAPROOT_PUBKEY',
        account: 'default'
    });
    const address = result.addr;
    
    // Deactivate old on-chain addresses
    db.deactivateAllDepositAddresses('onchain');
    
    // Store in DB
    db.createDepositAddress(address, 'onchain');
    
    // Update cache
    depositCache.onchainAddress = address;
    console.log(`🏠 New on-chain deposit address: ${address}`);
    return address;
}

/**
 * Create a Lightning invoice (zero-amount or specified amount) and track in DB
 * Zero-amount donation invoices get 30-day expiry (no volatility concern for donations).
 * Custom-amount invoices get 7-day expiry.
 */
async function createDonationInvoice(amountSats = 0, memo = 'Donation to Bitcoin Review Raffle') {
    const expiry = amountSats === 0 ? '2592000' : '604800'; // 30 days for zero-amount, 7 days for custom
    const body = { memo, expiry };
    if (amountSats > 0) {
        body.value = String(amountSats);
    }
    
    const result = await lndRequest('/v1/invoices', 'POST', body);
    const bolt11 = result.payment_request;
    const paymentHash = Buffer.from(result.r_hash, 'base64').toString('hex');
    
    // Only track zero-amount invoices as the "active" cached one
    if (amountSats === 0) {
        db.deactivateAllDepositAddresses('lightning');
        db.createDepositAddress(bolt11, 'lightning', bolt11, paymentHash, memo);
        depositCache.lightningInvoice = bolt11;
        depositCache.lightningPaymentHash = paymentHash;
        console.log(`⚡ New zero-amount Lightning invoice cached`);
    } else {
        // Track custom-amount invoices too but don't make them the active cached one
        db.createDepositAddress(bolt11, 'lightning', bolt11, paymentHash, `${memo} (${amountSats} sats)`);
        console.log(`⚡ Created ${amountSats} sat Lightning invoice`);
    }
    
    return { bolt11, paymentHash };
}

/**
 * Check if the cached Lightning invoice is expired by looking it up on LND.
 * Returns true if expired or cancelled, false if still open.
 */
async function isInvoiceExpired() {
    if (!depositCache.lightningPaymentHash) return true;
    try {
        const hashBase64 = Buffer.from(depositCache.lightningPaymentHash, 'hex').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_');
        const invoice = await lndRequest(`/v2/invoices/lookup?payment_hash=${hashBase64}`);
        // OPEN = still valid, SETTLED = paid, CANCELLED/EXPIRED = expired
        return invoice.state !== 'OPEN';
    } catch (err) {
        // If we can't look it up, assume expired to be safe
        return true;
    }
}

/**
 * Get the current active deposit info from cache.
 * This is the FAST path used by page routes — returns cached data instantly.
 * Never makes external API calls. The cache is warmed on startup and
 * refreshed in the background by refreshDepositInfoIfNeeded().
 */
function getDepositInfoCached() {
    return {
        onchainAddress: depositCache.onchainAddress,
        lightningInvoice: depositCache.lightningInvoice
    };
}

/**
 * Get the current active deposit info (from cache or DB)
 * Auto-rotates the Lightning invoice if it has expired.
 * This is the SLOW path — only called during warmup and background refresh.
 */
async function getDepositInfo() {
    // Try to load from DB if cache is empty
    if (!depositCache.onchainAddress || !depositCache.lightningInvoice) {
        const onchain = db.getActiveDepositAddress('onchain');
        const lightning = db.getActiveDepositAddress('lightning');
        
        if (onchain) depositCache.onchainAddress = onchain.address;
        if (lightning) {
            depositCache.lightningInvoice = lightning.invoice;
            depositCache.lightningPaymentHash = lightning.payment_hash;
        }
    }
    
    // Generate on-chain address if missing
    if (!depositCache.onchainAddress) {
        await generateOnChainAddress();
    }
    
    // Generate Lightning invoice if missing, or rotate if expired
    if (!depositCache.lightningInvoice) {
        await createDonationInvoice(0);
    } else {
        // Check if current invoice is expired and rotate if so
        const expired = await isInvoiceExpired();
        if (expired) {
            console.log('⚡ Cached Lightning invoice expired — generating new one');
            await createDonationInvoice(0);
        }
    }
    
    depositCache.lastExpiryCheck = Date.now();
    
    return {
        onchainAddress: depositCache.onchainAddress,
        lightningInvoice: depositCache.lightningInvoice
    };
}

/**
 * Background refresh: checks invoice expiry periodically (every 5 min).
 * Called from the deposit polling interval — NOT from page routes.
 */
async function refreshDepositInfoIfNeeded() {
    const now = Date.now();
    if ((now - depositCache.lastExpiryCheck) >= EXPIRY_CHECK_INTERVAL_MS) {
        try {
            await getDepositInfo();
        } catch (err) {
            console.warn('⚠️  Background deposit refresh error:', err.message);
        }
    }
}

/**
 * Check if the active on-chain address received funds; rotate if so
 */
async function checkOnChainDeposits() {
    if (!depositCache.onchainAddress) return;
    
    try {
        // List on-chain transactions and check for our address
        const txns = await lndRequest('/v1/transactions');
        if (!txns.transactions) return;
        
        for (const tx of txns.transactions) {
            if (!tx.dest_addresses) continue;
            if (tx.dest_addresses.includes(depositCache.onchainAddress) && parseInt(tx.amount) > 0) {
                const amountSats = parseInt(tx.amount);
                console.log(`💰 On-chain deposit detected: ${amountSats} sats to ${depositCache.onchainAddress}`);
                
                // Mark received in DB
                const dbAddr = db.getDepositAddressByAddress(depositCache.onchainAddress);
                if (dbAddr && dbAddr.is_active) {
                    db.markDepositReceived(dbAddr.id, amountSats);
                    // Add to raffle fund
                    const currentFund = parseInt(db.getSetting('raffle_fund_sats') || '0');
                    db.setSetting('raffle_fund_sats', String(currentFund + amountSats));
                    console.log(`🎯 Raffle fund updated: ${currentFund} + ${amountSats} = ${currentFund + amountSats} sats`);
                    // Generate new address
                    await generateOnChainAddress();
                }
                break;
            }
        }
    } catch (err) {
        console.warn('⚠️  Error checking on-chain deposits:', err.message);
    }
}

/**
 * Check ALL unpaid Lightning invoices (cached + custom-amount from DB) for settlement.
 * This catches both the zero-amount donation invoice AND custom-amount invoices
 * generated via the "Generate" button on the donation page.
 */
async function checkLightningDeposits() {
    try {
        // Get ALL unpaid Lightning invoices from DB
        const unpaidInvoices = db.getUnpaidLightningInvoices();
        
        for (const dbInvoice of unpaidInvoices) {
            if (!dbInvoice.payment_hash) continue;
            
            try {
                const hashBase64 = Buffer.from(dbInvoice.payment_hash, 'hex').toString('base64')
                    .replace(/\+/g, '-').replace(/\//g, '_');
                const lndInvoice = await lndRequest(`/v2/invoices/lookup?payment_hash=${hashBase64}`);
                
                if (lndInvoice.state === 'SETTLED') {
                    const amountSats = parseInt(lndInvoice.amt_paid_sat || lndInvoice.value || '0');
                    console.log(`⚡ Lightning deposit detected: ${amountSats} sats (invoice ${dbInvoice.payment_hash.substring(0, 12)}...)`);
                    
                    // Mark received in DB
                    db.markDepositReceived(dbInvoice.id, amountSats);
                    
                    // Add to raffle fund
                    if (amountSats > 0) {
                        const currentFund = parseInt(db.getSetting('raffle_fund_sats') || '0');
                        db.setSetting('raffle_fund_sats', String(currentFund + amountSats));
                        console.log(`🎯 Raffle fund updated: ${currentFund} + ${amountSats} = ${currentFund + amountSats} sats`);
                    }
                    
                    // If this was the cached zero-amount invoice, rotate it
                    if (dbInvoice.payment_hash === depositCache.lightningPaymentHash) {
                        await createDonationInvoice(0);
                    }
                }
            } catch (err) {
                // Skip individual invoice lookup errors (e.g., invoice not found)
                continue;
            }
        }
    } catch (err) {
        console.warn('⚠️  Error checking Lightning deposits:', err.message);
    }
}

/**
 * Poll for deposits (called on interval — fallback for missed subscription events)
 */
async function checkForDeposits() {
    await checkOnChainDeposits();
    await checkLightningDeposits();
    depositCache.lastChecked = Date.now();
}

/**
 * Handle a settled invoice event (from subscription or polling).
 * Credits the raffle fund and rotates the cached invoice if needed.
 */
async function handleSettledInvoice(settledInvoice) {
    const paymentHash = Buffer.from(settledInvoice.r_hash, 'base64').toString('hex');
    const amountSats = parseInt(settledInvoice.amt_paid_sat || settledInvoice.value || '0');
    
    // Check if this invoice is one we're tracking
    const dbInvoice = db.getDepositAddressByPaymentHash(paymentHash);
    if (!dbInvoice) return; // Not our tracked invoice
    if (dbInvoice.received_at) return; // Already credited
    
    console.log(`⚡ INSTANT: Lightning deposit detected: ${amountSats} sats (invoice ${paymentHash.substring(0, 12)}...)`);
    
    // Mark received in DB
    db.markDepositReceived(dbInvoice.id, amountSats);
    
    // Add to raffle fund
    if (amountSats > 0) {
        const currentFund = parseInt(db.getSetting('raffle_fund_sats') || '0');
        db.setSetting('raffle_fund_sats', String(currentFund + amountSats));
        console.log(`🎯 Raffle fund updated: ${currentFund} + ${amountSats} = ${currentFund + amountSats} sats`);
    }
    
    // If this was the cached zero-amount invoice, rotate it
    if (paymentHash === depositCache.lightningPaymentHash) {
        await createDonationInvoice(0);
    }
}

/**
 * Subscribe to LND invoice updates via streaming REST API.
 * This gives us instant notification when any invoice is settled.
 * Auto-reconnects on disconnection.
 */
async function subscribeToInvoices() {
    if (!LND_REST_URL || !LND_MACAROON) return;
    
    // Try v1 endpoint first (wider compatibility), then v2
    const endpoints = ['/v1/invoices/subscribe', '/v2/invoices/subscribe'];
    let response = null;
    
    for (const endpoint of endpoints) {
        const url = `${LND_REST_URL}${endpoint}`;
        console.log(`⚡ Trying invoice subscription: ${endpoint}...`);
        
        try {
            response = await fetch(url, {
                headers: {
                    'Grpc-Metadata-macaroon': LND_MACAROON,
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.ok) {
                console.log(`⚡ Connected to LND invoice stream via ${endpoint}`);
                break;
            } else {
                console.warn(`⚠️  ${endpoint} returned ${response.status}`);
                response = null;
            }
        } catch (e) {
            console.warn(`⚠️  ${endpoint} error: ${e.message}`);
            response = null;
        }
    }
    
    if (!response) {
        console.warn('⚠️  No working invoice subscription endpoint found. Falling back to polling only.');
        return; // Don't retry — endpoints aren't available on this node
    }
    
    try {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                console.warn('⚡ Invoice subscription stream ended');
                break;
            }
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const event = JSON.parse(trimmed);
                    const invoice = event.result || event;
                    if (invoice.state === 'SETTLED') {
                        await handleSettledInvoice(invoice);
                    }
                } catch (parseErr) { /* skip partial JSON */ }
            }
        }
    } catch (err) {
        console.warn('⚠️  Invoice subscription stream error:', err.message);
    }
    
    // Auto-reconnect after 30 seconds
    console.log('⚡ Reconnecting invoice subscription in 30s...');
    setTimeout(() => subscribeToInvoices(), 30000);
}

/**
 * Subscribe to on-chain transaction updates via LND streaming REST API.
 * Detects on-chain deposits as soon as LND sees them (even unconfirmed).
 * Auto-reconnects on disconnection.
 */
async function subscribeToTransactions() {
    if (!LND_REST_URL || !LND_MACAROON) return;
    
    const url = `${LND_REST_URL}/v1/transactions/subscribe`;
    console.log('💰 Subscribing to LND on-chain transaction stream...');
    
    let response;
    try {
        response = await fetch(url, {
            headers: {
                'Grpc-Metadata-macaroon': LND_MACAROON,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            console.warn(`⚠️  Transaction subscribe returned ${response.status}. Falling back to polling only.`);
            return; // Don't retry on 404/permanent errors
        }
    } catch (err) {
        console.warn('⚠️  Transaction subscribe connection error:', err.message);
        // Reconnect after 30s for network errors
        setTimeout(() => subscribeToTransactions(), 30000);
        return;
    }
    
    console.log('💰 Connected to LND on-chain transaction stream');
    
    try {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                console.warn('💰 Transaction subscription stream ended');
                break;
            }
            
            buffer += decoder.decode(value, { stream: true });
            
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                
                try {
                    const event = JSON.parse(trimmed);
                    const tx = event.result || event;
                    
                    // Check if this transaction involves our tracked deposit address
                    if (tx.dest_addresses && depositCache.onchainAddress) {
                        if (tx.dest_addresses.includes(depositCache.onchainAddress)) {
                            const amountSats = Math.abs(parseInt(tx.amount || '0'));
                            if (amountSats > 0) {
                                // Check if we already credited this
                                const dbAddr = db.getDepositAddressByAddress(depositCache.onchainAddress);
                                if (dbAddr && !dbAddr.received_at) {
                                    console.log(`💰 INSTANT: On-chain deposit detected: ${amountSats} sats to ${depositCache.onchainAddress}`);
                                    db.markDepositReceived(dbAddr.id, amountSats);
                                    const currentFund = parseInt(db.getSetting('raffle_fund_sats') || '0');
                                    db.setSetting('raffle_fund_sats', String(currentFund + amountSats));
                                    console.log(`🎯 Raffle fund updated: ${currentFund} + ${amountSats} = ${currentFund + amountSats} sats`);
                                    // Generate new address
                                    await generateOnChainAddress();
                                }
                            }
                        }
                    }
                } catch (parseErr) {
                    // Partial JSON or non-JSON line — skip
                }
            }
        }
    } catch (err) {
        console.warn('⚠️  Transaction subscription error:', err.message);
    }
    
    // Auto-reconnect after 5 seconds
    console.log('💰 Reconnecting transaction subscription in 5s...');
    setTimeout(() => subscribeToTransactions(), 5000);
}

/**
 * Initialize deposit cache on startup
 */
async function warmDepositCache() {
    try {
        await getDepositInfo();
        console.log(`✅ Deposit cache warmed - On-chain: ${depositCache.onchainAddress?.substring(0, 12)}... | Lightning: ready`);
        
        // Start real-time subscriptions (non-blocking)
        subscribeToInvoices();
        subscribeToTransactions();
    } catch (err) {
        console.warn('⚠️  Failed to warm deposit cache:', err.message);
    }
}

module.exports = {
    getNodeInfo,
    getWalletBalance,
    getChannelBalance,
    decodePayReq,
    payInvoice,
    resolveLightningAddress,
    requestInvoice,
    payLightningAddress,
    isConfigured,
    
    // Deposit management
    generateOnChainAddress,
    createDonationInvoice,
    getDepositInfo,
    getDepositInfoCached,
    refreshDepositInfoIfNeeded,
    checkForDeposits,
    warmDepositCache
};
