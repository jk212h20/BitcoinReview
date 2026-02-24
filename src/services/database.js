const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'reviews.db');

// Ensure the directory for the database file exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

let db = null;

// Initialize database
async function initializeDatabase() {
    console.log(`📂 Database path: ${dbPath}`);
    console.log(`📂 Database directory: ${dbDir} (exists: ${fs.existsSync(dbDir)})`);
    const SQL = await initSqlJs();
    
    // Load existing database or create new one
    if (fs.existsSync(dbPath)) {
        const fileBuffer = fs.readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }
    
    // Create tables
    db.run(`
        -- Users / participants (email and lnurl are both optional)
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE,
            lnurl_address TEXT,
            opt_out_token TEXT UNIQUE,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        -- Submitted reviews (raffle tickets)
        CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            review_link TEXT NOT NULL,
            review_text TEXT,
            merchant_name TEXT,
            is_valid INTEGER DEFAULT 0,
            validation_reason TEXT,
            raffle_block INTEGER,
            submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        -- Deposit addresses (track all addresses generated for this app)
        CREATE TABLE IF NOT EXISTS deposit_addresses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            address TEXT NOT NULL,
            type TEXT NOT NULL,
            is_active INTEGER DEFAULT 1,
            amount_received_sats INTEGER DEFAULT 0,
            payment_hash TEXT,
            invoice TEXT,
            memo TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            received_at TEXT
        );

        -- Submitted reviews (raffle tickets) - add is_featured if missing
        -- (handled below via ALTER TABLE for existing DBs)

        -- Raffle history
        CREATE TABLE IF NOT EXISTS raffles (
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
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (winning_ticket_id) REFERENCES tickets(id)
        );
    `);
    
    // Settings table (key-value store for admin config)
    db.run(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
    
    // Add merchant_name column to tickets if it doesn't exist (migration for existing DBs)
    try {
        db.run(`ALTER TABLE tickets ADD COLUMN merchant_name TEXT`);
        console.log('✅ Added merchant_name column to tickets');
    } catch (e) {
        // Column already exists — that's fine
    }

    // Add tried_bitcoin and merchant_accepted columns (migration for existing DBs)
    try {
        db.run(`ALTER TABLE tickets ADD COLUMN tried_bitcoin INTEGER`);
        console.log('✅ Added tried_bitcoin column to tickets');
    } catch (e) { /* already exists */ }
    try {
        db.run(`ALTER TABLE tickets ADD COLUMN merchant_accepted INTEGER`);
        console.log('✅ Added merchant_accepted column to tickets');
    } catch (e) { /* already exists */ }

    // Add is_featured column to tickets if it doesn't exist (migration for existing DBs)
    try {
        db.run(`ALTER TABLE tickets ADD COLUMN is_featured INTEGER DEFAULT 0`);
        console.log('✅ Added is_featured column to tickets');
    } catch (e) {
        // Column already exists — that's fine
    }

    // Add telegram_chat_id column to users table (for player win notifications via Telegram)
    try {
        db.run(`ALTER TABLE users ADD COLUMN telegram_chat_id TEXT`);
        console.log('✅ Added telegram_chat_id column to users');
    } catch (e) { /* already exists */ }

    // LNURL-withdraw claim columns on raffles table (migration for existing DBs)
    try {
        db.run(`ALTER TABLE raffles ADD COLUMN claim_token TEXT`);
        console.log('✅ Added claim_token column to raffles');
    } catch (e) { /* already exists */ }
    try {
        db.run(`ALTER TABLE raffles ADD COLUMN claim_status TEXT DEFAULT 'pending'`);
        console.log('✅ Added claim_status column to raffles');
    } catch (e) { /* already exists */ }
    try {
        db.run(`ALTER TABLE raffles ADD COLUMN claim_expires_at TEXT`);
        console.log('✅ Added claim_expires_at column to raffles');
    } catch (e) { /* already exists */ }
    try {
        db.run(`ALTER TABLE raffles ADD COLUMN claimed_at TEXT`);
        console.log('✅ Added claimed_at column to raffles');
    } catch (e) { /* already exists */ }
    try {
        db.run(`ALTER TABLE raffles ADD COLUMN claim_payment_hash TEXT`);
        console.log('✅ Added claim_payment_hash column to raffles');
    } catch (e) { /* already exists */ }

    // Insert default settings if they don't exist
    const defaultSettings = [
        ['review_mode', 'manual_review'],       // 'auto_approve' or 'manual_review'
        ['review_link_mode', 'google'],         // 'google' or 'all' (all = major review sites)
        ['google_api_key', ''],
        ['raffle_auto_trigger', 'false'],        // 'true' or 'false'
        ['raffle_warning_sent_block', '0'],      // block number of last sent 144-warning
        ['raffle_block_notified', '0'],          // block number of last block-mined notification
        ['extra_telegram_chats', ''],            // comma-separated extra admin chat IDs
        ['pending_telegram_message', ''],        // queued message held during quiet hours
        ['raffle_fund_sats', '0']               // dedicated raffle prize pool balance (sats)
    ];
    for (const [key, value] of defaultSettings) {
        db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [key, value]);
    }
    
    // Create indexes
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_lnurl ON users(lnurl_address);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_opt_out_token ON users(opt_out_token);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets(user_id);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tickets_raffle_block ON tickets(raffle_block);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tickets_is_valid ON tickets(is_valid);`);
    
    saveDatabase();
    console.log('✅ Database initialized');
}

// Save database to file
function saveDatabase() {
    if (db) {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(dbPath, buffer);
    }
}

// Helper to run query and get results
function query(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

// Helper to run query and get single result
function queryOne(sql, params = []) {
    const results = query(sql, params);
    return results.length > 0 ? results[0] : null;
}

// Helper to run insert/update and return lastInsertRowid
function run(sql, params = []) {
    db.run(sql, params);
    // IMPORTANT: get last_insert_rowid BEFORE saveDatabase() — db.export() resets it
    const result = db.exec("SELECT last_insert_rowid() as id");
    const lastId = result.length > 0 ? result[0].values[0][0] : null;
    saveDatabase();
    return lastId;
}

// User functions
function createUser(email, lnurlAddress, optOutToken) {
    try {
        const id = run(
            `INSERT INTO users (email, lnurl_address, opt_out_token) VALUES (?, ?, ?)`,
            [email || null, lnurlAddress || null, optOutToken]
        );
        return { id };
    } catch (error) {
        if (error.message.includes('UNIQUE constraint failed')) {
            return { error: 'Email already registered' };
        }
        throw error;
    }
}

function findUserByEmail(email) {
    if (!email) return null;
    return queryOne(`SELECT * FROM users WHERE email = ? AND is_active = 1`, [email]);
}

function findUserByLnurl(lnurlAddress) {
    if (!lnurlAddress) return null;
    return queryOne(`SELECT * FROM users WHERE lnurl_address = ? AND is_active = 1`, [lnurlAddress]);
}

/**
 * Find or create a user based on email and/or lnurl.
 * Tries to match by email first, then lnurl, then creates new.
 * Updates existing user with new info if found.
 */
function findOrCreateUser(email, lnurlAddress, optOutToken) {
    let user = null;
    
    // Try to find by email first
    if (email) {
        user = findUserByEmail(email);
    }
    
    // Try to find by lnurl if not found by email
    if (!user && lnurlAddress) {
        user = findUserByLnurl(lnurlAddress);
    }
    
    if (user) {
        // Update user with any new info
        let updated = false;
        if (email && !user.email) {
            run(`UPDATE users SET email = ? WHERE id = ?`, [email, user.id]);
            updated = true;
        }
        if (lnurlAddress && !user.lnurl_address) {
            run(`UPDATE users SET lnurl_address = ? WHERE id = ?`, [lnurlAddress, user.id]);
            updated = true;
        }
        // Also update lnurl if user had one but provided a new one
        if (lnurlAddress && user.lnurl_address && lnurlAddress !== user.lnurl_address) {
            run(`UPDATE users SET lnurl_address = ? WHERE id = ?`, [lnurlAddress, user.id]);
            updated = true;
        }
        // Re-fetch if updated
        if (updated) {
            user = queryOne(`SELECT * FROM users WHERE id = ?`, [user.id]);
        }
        return { user, created: false };
    }
    
    // Create new user
    const result = createUser(email, lnurlAddress, optOutToken);
    if (result.error) {
        return { error: result.error };
    }
    
    if (!result.id) {
        console.error('createUser returned no id:', JSON.stringify(result));
        // Try to find the user we just created by email or lnurl
        if (email) {
            user = queryOne(`SELECT * FROM users WHERE email = ?`, [email]);
        }
        if (!user && lnurlAddress) {
            user = queryOne(`SELECT * FROM users WHERE lnurl_address = ?`, [lnurlAddress]);
        }
    } else {
        user = queryOne(`SELECT * FROM users WHERE id = ?`, [result.id]);
    }
    
    return { user, created: true };
}

function findUserByOptOutToken(token) {
    return queryOne(`SELECT * FROM users WHERE opt_out_token = ?`, [token]);
}

function deactivateUser(token) {
    run(`UPDATE users SET is_active = 0 WHERE opt_out_token = ?`, [token]);
}

function getAllUsers() {
    return query(`SELECT * FROM users WHERE is_active = 1 ORDER BY created_at DESC`);
}

function getUserCount() {
    const result = queryOne(`SELECT COUNT(*) as count FROM users WHERE is_active = 1`);
    return result ? result.count : 0;
}

/**
 * Set telegram_chat_id on a user record (for win notifications via Telegram)
 */
function setUserTelegramChatId(userId, chatId) {
    run(`UPDATE users SET telegram_chat_id = ? WHERE id = ?`, [chatId, userId]);
}

/**
 * Check if an email has Telegram linked (returns chat ID or null)
 */
function getUserTelegramStatus(email) {
    if (!email) return null;
    const user = queryOne(`SELECT telegram_chat_id FROM users WHERE email = ? AND is_active = 1`, [email]);
    return user ? user.telegram_chat_id : null;
}

// Ticket functions
function createTicket(userId, reviewLink, reviewText, merchantName, raffleBlock, triedBitcoin, merchantAccepted) {
    const id = run(
        `INSERT INTO tickets (user_id, review_link, review_text, merchant_name, raffle_block, tried_bitcoin, merchant_accepted) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, reviewLink, reviewText, merchantName, raffleBlock, triedBitcoin ? 1 : 0, merchantAccepted ? 1 : 0]
    );
    return { id };
}

