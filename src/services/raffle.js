const crypto = require('crypto');

const db = require('./database');
const bitcoin = require('./bitcoin');
const email = require('./email');
const telegram = require('./telegram');

const RAFFLE_PERIOD_BLOCKS = 2016;

function getBaseUrl() {
    return process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
}

function getFundSats() {
    return parseInt(db.getSetting('raffle_fund_sats') || '0', 10) || 0;
}

function buildClaimLink(claimToken) {
    return `${getBaseUrl()}/claim/${claimToken}`;
}

function ticketSummary(ticket) {
    if (!ticket) return null;
    return {
        ticketId: ticket.id,
        email: ticket.email || '',
        lnurl: ticket.lnurl_address || '',
        merchantName: ticket.merchant_name || '',
        reviewLink: ticket.review_link || ''
    };
}

/**
 * Returns the raffle block the admin panel should focus on:
 *   - the latest mined difficulty-adjustment block if it has not been committed;
 *   - otherwise the next difficulty-adjustment block for the upcoming raffle.
 */
async function getRealRafflePreview() {
    const info = await bitcoin.getRaffleInfo();
    const latestMinedRaffleBlock = bitcoin.getCurrentRaffleBlock(info.currentHeight);
    const latestMinedRaffle = latestMinedRaffleBlock > 0 ? db.findRaffleByBlock(latestMinedRaffleBlock) : null;

    const targetBlock = latestMinedRaffleBlock > 0 && !latestMinedRaffle
        ? latestMinedRaffleBlock
        : info.nextRaffleBlock;

    const existingRaffle = db.findRaffleByBlock(targetBlock);
    const tickets = db.getValidTicketsForBlock(targetBlock);
    const fundBeforeSats = getFundSats();
    const prizeAmountSats = Math.floor(fundBeforeSats / 2);
    const fundAfterSats = fundBeforeSats - prizeAmountSats;
    const isMined = info.currentHeight >= targetBlock;
    const dueNow = isMined && !existingRaffle;

    let status = 'upcoming';
    let statusMessage = `Upcoming raffle at block #${targetBlock.toLocaleString()}.`;
    if (existingRaffle) {
        status = 'already_run';
        statusMessage = `Raffle for block #${targetBlock.toLocaleString()} has already been run.`;
    } else if (dueNow && tickets.length > 0 && prizeAmountSats > 0) {
        status = 'ready';
        statusMessage = 'Ready to run now.';
    } else if (dueNow && tickets.length === 0) {
        status = 'no_tickets';
        statusMessage = 'Raffle block is mined, but there are no approved tickets for this period.';
    } else if (dueNow && prizeAmountSats <= 0) {
        status = 'no_fund';
        statusMessage = 'Raffle block is mined, but the prize pool is empty.';
    } else if (!isMined) {
        status = 'not_mined';
        statusMessage = `Waiting for block #${targetBlock.toLocaleString()} to be mined.`;
    }

    return {
        currentHeight: info.currentHeight,
        startBlock: Math.max(0, targetBlock - RAFFLE_PERIOD_BLOCKS),
        endBlock: targetBlock,
        targetBlock,
        latestMinedRaffleBlock,
        nextRaffleBlock: info.nextRaffleBlock,
        blocksUntilTarget: Math.max(0, targetBlock - info.currentHeight),
        timeEstimate: targetBlock === info.nextRaffleBlock ? info.timeEstimate : 'ready now',
        isMined,
        dueNow,
        alreadyRun: !!existingRaffle,
        existingRaffleId: existingRaffle ? existingRaffle.id : null,
        approvedTickets: tickets.length,
        fundBeforeSats,
        prizeAmountSats,
        fundAfterSats,
        canRun: dueNow && !existingRaffle && tickets.length > 0 && prizeAmountSats > 0,
        status,
        statusMessage
    };
}

async function sendWinnerNotifications(winningTicket, prizeSats, claimToken, blockHeight, raffleId, totalTickets) {
    const emailStatus = {
        attempted: false,
        success: false,
        status: 'no_email',
        to: winningTicket.email || '',
        messageId: '',
        error: '',
        dev: false
    };

    if (winningTicket.email) {
        emailStatus.attempted = true;
        try {
            const result = await email.sendWinnerEmail(winningTicket.email, prizeSats, claimToken, blockHeight);
            if (result && result.success && result.dev) {
                emailStatus.success = false;
                emailStatus.status = 'dev_not_sent';
                emailStatus.dev = true;
                emailStatus.error = 'Email service is not configured; dev mode only.';
            } else if (result && result.success) {
                emailStatus.success = true;
                emailStatus.status = 'sent';
                emailStatus.messageId = result.messageId || '';
            } else {
                emailStatus.status = 'failed';
                emailStatus.error = (result && result.error) || 'Email service returned failure';
            }
        } catch (err) {
            emailStatus.status = 'failed';
            emailStatus.error = err.message;
        }
    }

    if (db.setRaffleWinnerEmailStatus) {
        db.setRaffleWinnerEmailStatus(
            raffleId,
            emailStatus.status,
            emailStatus.to,
            emailStatus.messageId,
            emailStatus.error
        );
    }

    // Admin Telegram result is best-effort. It includes enough detail for manual follow-up.
    telegram.notifyRaffleResult(
        { block_height: blockHeight, total_tickets: totalTickets, prize_amount_sats: prizeSats },
        winningTicket,
        db
    ).catch(err => console.error('Telegram raffle notify error:', err));

    // Winner Telegram notification is also best-effort if the winner linked Telegram.
    if (winningTicket.email) {
        const winnerUser = db.findUserByEmail(winningTicket.email);
        if (winnerUser && winnerUser.telegram_chat_id) {
            telegram.notifyWinner(winnerUser.telegram_chat_id, prizeSats, claimToken, blockHeight)
                .catch(err => console.error('Winner Telegram notification error:', err));
        }
    }

    return emailStatus;
}

