// Focused tests for the real raffle service.
// Uses require-cache mocks so no real DB/network/email calls happen.

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..');
const rafflePath = path.join(ROOT, 'src', 'services', 'raffle.js');
const dbPath = path.join(ROOT, 'src', 'services', 'database.js');
const bitcoinPath = path.join(ROOT, 'src', 'services', 'bitcoin.js');
const emailPath = path.join(ROOT, 'src', 'services', 'email.js');
const telegramPath = path.join(ROOT, 'src', 'services', 'telegram.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => { console.log('  ✅ ' + name); passed++; })
    .catch(e => { console.error('  ❌ ' + name + '\n     ' + e.message); failed++; failures.push({ name, error: e.message }); });
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error((msg || 'assertEqual failed') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function injectMock(resolvedPath, exports) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports,
    children: [],
    paths: Module._nodeModulePaths(path.dirname(resolvedPath))
  };
}

function loadWithMocks({ height = 939456, existing = null, fund = 100001, tickets = null, emailResult = { success: true, messageId: 'msg_123' } } = {}) {
  delete require.cache[rafflePath];

  const state = {
    fund: fund,
    settings: { raffle_fund_sats: String(fund) },
    existing,
    created: null,
    claim: null,
    emailStatus: null,
    tickets: tickets || [
      { id: 10, email: 'a@example.com', lnurl_address: 'a@getalby.com', merchant_name: 'Cafe A', review_link: 'https://reviews/a' },
      { id: 11, email: 'winner@example.com', lnurl_address: 'w@getalby.com', merchant_name: 'Cafe W', review_link: 'https://reviews/w' },
      { id: 12, email: 'c@example.com', lnurl_address: 'c@getalby.com', merchant_name: 'Cafe C', review_link: 'https://reviews/c' }
    ]
  };

  const db = {
    getSetting(key) { return state.settings[key] || null; },
    setSetting(key, value) { state.settings[key] = String(value); if (key === 'raffle_fund_sats') state.fund = parseInt(value, 10); },
    findRaffleByBlock(block) { return state.existing && state.existing.block_height === block ? state.existing : null; },
    getValidTicketsForBlock() { return state.tickets; },
    createRaffle(blockHeight, blockHash, totalTickets, winningIndex, winningTicketId, prizeAmountSats) {
      state.created = { id: 99, blockHeight, blockHash, totalTickets, winningIndex, winningTicketId, prizeAmountSats };
      return { id: 99 };
    },
    setRaffleClaimToken(id, token, expiresAt) { state.claim = { id, token, expiresAt }; },
    setRaffleWinnerEmailStatus(id, status, to, messageId, error) { state.emailStatus = { id, status, to, messageId, error }; },
    findUserByEmail() { return null; }
  };

  const bitcoin = {
    getCurrentRaffleBlock(h) { return Math.floor(h / 2016) * 2016; },
    getNextRaffleBlock(h) { return (Math.floor(h / 2016) + 1) * 2016; },
    async getRaffleInfo() {
      const currentRaffleBlock = this.getCurrentRaffleBlock(height);
      const nextRaffleBlock = this.getNextRaffleBlock(height);
      return { currentHeight: height, currentRaffleBlock, nextRaffleBlock, blocksUntilNext: nextRaffleBlock - height, timeEstimate: '~2 weeks' };
    },
    async getBlockHash() { return '0000000000000000000000000000000000000000000000000000000000000001'; },
    selectWinnerIndex(blockHash, totalTickets) { return Number(BigInt('0x' + blockHash) % BigInt(totalTickets)); }
  };

  const email = { async sendWinnerEmail() { return emailResult; } };
  const telegram = { notifyRaffleResult() { return Promise.resolve(); }, notifyWinner() { return Promise.resolve(); } };

  injectMock(dbPath, db);
  injectMock(bitcoinPath, bitcoin);
  injectMock(emailPath, email);
  injectMock(telegramPath, telegram);

  const raffle = require(rafflePath);
  return { raffle, state };
}

const pending = [];
function asyncTest(name, fn) {
  pending.push(Promise.resolve().then(fn)
    .then(() => { console.log('  ✅ ' + name); passed++; })
    .catch(e => { console.error('  ❌ ' + name + '\n     ' + e.message); failed++; failures.push({ name, error: e.message }); }));
}

console.log('\n🎰 real raffle service');

asyncTest('preview focuses latest mined unrun raffle block at exact boundary', async () => {
  const { raffle } = loadWithMocks({ height: 939456, fund: 100001 });
  const preview = await raffle.getRealRafflePreview();
  assertEqual(preview.startBlock, 937440, 'start block');
  assertEqual(preview.endBlock, 939456, 'end block');
  assertEqual(preview.approvedTickets, 3, 'approved tickets');
  assertEqual(preview.prizeAmountSats, 50000, '50% floor prize');
  assertEqual(preview.fundAfterSats, 50001, 'remaining fund');
  assertEqual(preview.canRun, true, 'can run');
});

asyncTest('commit deducts/reserves 50% prize, creates claim link, and records email status', async () => {
  const { raffle, state } = loadWithMocks({ height: 939456, fund: 100001 });
  const result = await raffle.commitRealRaffle({ notifyWinner: true });
  assertEqual(state.fund, 50001, 'fund deducted');
  assertEqual(state.created.prizeAmountSats, 50000, 'raffle stamped prize');
  assertEqual(state.created.winningTicketId, 11, 'hash 1 mod 3 selects ticket index 1');
  assert(result.claimLink.includes('/claim/'), 'claim link created');
  assertEqual(result.winner.email, 'winner@example.com', 'winner email returned');
  assertEqual(result.email.status, 'sent', 'email sent status');
  assertEqual(state.emailStatus.status, 'sent', 'persisted email status');
});

asyncTest('commit blocks duplicate run for already-created raffle', async () => {
  const { raffle } = loadWithMocks({ height: 939456, existing: { id: 5, block_height: 939456 } });
  let threw = false;
  try { await raffle.commitRealRaffle(); } catch (e) { threw = true; assertEqual(e.code, 'NOT_DUE', 'duplicate-ish code'); }
  assert(threw, 'expected duplicate/not-due error');
});

Promise.all(pending).then(() => {
  console.log('\n' + '─'.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.error('\nFailed tests:');
    failures.forEach(f => console.error('  • ' + f.name + ': ' + f.error));
    process.exit(1);
  }
  console.log('✅ All real raffle tests passed!\n');
});