function validateTicket(ticketId, isValid, reason) {
    run(
        `UPDATE tickets SET is_valid = ?, validation_reason = ? WHERE id = ?`,
        [isValid ? 1 : 0, reason, ticketId]
    );
}

function updateTicketReviewText(ticketId, reviewText) {
    run(
        `UPDATE tickets SET review_text = ? WHERE id = ?`,
        [reviewText, ticketId]
    );
}

function updateTicketMerchant(ticketId, merchantName) {
    run(
        `UPDATE tickets SET merchant_name = ? WHERE id = ?`,
        [merchantName, ticketId]
    );
}

function findTicketByUserAndLink(userId, reviewLink) {
    return queryOne(`SELECT * FROM tickets WHERE user_id = ? AND review_link = ?`, [userId, reviewLink]);
}

function getValidTicketsForBlock(raffleBlock) {
    return query(`
        SELECT t.*, u.email, u.lnurl_address 
        FROM tickets t 
        JOIN users u ON t.user_id = u.id 
        WHERE t.is_valid = 1 AND t.raffle_block = ? AND u.is_active = 1
        ORDER BY t.id
    `, [raffleBlock]);
}

function getAllTickets() {
    return query(`
        SELECT t.*, u.email, u.lnurl_address
        FROM tickets t 
        LEFT JOIN users u ON t.user_id = u.id 
        ORDER BY t.submitted_at DESC
    `);
}

