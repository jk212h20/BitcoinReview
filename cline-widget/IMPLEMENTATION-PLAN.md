# Cline Widget Integration — BitcoinReview

## Overview

Add an in-page Cline AI assistant widget to BitcoinReview, accessible via secret link + bridge PIN. Cline runs on Nick's Mac and is sandboxed to only read/write BitcoinReview code.

**Key security requirement:** Even with full widget access, Cline CANNOT read or write files outside the BitcoinReview repo. YOLO (auto-approve) is enforced OFF server-side — every file edit and shell command requires human approval through the widget UI.

---

## Architecture

```
Browser (BitcoinReview site)
  └── cline-widget.js (floating panel, WebSocket client)
        │
        │ WSS connection (PIN-authenticated)
        ▼
Cloudflare Tunnel → PhoneConnectionToCline/server.js (bridge on Nick's Mac)
        │
        │ Validates CWD against ALLOWED_CWDS whitelist
        │ Forces --no-yolo per CWD_POLICIES
        │ Passes --allowedDir to Cline CLI
        ▼
Cline CLI (spawned process)
  └── --allowedDir /Users/nick/ActiveProjects/BitcoinReview
      (blocks all file operations outside this directory)
```

---

## Implementation Steps

### Step 1: Bridge Server Security (PhoneConnectionToCline/server.js)

**This is the most critical step — all security enforcement lives here.**

Add `CWD_POLICIES` config and validation to the bridge:

```js
// Add near top of server.js, after Configuration section
const CWD_POLICIES = {
  '/Users/nick/ActiveProjects/BitcoinReview': {
    allowedDir: '/Users/nick/ActiveProjects/BitcoinReview',
    forceYolo: false,          // ALWAYS requires approval — client toggle ignored
    maxTimeout: 600,
  },
  '/Users/nick/ActiveProjects/EveryVPoker': {
    allowedDir: '/Users/nick/ActiveProjects/EveryVPoker',
    forceYolo: null,           // null = respect client's choice (admin's personal use)
    maxTimeout: 600,
  }
};
```

**In `handleSubmitTask()`** — add validation before creating task:

```js
function handleSubmitTask(ws, msg) {
  const prompt = (msg.prompt || "").trim();
  if (!prompt) { ws.send(JSON.stringify({ type: "error", message: "Empty prompt" })); return; }

  const cwd = msg.cwd || DEFAULT_CWD;
  const resolvedCwd = path.resolve(cwd);
  
  // ── CWD WHITELIST CHECK ──
  const policy = Object.entries(CWD_POLICIES).find(([dir]) => 
    resolvedCwd === dir || resolvedCwd.startsWith(dir + '/')
  );
  if (!policy) {
    ws.send(JSON.stringify({ type: "error", message: `CWD not in allowed list: ${resolvedCwd}` }));
    console.log(`[BLOCKED] CWD not allowed: ${resolvedCwd}`);
    return;
  }
  const [policyDir, policyConfig] = policy;
  
  // ... rest of task creation ...
  
  // Apply policy overrides
  const yolo = policyConfig.forceYolo !== null ? policyConfig.forceYolo : (msg.yolo !== false);
  const timeout = Math.min(msg.timeout || DEFAULT_TIMEOUT, policyConfig.maxTimeout || DEFAULT_TIMEOUT);
  
  const task = {
    id: `task-${taskCounter}`,
    prompt,
    cwd: resolvedCwd,
    mode: msg.mode === "plan" ? "plan" : "act",
    yolo,                    // Server-enforced, not client-controlled
    timeout,
    model: (msg.model || "").trim(),
    allowedDir: policyConfig.allowedDir,  // Passed to Cline CLI as --allowedDir
    continueTaskId,
  };
  // ...
}
```

**In `startTask()`** — pass `--allowedDir` to Cline CLI:

```js
// When building CLI args, add:
if (task.allowedDir) {
  args.push("--allowedDir", task.allowedDir);
}
```

### Step 2: Secret Link Auth (BitcoinReview Express middleware)

**File: `src/routes/cline.js`** (new file)

