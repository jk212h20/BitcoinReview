const assert = require('assert');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const databasePath = path.join(os.tmpdir(), `bitcoin-review-lnurl-api-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = databasePath;

const db = require('../services/database');
const lightning = require('../services/lightning');
const apiRoutes = require('../routes/api');

function request(port, requestPath) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: requestPath }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
        });
        req.on('error', reject);
    });
}

async function main() {
    const originalDecode = lightning.decodePayReq;
    const originalPay = lightning.payInvoice;
    const app = express();
    app.use('/api', apiRoutes);
    const server = app.listen(0, '127.0.0.1');

    try {
        await db.initializeDatabase();
        const unknownRaffle = db.createRaffle(939456, 'unknown-outcome-hash', 1, 0, null, 100);
        db.setRaffleClaimToken(unknownRaffle.id, 'unknown-outcome-token', '2030-01-01T00:00:00.000Z');

        let paymentCalls = 0;
        lightning.decodePayReq = async () => ({ num_satoshis: '100' });
        lightning.payInvoice = async () => {
            paymentCalls += 1;
            const error = new Error('simulated transport timeout after dispatch');
            error.paymentOutcome = 'unknown';
            throw error;
        };

        const unknownResponse = await request(server.address().port, '/api/lnurl/withdraw/unknown-outcome-token/callback?k1=unknown-outcome-token&pr=invoice');
        assert.strictEqual(unknownResponse.body.status, 'ERROR', 'unknown payment outcome must return an error');
        assert.match(unknownResponse.body.reason, /reconciled/i, 'unknown payment outcome must instruct reconciliation');
        assert.strictEqual(db.findRaffleByClaimToken('unknown-outcome-token').claim_status, 'processing', 'unknown payment outcome must remain processing');

        const retryResponse = await request(server.address().port, '/api/lnurl/withdraw/unknown-outcome-token/callback?k1=unknown-outcome-token&pr=invoice');
        assert.match(retryResponse.body.reason, /already being processed|reconciled/i, 'a retry must not receive another payment slot');
        assert.strictEqual(paymentCalls, 1, 'an unknown outcome must not be paid a second time');

        const failedRaffle = db.createRaffle(939457, 'definitive-failure-hash', 1, 0, null, 101);
        db.setRaffleClaimToken(failedRaffle.id, 'definitive-failure-token', '2030-01-01T00:00:00.000Z');
        lightning.decodePayReq = async () => ({ num_satoshis: '101' });
        lightning.payInvoice = async () => {
            const error = new Error('invoice rejected before dispatch');
            error.paymentOutcome = 'not_sent';
            throw error;
        };

        const failedResponse = await request(server.address().port, '/api/lnurl/withdraw/definitive-failure-token/callback?k1=definitive-failure-token&pr=invoice');
        assert.match(failedResponse.body.reason, /Payment failed/i, 'definitive failure must be reported as a payment failure');
        assert.strictEqual(db.findRaffleByClaimToken('definitive-failure-token').claim_status, 'pending', 'definitive pre-dispatch failure must release the claim');

        const underpaidRaffle = db.createRaffle(939458, 'underpaid-hash', 1, 0, null, 102);
        db.setRaffleClaimToken(underpaidRaffle.id, 'underpaid-token', '2030-01-01T00:00:00.000Z');
        lightning.decodePayReq = async () => ({ num_satoshis: '101' });
        lightning.payInvoice = async () => {
            paymentCalls += 1;
            return { payment_hash: 'should-not-be-called' };
        };

        const underpaidResponse = await request(server.address().port, '/api/lnurl/withdraw/underpaid-token/callback?k1=underpaid-token&pr=invoice');
        assert.match(underpaidResponse.body.reason, /exactly match/i, 'underpaid invoice must be rejected');
        assert.strictEqual(db.findRaffleByClaimToken('underpaid-token').claim_status, 'pending', 'amount rejection must not reserve the claim');
        assert.strictEqual(paymentCalls, 1, 'amount rejection must not call the payment provider');

        console.log('✅ LNURL callback preserves unknown outcomes and rejects underpaid invoices');
    } finally {
        lightning.decodePayReq = originalDecode;
        lightning.payInvoice = originalPay;
        await new Promise(resolve => server.close(resolve));
        for (const filePath of [databasePath, ...[1, 2, 3].map(id => `${databasePath}.claim-${id}.lock`)]) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    }
}

main().catch(error => {
    console.error(`❌ ${error.message}`);
    process.exit(1);
});