function getPublicTickets() {
    return query(`
        SELECT t.id, t.review_link, t.review_text, t.merchant_name, t.is_valid, t.validation_reason, t.submitted_at
        FROM tickets t
        ORDER BY t.submitted_at DESC
    `);
}

/**
 * Get only approved tickets for public display.
 * Featured tickets come first, then sorted by submitted_at DESC.
 */
function getApprovedPublicTickets() {
    return query(`
        SELECT t.id, t.review_link, t.review_text, t.merchant_name, t.is_valid, t.validation_reason, t.submitted_at,
               COALESCE(t.is_featured, 0) as is_featured,
               COALESCE(t.tried_bitcoin, 0) as tried_bitcoin,
               COALESCE(t.merchant_accepted, 0) as merchant_accepted
        FROM tickets t
        WHERE t.is_valid = 1
        ORDER BY COALESCE(t.is_featured, 0) DESC, t.submitted_at DESC
    `);
}

/**
 * Set or unset the featured flag on a ticket
 */
function featureTicket(ticketId, isFeatured) {
    run(
        `UPDATE tickets SET is_featured = ? WHERE id = ?`,
        [isFeatured ? 1 : 0, ticketId]
    );
}

function getPendingTickets() {
    return query(`
        SELECT t.*, u.email, u.lnurl_address
        FROM tickets t 
        LEFT JOIN users u ON t.user_id = u.id 
        WHERE t.is_valid = 0 AND t.validation_reason IS NULL
        ORDER BY t.submitted_at DESC
    `);
}

