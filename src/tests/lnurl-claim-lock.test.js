const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const databasePath = path.join(os.tmpdir(), `bitcoin-review-lnurl-claim-lock-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = databasePath;

const db = require('../services/database');

async function main() {
    try {
        await db.initializeDatabase();
        const raffle = db.createRaffle(939456, 'claim-lock-hash', 1, 0, null, 100);
        db.setRaffleClaimToken(raffle.id, 'claim-lock-token', '2030-01-01T00:00:00.000Z');

        const firstReservation = db.reserveRaffleClaim(raffle.id);
        assert.deepStrictEqual(firstReservation, { reserved: true, status: 'processing' }, 'the first callback must reserve the claim');
        assert.strictEqual(db.findRaffleByClaimToken('claim-lock-token').claim_status, 'processing', 'reservation must persist before payment starts');

        const secondReservation = db.reserveRaffleClaim(raffle.id);
        assert.deepStrictEqual(secondReservation, { reserved: false, status: 'processing' }, 'a concurrent callback must not receive a second payment slot');

        db.releaseRaffleClaim(raffle.id, 'simulated Lightning failure');
        assert.strictEqual(db.findRaffleByClaimToken('claim-lock-token').claim_status, 'pending', 'a failed payment must release the claim for a retry');

        assert.deepStrictEqual(db.reserveRaffleClaim(raffle.id), { reserved: true, status: 'processing' }, 'a released claim must be reservable once');
        db.markRaffleClaimed(raffle.id, 'payment-hash');
        assert.strictEqual(db.findRaffleByClaimToken('claim-lock-token').claim_status, 'claimed', 'a successful payment must close the claim');
        assert.deepStrictEqual(db.reserveRaffleClaim(raffle.id), { reserved: false, status: 'claimed' }, 'a claimed prize must never be reserved again');

        console.log('✅ LNURL claims reserve one payment slot at a time');
    } finally {
        if (fs.existsSync(databasePath)) {
            fs.unlinkSync(databasePath);
        }
    }
}

main().catch(error => {
    console.error(`❌ ${error.message}`);
    process.exit(1);
});