/**
 * Commit the latest mined, uncommitted real raffle. The browser supplies no block
 * height or prize amount; both are recomputed server-side immediately before commit.
 */
async function commitRealRaffle(options = {}) {
    const notifyWinner = options.notifyWinner !== false;
    const preview = await getRealRafflePreview();

    if (!preview.dueNow || preview.alreadyRun) {
        const err = new Error(preview.alreadyRun ? 'This raffle has already been run.' : 'No mined raffle block is due right now.');
        err.code = 'NOT_DUE';
        err.preview = preview;
        throw err;
    }
    if (preview.approvedTickets <= 0) {
        const err = new Error('No approved tickets for this raffle period.');
        err.code = 'NO_TICKETS';
        err.preview = preview;
        throw err;
    }
    if (preview.prizeAmountSats <= 0) {
        const err = new Error('Prize pool is empty; cannot run a real raffle with a 0-sat prize.');
        err.code = 'NO_PRIZE';
        err.preview = preview;
        throw err;
    }

    const blockHeight = preview.targetBlock;
    const existingRaffle = db.findRaffleByBlock(blockHeight);
    if (existingRaffle) {
        const err = new Error('Raffle already run for this block.');
        err.code = 'DUPLICATE';
        err.raffle = existingRaffle;
        throw err;
    }

    const blockHash = await bitcoin.getBlockHash(blockHeight);
    const tickets = db.getValidTicketsForBlock(blockHeight);
    if (tickets.length === 0) {
        const err = new Error('No approved tickets for this raffle period.');
        err.code = 'NO_TICKETS';
        throw err;
    }

    // Recompute the fund and prize at the last possible moment.
    const fundBeforeSats = getFundSats();
    const prizeSats = Math.floor(fundBeforeSats / 2);
    if (prizeSats <= 0) {
        const err = new Error('Prize pool is empty; cannot run a real raffle with a 0-sat prize.');
        err.code = 'NO_PRIZE';
        throw err;
    }
    const fundAfterSats = fundBeforeSats - prizeSats;

    const winnerIndex = bitcoin.selectWinnerIndex(blockHash, tickets.length);
    const winningTicket = tickets[winnerIndex];

    const raffle = db.createRaffle(
        blockHeight,
        blockHash,
        tickets.length,
        winnerIndex,
        winningTicket.id,
        prizeSats
    );

    db.setSetting('raffle_fund_sats', String(fundAfterSats));
    console.log(`🎯 Real raffle fund: ${fundBeforeSats} - ${prizeSats} = ${fundAfterSats} sats remaining`);

    const claimToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.setRaffleClaimToken(raffle.id, claimToken, expiresAt);
    const claimLink = buildClaimLink(claimToken);

    let emailStatus = {
        attempted: false,
        success: false,
        status: 'skipped',
        to: winningTicket.email || '',
        messageId: '',
        error: '',
        dev: false
    };
    if (notifyWinner) {
        emailStatus = await sendWinnerNotifications(winningTicket, prizeSats, claimToken, blockHeight, raffle.id, tickets.length);
    }

    console.log(`🎰 Real raffle committed! Block #${blockHeight}, winner ticket #${winningTicket.id}, prize ${prizeSats} sats`);
    console.log(`🔗 Claim link: ${claimLink}`);

    return {
        id: raffle.id,
        startBlock: preview.startBlock,
        endBlock: blockHeight,
        blockHeight,
        blockHash,
        totalTickets: tickets.length,
        winnerIndex,
        formula: `int(block_hash) mod ${tickets.length} = ${winnerIndex}`,
        winner: ticketSummary(winningTicket),
        prizeAmountSats: prizeSats,
        fundBeforeSats,
        fundAfterSats,
        claimToken,
        claimLink,
        claimExpiresAt: expiresAt,
        email: emailStatus
    };
}

module.exports = {
    RAFFLE_PERIOD_BLOCKS,
    getRealRafflePreview,
    commitRealRaffle,
    buildClaimLink
};