function getUnvalidatedTickets() {
    return query(`
        SELECT t.id, t.review_link, t.review_text, t.merchant_name, t.is_valid, t.validation_reason
        FROM tickets t
        WHERE t.validation_reason IS NULL 
           OR t.validation_reason LIKE 'Auto-validated%'
           OR t.review_text IS NULL
        ORDER BY t.submitted_at ASC
    `);
}

function getTicketById(id) {
    return queryOne(`
        SELECT t.*, u.email, u.lnurl_address 
        FROM tickets t 
        LEFT JOIN users u ON t.user_id = u.id 
        WHERE t.id = ?
    `, [id]);
}

function countValidTicketsForBlock(raffleBlock) {
    const result = queryOne(`
        SELECT COUNT(*) as count 
        FROM tickets t 
        JOIN users u ON t.user_id = u.id 
        WHERE t.is_valid = 1 AND t.raffle_block = ? AND u.is_active = 1
    `, [raffleBlock]);
    return result ? result.count : 0;
}

// Raffle functions
function createRaffle(blockHeight, blockHash, totalTickets, winningIndex, winningTicketId, prizeAmountSats) {
    const id = run(
        `INSERT INTO raffles (block_height, block_hash, total_tickets, winning_index, winning_ticket_id, prize_amount_sats) VALUES (?, ?, ?, ?, ?, ?)`,
        [blockHeight, blockHash, totalTickets, winningIndex, winningTicketId, prizeAmountSats]
    );
    return { id };
}

function findRaffleByBlock(blockHeight) {
    return queryOne(`SELECT * FROM raffles WHERE block_height = ?`, [blockHeight]);
}

function markRafflePaid(raffleId, paymentHash = null) {
    run(`UPDATE raffles SET payment_status = 'paid', payment_hash = ?, paid_at = datetime('now') WHERE id = ?`, [paymentHash, raffleId]);
}

function markRafflePaymentFailed(raffleId, error) {
    run(`UPDATE raffles SET payment_status = 'failed', payment_error = ? WHERE id = ?`, [error, raffleId]);
}

function getUnpaidRaffles() {
    return query(`
        SELECT r.*, t.review_link, u.email, u.lnurl_address
        FROM raffles r
        LEFT JOIN tickets t ON r.winning_ticket_id = t.id
        LEFT JOIN users u ON t.user_id = u.id
        WHERE r.payment_status != 'paid'
        ORDER BY r.created_at DESC
    `);
}

function getAllRaffles() {
    return query(`
        SELECT r.*, t.review_link, u.email, u.lnurl_address
        FROM raffles r
        LEFT JOIN tickets t ON r.winning_ticket_id = t.id
        LEFT JOIN users u ON t.user_id = u.id
        ORDER BY r.created_at DESC
    `);
}

function getMostRecentlyReviewedMerchant() {
    return queryOne(`
        SELECT merchant_name, review_link, submitted_at
        FROM tickets
        WHERE is_valid = 1
          AND merchant_name IS NOT NULL
          AND merchant_name != ''
        ORDER BY submitted_at DESC
        LIMIT 1
    `);
}

function deleteRaffle(raffleId) {
    run(`DELETE FROM raffles WHERE id = ?`, [raffleId]);
}

function getLatestRaffle() {
    return queryOne(`
        SELECT r.*, t.review_link, u.email, u.lnurl_address
        FROM raffles r
        LEFT JOIN tickets t ON r.winning_ticket_id = t.id
        LEFT JOIN users u ON t.user_id = u.id
        ORDER BY r.created_at DESC
        LIMIT 1
    `);
}

// Deposit address functions
function createDepositAddress(address, type, invoice = null, paymentHash = null, memo = null) {
    const id = run(
        `INSERT INTO deposit_addresses (address, type, invoice, payment_hash, memo) VALUES (?, ?, ?, ?, ?)`,
        [address, type, invoice, paymentHash, memo]
    );
    return { id };
}

function getActiveDepositAddress(type) {
    return queryOne(`SELECT * FROM deposit_addresses WHERE type = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1`, [type]);
}

function deactivateDepositAddress(id) {
    run(`UPDATE deposit_addresses SET is_active = 0 WHERE id = ?`, [id]);
}

function deactivateAllDepositAddresses(type) {
    run(`UPDATE deposit_addresses SET is_active = 0 WHERE type = ?`, [type]);
}

function markDepositReceived(id, amountSats) {
    run(`UPDATE deposit_addresses SET amount_received_sats = ?, received_at = datetime('now'), is_active = 0 WHERE id = ?`, [amountSats, id]);
}

