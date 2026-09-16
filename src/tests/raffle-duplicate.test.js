const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');

const databasePath = path.join(os.tmpdir(), `bitcoin-review-raffle-duplicate-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = databasePath;

const db = require('../services/database');

async function main() {
    try {
        const SQL = await initSqlJs();
        const legacy = new SQL.Database();
        legacy.run(`
            CREATE TABLE raffles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                block_height INTEGER NOT NULL,
                block_hash TEXT NOT NULL,
                total_tickets INTEGER NOT NULL,
                winning_index INTEGER NOT NULL,
                winning_ticket_id INTEGER,
                prize_amount_sats INTEGER,
                payment_status TEXT DEFAULT 'pending',
                payment_hash TEXT,
                payment_error TEXT,
                paid_at TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
        `);
        legacy.run(`
            INSERT INTO raffles (block_height, block_hash, total_tickets, winning_index)
            VALUES (938063, 'legacy-hash-a', 1, 0), (938063, 'legacy-hash-b', 1, 0);
        `);
        fs.writeFileSync(databasePath, Buffer.from(legacy.export()));
        legacy.close();

        await db.initializeDatabase();

        assert.strictEqual(db.getAllRaffles().length, 2, 'legacy duplicate raffle rows must remain untouched');

        const persistenceFailureArgs = [
            939455,
            '0000000000000000000000000000000000000000000000000000000000000002',
            3,
            1,
            41,
            40000,
            40000
        ];
        const originalWriteFileSync = fs.writeFileSync;
        fs.writeFileSync = (targetPath, ...args) => {
            if (String(targetPath).startsWith(`${databasePath}.`) || String(targetPath) === databasePath) {
                throw new Error('simulated persistence failure');
            }
            return originalWriteFileSync(targetPath, ...args);
        };
        try {
            assert.throws(
                () => db.createRaffle(...persistenceFailureArgs),
                /simulated persistence failure/,
                'a failed database snapshot must reject the raffle'
            );
        } finally {
            fs.writeFileSync = originalWriteFileSync;
        }
        assert.strictEqual(db.findRaffleByBlock(939455), null, 'failed persistence must restore the in-memory database');
        assert.strictEqual(db.getAllRaffles().length, 2, 'failed persistence must not retain a raffle row');

        const raffleArgs = [
            939456,
            '0000000000000000000000000000000000000000000000000000000000000001',
            3,
            1,
            42,
            50000,
            50001,
            'claim-token-939456',
            '2030-01-01T00:00:00.000Z'
        ];

        const first = db.createRaffle(...raffleArgs);
        assert.ok(first.id, 'the first raffle must be created');

        assert.throws(
            () => db.createRaffle(...raffleArgs),
            error => error && error.code === 'DUPLICATE_RAFFLE',
            'a second raffle for the same block must be rejected'
        );

        fs.writeFileSync = (targetPath, ...args) => {
            if (String(targetPath).startsWith(`${databasePath}.`) || String(targetPath) === databasePath) {
                throw new Error('simulated persistence failure');
            }
            return originalWriteFileSync(targetPath, ...args);
        };
        try {
            assert.throws(
                () => db.deleteRaffle(first.id, 50000),
                /simulated persistence failure/,
                'a failed raffle deletion must reject the refund'
            );
        } finally {
            fs.writeFileSync = originalWriteFileSync;
        }
        assert.ok(db.findRaffleByBlock(939456), 'failed deletion must restore the raffle');
        assert.strictEqual(db.getSetting('raffle_fund_sats'), '50001', 'failed deletion must not refund the fund');

        db.deleteRaffle(first.id, 50000);
        assert.strictEqual(db.findRaffleByBlock(939456), null, 'deleted test raffle must be removed');
        assert.strictEqual(db.getSetting('raffle_fund_sats'), '100001', 'deletion refund must persist with raffle cleanup');

        const replacement = db.createRaffle(...raffleArgs);
        assert.ok(replacement.id, 'a deleted test raffle block can be reused');
        assert.strictEqual(db.getAllRaffles().length, 3, 'only one new raffle record must remain');
        assert.strictEqual(db.getSetting('raffle_fund_sats'), '50001', 'raffle and new fund balance must persist together');
        assert.strictEqual(db.findRaffleByBlock(939456).claim_token, 'claim-token-939456', 'claim token must persist with raffle creation');

        db.markRafflePaid(replacement.id, 'paid-hash');
        assert.throws(
            () => db.deleteRaffle(replacement.id, 50000),
            error => error && error.code === 'PAID_RAFFLE',
            'a paid raffle must never be deleted or refunded'
        );
        assert.ok(db.findRaffleByBlock(939456), 'a paid raffle must remain in payout history');
        assert.strictEqual(db.getSetting('raffle_fund_sats'), '50001', 'a paid raffle must not refund the fund');

        assert.throws(
            () => db.createRaffle(939457, 'invalid-prize-hash', 1, 0, 43, -1, 50002),
            error => error && error.code === 'INVALID_RAFFLE_PRIZE',
            'negative prizes must be rejected before persistence'
        );
        assert.throws(
            () => db.createRaffle(939458, 'missing-fund-hash', 1, 0, 44, 100),
            error => error && error.code === 'RAFFLE_FUND_RESERVATION_REQUIRED',
            'a positive prize must reserve a raffle-fund balance'
        );
        assert.strictEqual(db.findRaffleByBlock(939457), null, 'invalid prize must not create a raffle');
        assert.strictEqual(db.findRaffleByBlock(939458), null, 'missing fund reservation must not create a raffle');

        const persisted = new SQL.Database(fs.readFileSync(databasePath));
        const locks = persisted.exec('SELECT block_height FROM raffle_locks ORDER BY block_height')[0].values;
        persisted.close();

        assert.deepStrictEqual(locks, [[938063], [939456]], 'legacy and new blocks must each have one durable lock');
        console.log('✅ Duplicate raffle creation is blocked');
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
