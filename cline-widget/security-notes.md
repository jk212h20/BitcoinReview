# Cline Widget Security Model

## Threat Model

### Who has access?
- **Nick** (admin): Full access, can toggle YOLO on EveryVPoker (but not BitcoinReview)
- **Partner** (collaborator): Secret link + bridge PIN → sandboxed to BitcoinReview, YOLO always OFF

### Attack Vectors & Mitigations

| Vector | Risk | Mitigation |
|--------|------|-----------|
| Secret link leaked | Someone gets widget UI access | Still needs bridge PIN (2nd factor). Revoke by changing `CLINE_ACCESS_TOKEN` env var |
| Bridge PIN leaked | Someone can submit tasks | `--allowedDir` + `CWD_POLICIES` limit damage to BitcoinReview only. YOLO forced OFF |
| Both leaked | Full widget access | Cline sandboxed to repo. Every action needs human approval. Revoke token + change PIN |
| XSS on BitcoinReview | Could steal cookie/PIN from localStorage | Secret link cookie is `httpOnly` (JS can't read it). PIN in localStorage is the main risk — but attacker would also need bridge to be running |
| Partner modifies widget JS in browser DevTools | Could try to send `yolo: true` or different CWD | Server ignores client YOLO flag. CWD whitelist is server-side. No bypass possible |
| Shell command escape | Approved `npm install` could run postinstall scripts | This is the residual risk — approved commands run as Nick's user. Mitigated by human review of every command |

### What the bridge enforces (server-side, not bypassable):

1. **CWD_POLICIES whitelist**: Only pre-approved directories can be used
2. **forceYolo: false**: BitcoinReview always requires manual approval regardless of client request
3. **--allowedDir flag**: Cline CLI refuses to read/write/list/search files outside the allowed directory tree
4. **PIN auth**: WebSocket connection requires correct PIN before any messages are accepted

### Secret Link Design

- Token: 64 hex chars (256 bits of entropy) — unguessable
- On first visit with `?cline_token=<token>`, server sets httpOnly session cookie (7-day expiry)
- Subsequent visits check cookie — token no longer needed in URL
- Token not stored in browser history after redirect (consumed immediately)
- Revocation: Change `CLINE_ACCESS_TOKEN` env var on Railway → all existing cookies invalidated (cookie value is 'valid' but auth-status endpoint re-checks)

**Wait — the cookie value is just 'valid', not tied to the token.** This means changing the token won't invalidate existing cookies. To fix this, the cookie should contain an HMAC of the token, and the auth-status check should verify it. The implementation plan's route code should be updated to:

```js
// Cookie value = HMAC(CLINE_TOKEN, 'cline-session')
// Verification: recompute HMAC and compare
const cookieValue = crypto.createHmac('sha256', CLINE_TOKEN).update('cline-session').digest('hex');
res.cookie(COOKIE_NAME, cookieValue, { ... });

// In auth-status:
const expected = crypto.createHmac('sha256', CLINE_TOKEN).update('cline-session').digest('hex');
const hasAccess = req.cookies?.[COOKIE_NAME] === expected;
```

This way, rotating `CLINE_ACCESS_TOKEN` invalidates all existing cookies.

### Residual Risks (accepted)

1. **Approved shell commands** run as Nick's macOS user — no OS-level sandboxing
2. **Bridge must be running** on Nick's Mac for any of this to work (intentional — Cline is local)
3. **Cloudflare tunnel** is the public entry point — if Cloudflare is compromised, traffic could be intercepted (extremely unlikely)