function getAllDepositAddresses() {
    return query(`SELECT * FROM deposit_addresses ORDER BY created_at DESC`);
}

function getDepositAddressByAddress(address) {
    return queryOne(`SELECT * FROM deposit_addresses WHERE address = ?`, [address]);
}

function getDepositAddressByPaymentHash(paymentHash) {
    return queryOne(`SELECT * FROM deposit_addresses WHERE payment_hash = ?`, [paymentHash]);
}

function getUnpaidLightningInvoices() {
    return query(`SELECT * FROM deposit_addresses WHERE type = 'lightning' AND payment_hash IS NOT NULL AND received_at IS NULL`);
}

function getTotalDonationsReceived() {
    const result = queryOne(`SELECT SUM(amount_received_sats) as total FROM deposit_addresses WHERE amount_received_sats > 0`);
    return result ? (result.total || 0) : 0;
}

// Claim functions (LNURL-withdraw)
function setRaffleClaimToken(raffleId, claimToken, expiresAt) {
    run(`UPDATE raffles SET claim_token = ?, claim_status = 'pending', claim_expires_at = ? WHERE id = ?`, [claimToken, expiresAt, raffleId]);
}

function findRaffleByClaimToken(token) {
    if (!token) return null;
    return queryOne(`
        SELECT r.*, t.review_link, u.email, u.lnurl_address
        FROM raffles r
        LEFT JOIN tickets t ON r.winning_ticket_id = t.id
        LEFT JOIN users u ON t.user_id = u.id
        WHERE r.claim_token = ?
    `, [token]);
}

function markRaffleClaimed(raffleId, paymentHash) {
    run(`UPDATE raffles SET claim_status = 'claimed', claimed_at = datetime('now'), claim_payment_hash = ?, payment_status = 'paid', paid_at = datetime('now') WHERE id = ?`, [paymentHash, raffleId]);
}

function markRaffleClaimExpired(raffleId) {
    run(`UPDATE raffles SET claim_status = 'expired' WHERE id = ?`, [raffleId]);
}

function getExpiredUnclaimedRaffles() {
    return query(`
        SELECT * FROM raffles 
        WHERE claim_status = 'pending' 
          AND claim_expires_at IS NOT NULL 
          AND claim_expires_at < datetime('now')
    `);
}

// Settings functions
function getSetting(key) {
    const row = queryOne(`SELECT value FROM settings WHERE key = ?`, [key]);
    return row ? row.value : null;
}

function setSetting(key, value) {
    run(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`, [key, value]);
}

function getAllSettings() {
    const rows = query(`SELECT key, value FROM settings`);
    const settings = {};
    for (const row of rows) {
        settings[row.key] = row.value;
    }
    return settings;
}

module.exports = {
    initializeDatabase,
    
    // User functions
    createUser,
    findUserByEmail,
    findUserByLnurl,
    findOrCreateUser,
    findUserByOptOutToken,
    deactivateUser,
    setUserTelegramChatId,
    getUserTelegramStatus,
    getAllUsers,
    getUserCount,
    
    // Ticket functions
    createTicket,
    validateTicket,
    updateTicketReviewText,
    updateTicketMerchant,
    findTicketByUserAndLink,
    getValidTicketsForBlock,
    getAllTickets,
    getPublicTickets,
    getApprovedPublicTickets,
    featureTicket,
    getPendingTickets,
    getUnvalidatedTickets,
    getTicketById,
    countValidTicketsForBlock,
    
    // Raffle functions
    createRaffle,
    findRaffleByBlock,
    markRafflePaid,
    markRafflePaymentFailed,
    getUnpaidRaffles,
    getAllRaffles,
    deleteRaffle,
    getMostRecentlyReviewedMerchant,
    getLatestRaffle,
    
    // Claim functions (LNURL-withdraw)
    setRaffleClaimToken,
    findRaffleByClaimToken,
    markRaffleClaimed,
    markRaffleClaimExpired,
    getExpiredUnclaimedRaffles,
    
    // Deposit address functions
    createDepositAddress,
    getActiveDepositAddress,
    deactivateDepositAddress,
    deactivateAllDepositAddresses,
    markDepositReceived,
    getAllDepositAddresses,
    getDepositAddressByAddress,
    getDepositAddressByPaymentHash,
    getUnpaidLightningInvoices,
    getTotalDonationsReceived,
    
    // Settings functions
    getSetting,
    setSetting,
    getAllSettings
};
