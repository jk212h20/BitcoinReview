/**
 * Admin authentication service.
 *
 * Responsibilities:
 *   - Password storage: scrypt-hashed in the settings table (`admin_password_hash`),
 *     with fallback to the ADMIN_PASSWORD env var if no hash is stored yet
 *     (so the first deploy still has a usable login).
 *   - Session: a signed HttpOnly cookie (HMAC-SHA256) containing a 30-day
 *     expiry timestamp. No server-side session store needed.
 *   - Back-compat: existing code paths that pass a raw password (body/header/query)
 *     still work via `verifyPassword`.
 *
 * Why scrypt over bcrypt: it's in Node's stdlib, so no new dependency is needed,
 * and it's memory-hard → resists GPU cracking similarly to argon2/bcrypt.
 */

const crypto = require('crypto');

const COOKIE_NAME = 'admin_session';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SCRYPT_N = 16384;   // CPU/memory cost
const SCRYPT_KEYLEN = 64; // output bytes
const SCRYPT_SALT_BYTES = 16;

/**
 * Derive a 32-byte key from ADMIN_PASSWORD (or a dedicated SESSION_SECRET)
 * to sign session cookies. Rotating ADMIN_PASSWORD automatically invalidates
 * all existing sessions, which is what we want.
 */
function getCookieSigningKey() {
    const secret = process.env.SESSION_SECRET
        || process.env.ADMIN_PASSWORD
        || 'insecure-default-change-me';
    return crypto.createHash('sha256').update('admin-session:' + secret).digest();
}

/**
 * Hash a plaintext password with scrypt + random salt.
 * Output format: `scrypt$N$saltHex$hashHex`
 */
function hashPassword(plain) {
    if (!plain || typeof plain !== 'string') {
        throw new Error('Password must be a non-empty string');
    }
    const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
    const hash = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
    return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Verify a plaintext password against a stored hash (constant-time).
 * Returns boolean.
 */
function verifyHash(plain, stored) {
    if (!plain || !stored) return false;
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
    const N = parseInt(parts[1], 10);
    const salt = Buffer.from(parts[2], 'hex');
    const expected = Buffer.from(parts[3], 'hex');
    try {
        const actual = crypto.scryptSync(plain, salt, expected.length, { N });
        return crypto.timingSafeEqual(actual, expected);
    } catch (e) {
        return false;
    }
}

/**
 * Verify a plaintext password against the currently-active admin password.
 * Priority: stored hash in DB → ADMIN_PASSWORD env var.
 * @param {string} plain - password candidate
 * @param {object} db - database service (must expose getSetting)
 */
function verifyPassword(plain, db) {
    if (!plain) return false;
    try {
        const stored = db && db.getSetting && db.getSetting('admin_password_hash');
        if (stored) {
            return verifyHash(plain, stored);
        }
    } catch (e) { /* fall through to env */ }
    const env = process.env.ADMIN_PASSWORD;
    if (!env) return false;
    // Constant-time env comparison
    const a = Buffer.from(plain);
    const b = Buffer.from(env);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * Set a new admin password (hashed, stored in settings table).
 */
function setPassword(plain, db) {
    const hash = hashPassword(plain);
    db.setSetting('admin_password_hash', hash);
}

// ── Signed cookie session ────────────────────────────────────────────────

/** Sign a payload string → `payload.hmacHex` */
function signToken(payload) {
    const key = getCookieSigningKey();
    const mac = crypto.createHmac('sha256', key).update(payload).digest('hex');
    return payload + '.' + mac;
}

/** Verify a signed token; returns decoded payload object or null */
function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const idx = token.lastIndexOf('.');
    if (idx < 0) return null;
    const payload = token.slice(0, idx);
    const mac = token.slice(idx + 1);
    const key = getCookieSigningKey();
    const expected = crypto.createHmac('sha256', key).update(payload).digest('hex');
    try {
        const a = Buffer.from(mac, 'hex');
        const b = Buffer.from(expected, 'hex');
        if (a.length !== b.length) return null;
        if (!crypto.timingSafeEqual(a, b)) return null;
    } catch (e) { return null; }
    // Payload: base64(JSON)
    try {
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (typeof decoded.exp === 'number' && decoded.exp > Date.now()) {
            return decoded;
        }
        return null;
    } catch (e) { return null; }
}

/** Build a fresh signed session token with a 30-day exp */
function createSessionToken() {
    const payload = { sub: 'admin', exp: Date.now() + COOKIE_MAX_AGE_MS };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return signToken(encoded);
}

/** Parse cookies from a request (no cookie-parser dependency) */
function parseCookies(req) {
    const out = {};
    const header = req.headers && req.headers.cookie;
    if (!header) return out;
    header.split(';').forEach(pair => {
        const eq = pair.indexOf('=');
        if (eq < 0) return;
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        if (k) out[k] = decodeURIComponent(v);
    });
    return out;
}

/**
 * Write the session cookie on the response.
 * Uses Secure when BASE_URL is https (production); otherwise omits so localhost works.
 */
function setSessionCookie(res, req) {
    const token = createSessionToken();
    const isHttps = (req && ((req.protocol === 'https') || (req.headers && req.headers['x-forwarded-proto'] === 'https')))
        || /^https:/i.test(process.env.BASE_URL || '');
    const parts = [
        `${COOKIE_NAME}=${encodeURIComponent(token)}`,
        'Path=/',
        `Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`,
        'HttpOnly',
        'SameSite=Lax'
    ];
    if (isHttps) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

/** Clear the session cookie (logout) */
function clearSessionCookie(res) {
    res.setHeader('Set-Cookie',
        `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
    );
}

/** Does the request carry a valid admin session cookie? */
function hasValidSession(req) {
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME];
    return !!verifyToken(token);
}

/**
 * Unified check used by admin routes:
 *   1. Valid signed session cookie → OK
 *   2. Valid password via header/body/query → OK (refresh cookie if res provided)
 *
 * Returns true/false. Optionally refreshes the session cookie when authed
 * via legacy password path (sliding-window behavior).
 */
function isAuthenticated(req, res, db) {
    if (hasValidSession(req)) {
        // Sliding refresh: re-issue cookie so the 30 days extends on activity
        if (res && !res.headersSent) {
            try { setSessionCookie(res, req); } catch (e) {}
        }
        return true;
    }
    const pw = (req.headers && req.headers['x-admin-password'])
        || (req.body && req.body.password)
        || (req.query && req.query.password);
    if (pw && verifyPassword(pw, db)) {
        if (res && !res.headersSent) {
            try { setSessionCookie(res, req); } catch (e) {}
        }
        return true;
    }
    return false;
}

module.exports = {
    COOKIE_NAME,
    hashPassword,
    verifyHash,
    verifyPassword,
    setPassword,
    createSessionToken,
    parseCookies,
    setSessionCookie,
    clearSessionCookie,
    hasValidSession,
    isAuthenticated
};
