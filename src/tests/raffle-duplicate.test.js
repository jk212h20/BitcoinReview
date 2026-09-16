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

        const raffleArgs = [
            939456,
            '0000000000000000000000000000000000000000000000000000000000000001',
            3,
            1,
            42,
            50000
        ];

        const first = db.createRaffle(...raffleArgs);
        assert.ok(first.id, 'the first raffle must be created');

        assert.throws(
            () => db.createRaffle(...raffleArgs),
            error => error && error.code === 'DUPLICATE_RAFFLE',
            'a second raffle for the same block must be rejected'
        );

        assert.strictEqual(db.getAllRaffles().length, 3, 'only one new raffle record must be created');

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
