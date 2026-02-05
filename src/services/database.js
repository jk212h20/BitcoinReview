const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'reviews.db');

let db = null;

// Initialize database
async function initializeDatabase() {
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
        -- Users who register for the raffle
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            lnurl_address TEXT NOT NULL,
            opt_out_token TEXT UNIQUE NOT NULL,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        -- Submitted reviews (raffle tickets)
        CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            review_link TEXT NOT NULL,
            review_text TEXT,
            merchant_name TEXT,
            is_valid INTEGER DEFAULT 0,
            validation_reason TEXT,
            raffle_block INTEGER,
            submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        -- Raffle history
        CREATE TABLE IF NOT EXISTS raffles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            block_height INTEGER NOT NULL,
            block_hash TEXT NOT NULL,
            total_tickets INTEGER NOT NULL,
            winning_index INTEGER NOT NULL,
            winning_ticket_id INTEGER,
            prize_amount_sats INTEGER,
            paid_at TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (winning_ticket_id) REFERENCES tickets(id)
        );
    `);
    
    // Create indexes
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
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
    saveDatabase();
    const result = db.exec("SELECT last_insert_rowid() as id");
    return result.length > 0 ? result[0].values[0][0] : null;
}

// User functions
function createUser(email, lnurlAddress, optOutToken) {
    try {
        const id = run(
            `INSERT INTO users (email, lnurl_address, opt_out_token) VALUES (?, ?, ?)`,
            [email, lnurlAddress, optOutToken]
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
    return queryOne(`SELECT * FROM users WHERE email = ? AND is_active = 1`, [email]);
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

// Ticket functions
function createTicket(userId, reviewLink, reviewText, merchantName, raffleBlock) {
    const id = run(
        `INSERT INTO tickets (user_id, review_link, review_text, merchant_name, raffle_block) VALUES (?, ?, ?, ?, ?)`,
        [userId, reviewLink, reviewText, merchantName, raffleBlock]
    );
    return { id };
}

function validateTicket(ticketId, isValid, reason) {
    run(
        `UPDATE tickets SET is_valid = ?, validation_reason = ? WHERE id = ?`,
        [isValid ? 1 : 0, reason, ticketId]
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
        SELECT t.*, u.email 
        FROM tickets t 
        JOIN users u ON t.user_id = u.id 
        ORDER BY t.submitted_at DESC
    `);
}

function getPendingTickets() {
    return query(`
        SELECT t.*, u.email 
        FROM tickets t 
        JOIN users u ON t.user_id = u.id 
        WHERE t.is_valid = 0 AND t.validation_reason IS NULL
        ORDER BY t.submitted_at DESC
    `);
}

function getTicketById(id) {
    return queryOne(`
        SELECT t.*, u.email, u.lnurl_address 
        FROM tickets t 
        JOIN users u ON t.user_id = u.id 
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

function markRafflePaid(raffleId) {
    run(`UPDATE raffles SET paid_at = datetime('now') WHERE id = ?`, [raffleId]);
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

module.exports = {
    initializeDatabase,
    
    // User functions
    createUser,
    findUserByEmail,
    findUserByOptOutToken,
    deactivateUser,
    getAllUsers,
    getUserCount,
    
    // Ticket functions
    createTicket,
    validateTicket,
    findTicketByUserAndLink,
    getValidTicketsForBlock,
    getAllTickets,
    getPendingTickets,
    getTicketById,
    countValidTicketsForBlock,
    
    // Raffle functions
    createRaffle,
    findRaffleByBlock,
    markRafflePaid,
    getAllRaffles,
    getLatestRaffle
};
