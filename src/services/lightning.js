/**
 * Lightning Network service
 * Connects to Voltage LND node via REST API
 * Handles Lightning Address resolution and payments
 */

const LND_REST_URL = process.env.LND_REST_URL;
const LND_MACAROON = process.env.LND_MACAROON;

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

module.exports = {
    getNodeInfo,
    getWalletBalance,
    getChannelBalance,
    decodePayReq,
    payInvoice,
    resolveLightningAddress,
    requestInvoice,
    payLightningAddress,
    isConfigured
};
