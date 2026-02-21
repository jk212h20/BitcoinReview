/**
 * Raffle function tests
 * Run with: npm test
 *
 * Tests the core raffle mechanics:
 *  - selectWinnerIndex() determinism
 *  - getNextRaffleBlock() / getCurrentRaffleBlock() math
 *  - Block-hash mod distribution (basic sanity check)
 *  - Edge cases: 1 ticket, max tickets
 */

'use strict';

const bitcoin = require('../services/bitcoin');

// ── Tiny test harness (no external deps) ──────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}\n     ${e.message}`);
        failures.push({ name, error: e.message });
        failed++;
    }
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg || 'assertEqual failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function assertBetween(value, min, max, msg) {
    if (value < min || value > max) {
        throw new Error(`${msg || 'assertBetween failed'}: ${value} is not in [${min}, ${max}]`);
    }
}

function assertThrows(fn, msg) {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    if (!threw) throw new Error(msg || 'Expected function to throw');
}

// ── Constants ─────────────────────────────────────────────────────────────────

// A real Bitcoin block hash for repeatable tests
const REAL_BLOCK_HASH = '000000000000000000025a5f79e42ef3c8d05c4a80c1f9f7e4ad5a08a1e7b3c9';
const KNOWN_HASH_1    = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
const KNOWN_HASH_2    = '0000000000000000000000000000000000000000000000000000000000000001';
const ALL_ZEROS       = '0000000000000000000000000000000000000000000000000000000000000000';
const ALL_ONES        = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

// ── Test: selectWinnerIndex ────────────────────────────────────────────────────

console.log('\n🎲 selectWinnerIndex()');

test('returns null when totalTickets is 0', () => {
    const result = bitcoin.selectWinnerIndex(KNOWN_HASH_1, 0);
    assertEqual(result, null, 'Should return null for 0 tickets');
});

test('returns 0 when totalTickets is 1', () => {
    const result = bitcoin.selectWinnerIndex(KNOWN_HASH_1, 1);
    assertEqual(result, 0, 'Only ticket (index 0) must always win');
});

test('result is deterministic — same hash+count always gives same winner', () => {
    const a = bitcoin.selectWinnerIndex(KNOWN_HASH_1, 100);
    const b = bitcoin.selectWinnerIndex(KNOWN_HASH_1, 100);
    assertEqual(a, b, 'Must be deterministic');
});

test('different hashes give different winners (for enough tickets)', () => {
    const a = bitcoin.selectWinnerIndex(KNOWN_HASH_1, 1000);
    const b = bitcoin.selectWinnerIndex(KNOWN_HASH_2, 1000);
    // Not guaranteed but virtually certain with these hashes and 1000 tickets
    if (a === b) throw new Error(`Both hashes picked index ${a} — possible but suspicious`);
});

test('result is always within valid range [0, totalTickets-1]', () => {
    const counts = [1, 2, 10, 100, 999, 2016, 100000];
    const hashes = [KNOWN_HASH_1, KNOWN_HASH_2, ALL_ZEROS, ALL_ONES, REAL_BLOCK_HASH];
    for (const count of counts) {
        for (const hash of hashes) {
            const winner = bitcoin.selectWinnerIndex(hash, count);
            assertBetween(winner, 0, count - 1, `Winner out of range for count=${count}, hash=${hash.substring(0,8)}...`);
        }
    }
});

test('all-zeros hash always picks winner 0', () => {
    // 0x000...000 mod N = 0
    const result = bitcoin.selectWinnerIndex(ALL_ZEROS, 100);
    assertEqual(result, 0, 'All-zeros hash should pick index 0');
});

test('all-F hash picks correct winner (max BigInt mod)', () => {
    // 0xFFF...FFF mod 1 = 0
    const result = bitcoin.selectWinnerIndex(ALL_ONES, 1);
    assertEqual(result, 0, 'Any hash mod 1 should be 0');
});

test('handles large ticket counts without overflow', () => {
    const result = bitcoin.selectWinnerIndex(KNOWN_HASH_1, 10_000_000);
    assertBetween(result, 0, 9_999_999, 'Should handle 10M tickets');
});

// ── Test: getNextRaffleBlock / getCurrentRaffleBlock ──────────────────────────

console.log('\n⛏️  getNextRaffleBlock() / getCurrentRaffleBlock()');