The widget is gated behind a secret token. When someone visits with `?cline_token=<secret>`, the token is validated and stored in a session cookie. Subsequent requests check the cookie.

```js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const CLINE_TOKEN = process.env.CLINE_ACCESS_TOKEN;  // 64-char hex string
const COOKIE_NAME = 'cline_session';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * GET /api/cline/auth-status
 * Check if current user has Cline widget access
 */
router.get('/auth-status', (req, res) => {
  const hasAccess = req.cookies?.[COOKIE_NAME] === 'valid' || 
                    req.query.cline_token === CLINE_TOKEN;
  res.json({ ok: true, hasAccess, name: hasAccess ? 'Collaborator' : null });
});

/**
 * GET /api/cline/activate?cline_token=<secret>
 * Validate token and set session cookie, redirect to homepage
 */
router.get('/activate', (req, res) => {
  if (!CLINE_TOKEN) {
    return res.status(500).json({ error: 'CLINE_ACCESS_TOKEN not configured' });
  }
  
  if (req.query.cline_token !== CLINE_TOKEN) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  // Set session cookie (httpOnly, secure in production)
  res.cookie(COOKIE_NAME, 'valid', {
    maxAge: COOKIE_MAX_AGE,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  });
  
  // Redirect to homepage (token consumed, now in cookie)
  res.redirect('/');
});

/**
 * GET/POST /api/bridge-url
 * Auto-discovery for the Cline bridge WebSocket URL
 */
router.get('/bridge-url', (req, res) => {
  const url = process.env.CLINE_BRIDGE_URL || '';
  res.json({ ok: !!url, url });
});

router.post('/bridge-url', (req, res) => {
  const secret = req.headers['x-bridge-secret'] || req.body.secret;
  if (secret !== process.env.BRIDGE_SECRET) {
    return res.status(401).json({ error: 'Invalid bridge secret' });
  }
  // Store in-memory (or env) — for now just update process.env
  process.env.CLINE_BRIDGE_URL = req.body.url;
  console.log(`[cline] Bridge URL updated: ${req.body.url}`);
  res.json({ ok: true });
});

module.exports = router;
```

**Mount in `src/index.js`:**
```js
const cookieParser = require('cookie-parser');
app.use(cookieParser());

const clineRoutes = require('./routes/cline');
app.use('/api/cline', clineRoutes);
```

### Step 3: Widget Files

Copy widget JS/CSS to BitcoinReview's public directory:

- `public/cline-widget.js` — Adapted from EveryVPoker version (see `reference/cline-widget.js`)
- `public/cline-widget.css` — Same CSS (see `reference/cline-widget.css`)

**Key changes from EveryVPoker version:**
1. `CWD` constant → `/Users/nick/ActiveProjects/BitcoinReview`
2. Admin check calls `/api/cline/auth-status` instead of `/api/admin/auth-status`
3. **YOLO checkbox hidden** — server enforces it OFF, don't confuse users
4. Bridge URL auto-discovery calls `/api/cline/bridge-url` (not `/api/bridge-url`)
5. No admin pubkey tracking (BitcoinReview uses token auth, not Lightning)

### Step 4: Inject Widget in Layout

**File: `src/views/layout.ejs`** — Add before `</body>`:

```html
<!-- Cline AI Widget (loaded only if user has cline_session cookie) -->
<% if (clineAccess) { %>
  <link rel="stylesheet" href="/cline-widget.css">
  <script src="/cline-widget.js"></script>
<% } %>
```

**In the route handler** that renders pages, pass `clineAccess`:
```js
res.render('some-page', { 
  // ...existing locals...
  clineAccess: req.cookies?.cline_session === 'valid'
});
```

Or use middleware to set it globally:
```js
app.use((req, res, next) => {
  res.locals.clineAccess = req.cookies?.cline_session === 'valid';
  next();
});
```

### Step 5: Update Bridge Startup Script

**File: `PhoneConnectionToCline/start-remote.sh`** — Add BitcoinReview URL registration:

```bash
# Register with both apps
TUNNEL_URL=$(cloudflared tunnel ... | grep -o 'https://.*trycloudflare.com')

# EveryVPoker (existing)
curl -s -X POST "https://everyvpoker-production.up.railway.app/api/bridge-url" \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Secret: $BRIDGE_SECRET" \
  -d "{\"url\": \"$TUNNEL_URL\"}"

# BitcoinReview (new)
curl -s -X POST "https://bitcoinreview-production.up.railway.app/api/cline/bridge-url" \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Secret: $BRIDGE_SECRET" \
  -d "{\"url\": \"$TUNNEL_URL\"}"
```

### Step 6: Environment Variables

**BitcoinReview Railway:**
```
CLINE_ACCESS_TOKEN=<generate 64-char hex: openssl rand -hex 32>
BRIDGE_SECRET=<same secret as EveryVPoker>
```

**PhoneConnectionToCline `.env`:**
```
# Already has PIN, add:
# (CWD_POLICIES is hardcoded in server.js, not env var — more secure)
```

### Step 7: Generate Secret Link

After deploying, generate the link:
```bash
TOKEN=$(openssl rand -hex 32)
echo "Set CLINE_ACCESS_TOKEN=$TOKEN on Railway"
echo "Share this link: https://bitcoinreview.app/api/cline/activate?cline_token=$TOKEN"
```

Your partner opens the link once → gets a 7-day cookie → widget appears on all pages.

---

## Security Model

| Layer | Location | What it prevents | Bypassable? |
|-------|----------|-----------------|-------------|
| **Secret link token** | BitcoinReview Express | Unauthorized widget access | Only if token is leaked |
| **Bridge PIN** | Bridge WebSocket auth | Unauthorized Cline access | Only if PIN is leaked |
| **CWD_POLICIES whitelist** | Bridge server.js | Cline working on wrong repos | No — server-side, hardcoded |
| **forceYolo: false** | Bridge server.js | Auto-approving commands | No — server-side, ignores client |
| **--allowedDir** | Cline CLI flag | Reading/writing outside repo | No — Cline CLI enforces |
| **Command approval UI** | Widget ask/respond | Dangerous shell commands | Only if YOLO was on (it's not) |

### What this means in practice:
- ✅ Partner can use Cline to read BitcoinReview code
- ✅ Partner can ask Cline to edit BitcoinReview files (requires approval in widget)
- ✅ Partner can ask Cline to run npm commands etc. (requires approval in widget)
- ❌ Partner CANNOT enable YOLO (server ignores the flag)
- ❌ Partner CANNOT make Cline read files outside BitcoinReview
- ❌ Partner CANNOT make Cline write files outside BitcoinReview
- ❌ Partner CANNOT change which directory Cline works in
- ⚠️ Approved shell commands run as your user (unavoidable without Docker)

### NPM dependency needed:
```bash
npm install cookie-parser
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `public/cline-widget.js` | Create | Widget JS (adapted from reference) |
| `public/cline-widget.css` | Create | Widget CSS |
| `src/routes/cline.js` | Create | Auth + bridge-url endpoints |
| `src/views/layout.ejs` | Modify | Inject widget script conditionally |
| `src/index.js` | Modify | Mount cline routes + cookie-parser |
| `PhoneConnectionToCline/server.js` | Modify | Add CWD_POLICIES + --allowedDir |
| `PhoneConnectionToCline/start-remote.sh` | Modify | Register with BitcoinReview too |

---

## Testing Checklist

- [ ] Visit BitcoinReview normally → no widget visible
- [ ] Visit with `?cline_token=<wrong>` → no widget
- [ ] Visit with `?cline_token=<correct>` → redirected, cookie set, widget FAB visible
- [ ] Open widget → config panel with PIN input
- [ ] Enter correct PIN → "Connected" status
- [ ] Submit a task → Cline starts, shows thinking/text/tool output
- [ ] Tool use → "Approve/Reject" buttons appear (YOLO is OFF)
- [ ] Try submitting with CWD=/Users/nick → "CWD not allowed" error
- [ ] Task completes → Accept/Follow-up buttons appear
- [ ] Close browser, reopen → widget still visible (cookie persists 7 days)
- [ ] From a different browser without token → no widget
