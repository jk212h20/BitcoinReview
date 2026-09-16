const assert = require('assert');

process.env.LND_REST_URL = 'https://lnd.test';
process.env.LND_MACAROON = 'test-macaroon';

const lightning = require('../services/lightning');

function lndResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(payload),
        json: async () => payload
    };
}

async function main() {
    const originalFetch = global.fetch;
    try {
        global.fetch = async () => {
            throw new Error('simulated timeout');
        };
        await assert.rejects(
            lightning.payInvoice('invoice', 0),
            error => error.code === 'LND_TRANSPORT_ERROR' && error.paymentOutcome === 'unknown',
            'transport failures must remain unknown'
        );

        global.fetch = async () => lndResponse({ payment_error: 'no route' });
        await assert.rejects(
            lightning.payInvoice('invoice', 0),
            error => error.code === 'LND_PAYMENT_FAILED' && error.paymentOutcome === 'not_sent',
            'definitive LND payment failures must be retryable'
        );

        global.fetch = async () => lndResponse({ payment_preimage: 'preimage' });
        await assert.rejects(
            lightning.payInvoice('invoice', 0),
            error => error.code === 'LND_PAYMENT_RESULT_INCOMPLETE' && error.paymentOutcome === 'unknown',
            'success responses without a payment hash must remain unknown'
        );

        global.fetch = async () => lndResponse({ payment_hash: 'payment-hash' });
        const result = await lightning.payInvoice('invoice', 0);
        assert.strictEqual(result.payment_hash, 'payment-hash', 'successful payments must return their payment hash');

        console.log('✅ Lightning payment outcomes are classified safely');
    } finally {
        global.fetch = originalFetch;
    }
}

main().catch(error => {
    console.error(`❌ ${error.message}`);
    process.exit(1);
});