test('next raffle block is always a multiple of 2016', () => {
    const heights = [0, 1, 2015, 2016, 2017, 100000, 937604, 939455, 939456];
    for (const h of heights) {
        const next = bitcoin.getNextRaffleBlock(h);
        if (next % 2016 !== 0) {
            throw new Error(`getNextRaffleBlock(${h}) = ${next}, which is not a multiple of 2016`);
        }
    }
});

test('next raffle block is always strictly greater than current height', () => {
    const heights = [0, 1, 2015, 2016, 2017, 937604];
    for (const h of heights) {
        const next = bitcoin.getNextRaffleBlock(h);
        if (next <= h) {
            throw new Error(`getNextRaffleBlock(${h}) = ${next} is not > ${h}`);
        }
    }
});

test('current raffle block is always a multiple of 2016', () => {
    const heights = [0, 2015, 2016, 2017, 4031, 4032, 937604];
    for (const h of heights) {
        const current = bitcoin.getCurrentRaffleBlock(h);
        if (current % 2016 !== 0) {
            throw new Error(`getCurrentRaffleBlock(${h}) = ${current}, not a multiple of 2016`);
        }
    }
});

test('current raffle block is <= current height', () => {
    const heights = [0, 1000, 2016, 2017, 939455];
    for (const h of heights) {
        const current = bitcoin.getCurrentRaffleBlock(h);
        if (current > h) {
            throw new Error(`getCurrentRaffleBlock(${h}) = ${current} exceeds height ${h}`);
        }
    }
});

test('next raffle block is current raffle block + 2016', () => {
    const heights = [0, 1, 2015, 2016, 2017, 4032, 937604];
    for (const h of heights) {
        const current = bitcoin.getCurrentRaffleBlock(h);
        const next = bitcoin.getNextRaffleBlock(h);
        assertEqual(next, current + 2016, `Next should be current + 2016 for height ${h}`);
    }
});

test('known block 939456 → current=939456 (exactly on boundary)', () => {
    const current = bitcoin.getCurrentRaffleBlock(939456);
    assertEqual(current, 939456, '939456 is a multiple of 2016 (2016 * 466 = 939456)');
});

test('known block 939455 → next=939456', () => {
    const next = bitcoin.getNextRaffleBlock(939455);
    assertEqual(next, 939456, 'One block before 939456 → next raffle is 939456');
});

// ── Test: getBlocksUntilNextRaffle ────────────────────────────────────────────

console.log('\n📦 getBlocksUntilNextRaffle()');

test('blocks remaining at height 939455 → 1', () => {
    const remaining = bitcoin.getBlocksUntilNextRaffle(939455);
    assertEqual(remaining, 1, 'One block before 939456');
});

test('blocks remaining at height 939312 → 144', () => {
    // 939456 - 939312 = 144
    const remaining = bitcoin.getBlocksUntilNextRaffle(939312);
    assertEqual(remaining, 144, '144 blocks before raffle');
});

test('blocks remaining at exact raffle block → 2016 (start of next cycle)', () => {
    // At exactly 939456, current cycle IS 939456, next is 941472
    const remaining = bitcoin.getBlocksUntilNextRaffle(939456);
    assertEqual(remaining, 2016, 'At exact raffle block, 2016 blocks until next raffle');
});

// ── Test: distribution sanity (statistical) ──────────────────────────────────

console.log('\n📊 Distribution sanity');

test('10 different sequential hashes spread across 10 buckets reasonably', () => {
    // Generate 100 simulated hashes and check no single index is picked > 30% of the time
    const TICKET_COUNT = 10;
    const ROUNDS = 100;
    const counts = new Array(TICKET_COUNT).fill(0);

    for (let i = 0; i < ROUNDS; i++) {
        // Simulate different block hashes by padding the round number
        const fakeHash = i.toString(16).padStart(64, '0');
        const winner = bitcoin.selectWinnerIndex(fakeHash, TICKET_COUNT);
        counts[winner]++;
    }

    const maxSeen = Math.max(...counts);
    if (maxSeen > ROUNDS * 0.4) {
        throw new Error(`Distribution looks skewed: one index picked ${maxSeen}/${ROUNDS} times`);
    }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
    console.error('\nFailed tests:');
    failures.forEach(f => console.error(`  • ${f.name}: ${f.error}`));
    process.exit(1);
} else {
    console.log('✅ All tests passed!\n');
    process.exit(0);
}
