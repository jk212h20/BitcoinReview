const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const databasePath = process.env.DATABASE_PATH || path.join(os.tmpdir(), `bitcoin-review-lnurl-claim-lock-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = databasePath;

const db = require('../services/database');

const isChild = process.env.LNURL_CLAIM_LOCK_TEST_CHILD === '1';
const childReadyPath = process.env.LNURL_CLAIM_LOCK_TEST_READY_PATH;
const childStartPath = process.env.LNURL_CLAIM_LOCK_TEST_START_PATH;
const childFinishPath = process.env.LNURL_CLAIM_LOCK_TEST_FINISH_PATH;

async function waitForPath(filePath, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(filePath)) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for ${filePath}`);
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function childMain() {
    await db.initializeDatabase();
    fs.writeFileSync(childReadyPath, 'ready');
    await waitForPath(childStartPath);

    const raffleId = parseInt(process.env.LNURL_CLAIM_LOCK_TEST_RAFFLE_ID, 10);
    const result = db.reserveRaffleClaim(raffleId);
    process.stdout.write(`CLAIM_RESULT:${JSON.stringify(result)}\n`);
    await waitForPath(childFinishPath);
}

function launchChild(environment) {
    const child = spawn(process.execPath, [__filename], { env: environment });
    let output = '';
    let resultSettled = false;

    const result = new Promise((resolve, reject) => {
        child.stdout.on('data', chunk => {
            output += chunk.toString();
            const match = output.match(/CLAIM_RESULT:(\{.*\})/);
            if (match && !resultSettled) {
                resultSettled = true;
                resolve(JSON.parse(match[1]));
            }
        });
        child.on('error', reject);
        child.on('close', code => {
            if (!resultSettled) {
                reject(new Error(`Claim-lock child exited with code ${code}: ${output}`));
            }
        });
    });

    const exit = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`Claim-lock child exited with code ${code}`));
        });
    });

    return { child, result, exit };
}

async function testCrossProcessReservation(raffle) {
    const prefix = `${databasePath}.claim-lock-test`;
    const readyPaths = [`${prefix}.ready-1`, `${prefix}.ready-2`];
    const startPath = `${prefix}.start`;
    const finishPath = `${prefix}.finish`;
    const children = [];

    try {
        for (let i = 0; i < 2; i += 1) {
            children.push(launchChild({
                ...process.env,
                LNURL_CLAIM_LOCK_TEST_CHILD: '1',
                LNURL_CLAIM_LOCK_TEST_READY_PATH: readyPaths[i],
                LNURL_CLAIM_LOCK_TEST_START_PATH: startPath,
                LNURL_CLAIM_LOCK_TEST_FINISH_PATH: finishPath,
                LNURL_CLAIM_LOCK_TEST_RAFFLE_ID: String(raffle.id)
            }));
        }

        await Promise.all(readyPaths.map(filePath => waitForPath(filePath)));
        fs.writeFileSync(startPath, 'start');
        const results = await Promise.all(children.map(child => child.result));
        assert.strictEqual(results.filter(result => result.reserved).length, 1, 'exactly one process must reserve the claim');
        assert.strictEqual(results.filter(result => !result.reserved && result.status === 'processing').length, 1, 'the losing process must see processing');
        fs.writeFileSync(finishPath, 'finish');
        await Promise.all(children.map(child => child.exit));
    } finally {
        fs.writeFileSync(finishPath, 'finish');
        for (const child of children) {
            if (!child.child.killed) child.child.kill();
        }
        for (const filePath of [...readyPaths, startPath, finishPath]) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        const claimLockPath = `${databasePath}.claim-${raffle.id}.lock`;
        if (fs.existsSync(claimLockPath)) fs.unlinkSync(claimLockPath);
    }
}

async function main() {
    try {
        await db.initializeDatabase();
        const raffle = db.createRaffle(939456, 'claim-lock-hash', 1, 0, null, 100);
        db.setRaffleClaimToken(raffle.id, 'claim-lock-token', '2030-01-01T00:00:00.000Z');

        await testCrossProcessReservation(raffle);
        await db.initializeDatabase();
        assert.strictEqual(db.findRaffleByClaimToken('claim-lock-token').claim_status, 'processing', 'cross-process reservation must persist');
        db.releaseRaffleClaim(raffle.id, 'simulated cleanup');

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
        const claimLockPaths = [1, 2, 3].map(id => `${databasePath}.claim-${id}.lock`);
        for (const filePath of [databasePath, ...claimLockPaths]) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    }
}

if (isChild) {
    childMain().catch(error => {
        console.error(`❌ ${error.message}`);
        process.exit(1);
    });
} else {
    main().catch(error => {
        console.error(`❌ ${error.message}`);
        process.exit(1);
    });
}
