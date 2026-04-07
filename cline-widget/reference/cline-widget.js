/* ── Cline Floating Widget for EveryVGames ──────────────
 *
 * Admin-only floating chat panel that connects to a Cline Bridge
 * (PhoneConnectionToCline or future cloud server) via WebSocket.
 *
 * Features:
 *   - Draggable, resizable floating panel
 *   - Screenshot capture (hides panel first) via html2canvas
 *   - Auto-collects page context (URL, user, viewport)
 *   - Full Cline output stream: thinking, tool cards, text, commands, results
 *   - Ask/respond UI for interactive Cline sessions
 *   - Configurable bridge URL + PIN (stored in localStorage)
 *
 * Architecture: designed so the bridge backend (currently local Mac)
 * can be swapped for a cloud server without changing this client code.
 * ─────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────
  const LS_PREFIX = 'cline_widget_';
  const DEFAULT_BRIDGE_URL = ''; // Auto-discovered from /api/bridge-url
  const DEFAULT_POS = { top: 80, right: 20, width: 480, height: 550 };
  const CWD = '/Users/nick/ActiveProjects/EveryVPoker';
  const STREAM_BATCH_MS = 100;

  // ── State ──────────────────────────────────────────
  let isAdmin = false;
  let adminName = '';
  let adminPubkey = '';
  let ws = null;
  let wsAuthed = false;
  let wsReconTimer = null;
  let wsReconDelay = 1000;
  let wsIntentionalClose = false;
  let panelOpen = false;
  let configOpen = false;
  let activeTask = null;
  let lastClineTaskId = localStorage.getItem(LS_PREFIX + 'last_task_id') || null; // Track for conversation continuation
  let streamEl = null;
  let streamText = '';
  let streamTimer = null;
  let currentModel = '';
  let totalCost = 0;
  let apiCallCount = 0;

  // DOM refs (set after build)
  let els = {};

  // ── Helpers ────────────────────────────────────────
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const lsGet = (k, def) => localStorage.getItem(LS_PREFIX + k) || def;
  const lsSet = (k, v) => localStorage.setItem(LS_PREFIX + k, v);

  function esc(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
  }

  function md(text) {
    let h = esc(text);
    h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_, l, c) => `<pre><code>${c.trim()}</code></pre>`);
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/^- \[x\] (.+)$/gm, '<li>☑ $1</li>');
    h = h.replace(/^- \[ \] (.+)$/gm, '<li>☐ $1</li>');
    h = h.replace(/^- (.+)$/gm, '<li>$1</li>');
    h = h.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    h = h.replace(/\n/g, '<br>');
    h = h.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_, c) =>
      `<pre><code>${c.replace(/<br>/g, '\n')}</code></pre>`);
    return h;
  }

  function shortModel(m) {
    return (m || '').replace('anthropic/', '').replace('openai/', '').replace(/-\d{8}$/, '');
  }

  // ── Admin Check ────────────────────────────────────
  async function checkAdmin() {
    try {
      const token = localStorage.getItem('evp_token') || '';
      if (!token) return;
      const res = await fetch('/api/admin/auth-status', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.ok && data.is_admin) {
        isAdmin = true;
        adminName = data.display_name || '';
        adminPubkey = data.pubkey || '';
        init();
      }
    } catch (e) {
      // Not admin or not logged in — don't show widget
    }
  }

  // ── Build DOM ──────────────────────────────────────
  function init() {
    // Load CSS
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/static/css/cline-widget.css';
    document.head.appendChild(link);

    // Load html2canvas from CDN
    const h2c = document.createElement('script');
    h2c.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    document.head.appendChild(h2c);

    // FAB button
    const fab = document.createElement('button');
    fab.className = 'cline-fab';
    fab.id = 'cline-fab';
    fab.innerHTML = '🤖';
    fab.title = 'Open Cline Assistant';
    fab.onclick = togglePanel;
    document.body.appendChild(fab);

    // Panel
    const panel = document.createElement('div');
    panel.className = 'cline-panel hidden';
    panel.id = 'cline-panel';

    // Restore position
    const pos = JSON.parse(lsGet('pos', JSON.stringify(DEFAULT_POS)));
    panel.style.top = pos.top + 'px';
    panel.style.right = pos.right + 'px';
    panel.style.width = pos.width + 'px';
    panel.style.height = pos.height + 'px';

    panel.innerHTML = `
      <!-- Title bar -->
      <div class="cline-titlebar" id="cline-titlebar">
        <span class="cline-titlebar-icon">🤖</span>
        <span class="cline-titlebar-text">Cline</span>
        <span class="cline-titlebar-status" id="cline-conn-status">
          <span class="cline-dot off" id="cline-conn-dot"></span>
          <span id="cline-conn-label">Disconnected</span>
        </span>
        <div class="cline-titlebar-btns">
          <button id="cline-btn-cancel" class="cline-cancel-btn hidden" title="Cancel task">✕ Stop</button>
          <button id="cline-btn-newchat" title="Start new conversation">✚ New</button>
          <button id="cline-btn-config" title="Settings">⚙</button>
          <button id="cline-btn-close" title="Close">✕</button>
        </div>
      </div>

      <!-- Config bar -->
      <div class="cline-config hidden" id="cline-config">
        <label>Bridge:</label>
        <input type="text" id="cline-cfg-url" placeholder="ws://localhost:3000" />
        <label>PIN:</label>
        <input type="password" id="cline-cfg-pin" placeholder="****" maxlength="8" />
        <button id="cline-cfg-connect">Connect</button>
      </div>

      <!-- Stats bar -->
      <div class="cline-stats hidden" id="cline-stats">
        <span>🧠 <span id="cline-stat-model">—</span></span>
        <span>💰 <span id="cline-stat-cost">$0.00</span></span>
        <span>📡 <span id="cline-stat-calls">0</span> calls</span>
      </div>

      <!-- Status strip (thinking) -->
      <div class="cline-status-strip hidden" id="cline-status-strip">
        <div class="cline-status-spinner"></div>
        <span id="cline-status-label">Thinking...</span>
      </div>

      <!-- Messages -->
      <div class="cline-messages" id="cline-messages">
        <div class="cline-empty">
          <div class="cline-empty-icon">🤖</div>
          <div class="cline-empty-text">Cline Assistant</div>
          <div class="cline-empty-hint">Connect to your Cline bridge and send a task</div>
        </div>
      </div>

      <!-- Ask bar -->
      <div class="cline-ask hidden" id="cline-ask">
        <div class="cline-ask-label" id="cline-ask-label"></div>
        <div class="cline-ask-buttons" id="cline-ask-buttons"></div>
        <div class="cline-ask-input">
          <input type="text" id="cline-ask-input" placeholder="Type a response..." />
          <button id="cline-ask-send">Send</button>
        </div>
      </div>

      <!-- Input area -->
      <div class="cline-input-area" id="cline-input-area">
        <div class="cline-input-row">
          <textarea id="cline-prompt" placeholder="Describe a task for Cline..." rows="2"></textarea>
          <button class="cline-send-btn" id="cline-send">Send</button>
        </div>
        <div class="cline-input-options">
          <label><input type="checkbox" id="cline-opt-screenshot" checked /> 📸 Screenshot</label>
          <label><input type="checkbox" id="cline-opt-context" checked /> 📋 Context</label>
          <label title="Auto-approve file edits &amp; commands within EveryVPoker project folder"><input type="checkbox" id="cline-opt-yolo" checked /> 🚀 YOLO</label>
          <span class="cline-context-info" id="cline-context-info"></span>
        </div>
      </div>

      <!-- Resize handle -->
      <div class="cline-resize" id="cline-resize"></div>
    `;

    document.body.appendChild(panel);

    // Cache refs
    els = {
      fab: $('#cline-fab'),
      panel: $('#cline-panel'),
      titlebar: $('#cline-titlebar'),
      connDot: $('#cline-conn-dot'),
      connLabel: $('#cline-conn-label'),
      btnCancel: $('#cline-btn-cancel'),
      btnNewChat: $('#cline-btn-newchat'),
      btnConfig: $('#cline-btn-config'),
      btnClose: $('#cline-btn-close'),
      config: $('#cline-config'),
      cfgUrl: $('#cline-cfg-url'),
      cfgPin: $('#cline-cfg-pin'),
      cfgConnect: $('#cline-cfg-connect'),
      stats: $('#cline-stats'),
      statModel: $('#cline-stat-model'),
      statCost: $('#cline-stat-cost'),
      statCalls: $('#cline-stat-calls'),
      statusStrip: $('#cline-status-strip'),
      statusLabel: $('#cline-status-label'),
      messages: $('#cline-messages'),
      ask: $('#cline-ask'),
      askLabel: $('#cline-ask-label'),
      askButtons: $('#cline-ask-buttons'),
      askInput: $('#cline-ask-input'),
      askSend: $('#cline-ask-send'),
      inputArea: $('#cline-input-area'),
      prompt: $('#cline-prompt'),
      sendBtn: $('#cline-send'),
      optScreenshot: $('#cline-opt-screenshot'),
      optContext: $('#cline-opt-context'),
      optYolo: $('#cline-opt-yolo'),
      contextInfo: $('#cline-context-info'),
      resize: $('#cline-resize'),
    };

    // Restore config
    els.cfgUrl.value = lsGet('bridge_url', DEFAULT_BRIDGE_URL);
    els.cfgPin.value = lsGet('bridge_pin', '');

    // Event listeners
    els.btnClose.onclick = () => togglePanel();
    els.btnConfig.onclick = () => {
      configOpen = !configOpen;
      els.config.classList.toggle('hidden', !configOpen);
    };
    els.cfgConnect.onclick = () => connectBridge();
    els.sendBtn.onclick = () => submitTask();
    els.btnCancel.onclick = () => cancelTask();
    els.btnNewChat.onclick = () => startNewConversation();
    els.askSend.onclick = () => {
      const t = els.askInput.value.trim();
      if (t) respond(t);
    };
    els.askInput.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); els.askSend.click(); }
    };

    // Ctrl/Cmd+Enter to send
    els.prompt.onkeydown = e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submitTask();
      }
    };

    // Auto-resize textarea
    els.prompt.oninput = () => {
      els.prompt.style.height = 'auto';
      els.prompt.style.height = Math.min(els.prompt.scrollHeight, 120) + 'px';
    };

    // Update context info periodically
    updateContextInfo();
    setInterval(updateContextInfo, 5000);

    // Dragging
    setupDrag();
    // Resizing
    setupResize();

    // Restore previous conversation messages if continuing
    restoreMessages();

    // Auto-connect if we have a PIN (URL will be fetched from API)
    if (els.cfgPin.value) {
      connectBridge();
    }
  }

  // ── Panel Toggle ───────────────────────────────────
  function togglePanel() {
    panelOpen = !panelOpen;
    els.panel.classList.toggle('hidden', !panelOpen);
    els.fab.classList.toggle('has-activity', false);
    if (panelOpen) {
      els.prompt.focus();
      scrollMessages();
    }
  }

  // ── Context Info ───────────────────────────────────
  function updateContextInfo() {
    if (!els.contextInfo) return;
    const page = location.pathname;
    els.contextInfo.textContent = `${page} · ${adminName || 'admin'}`;
  }

  function gatherContext() {
    return {
      url: location.href,
      pathname: location.pathname,
      page: detectPageName(),
      admin_name: adminName,
      admin_pubkey: adminPubkey ? adminPubkey.substring(0, 16) + '...' : '',
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      timestamp: new Date().toISOString(),
      user_agent: navigator.userAgent.substring(0, 80),
    };
  }

  function detectPageName() {
    const path = location.pathname;
    if (path === '/' || path === '/lobby') return 'Poker Lobby';
    if (path.startsWith('/game/')) return 'Poker Table (' + path.split('/')[2] + ')';
    if (path === '/admin') return 'Admin Dashboard';
    if (path === '/chess') return 'Chess Lobby';
    if (path.startsWith('/chess/')) return 'Chess Game (' + path.split('/')[2] + ')';
    if (path === '/history') return 'Hand History';
    return path;
  }

  function formatContext(ctx) {
    return [
      `[Page Context]`,
      `- URL: ${ctx.url}`,
      `- Page: ${ctx.page}`,
      `- Admin: ${ctx.admin_name} (${ctx.admin_pubkey})`,
      `- Viewport: ${ctx.viewport}`,
      `- Time: ${ctx.timestamp}`,
    ].join('\n');
  }

  // ── Screenshot ─────────────────────────────────────
  async function captureScreenshot() {
    if (typeof html2canvas !== 'function') {
      console.warn('html2canvas not loaded');
      return null;
    }
    // Hide panel and fab
    els.panel.style.display = 'none';
    els.fab.style.display = 'none';

    // Small delay for repaint
    await new Promise(r => setTimeout(r, 50));

    try {
      const canvas = await html2canvas(document.body, {
        scale: 0.5, // Half resolution to keep size reasonable
        logging: false,
        useCORS: true,
        backgroundColor: '#0a0a1a',
      });
      const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
      return dataUrl;
    } catch (e) {
      console.error('Screenshot failed:', e);
      return null;
    } finally {
      // Re-show panel and fab
      els.panel.style.display = '';
      els.fab.style.display = '';
    }
  }

  // ── WebSocket Bridge ───────────────────────────────
  async function connectBridge() {
    let url = '';

    // ALWAYS fetch fresh bridge URL from API (Cloudflare tunnel URL changes on every restart)
    try {
      const res = await fetch('/api/bridge-url');
      const data = await res.json();
      if (data.ok && data.url) {
        url = data.url.replace(/^https?:\/\//, 'wss://').replace(/\/$/, '');
        els.cfgUrl.value = url;
        console.log('[cline-widget] Bridge URL from API:', url);
      }
    } catch (e) {
      console.warn('[cline-widget] Bridge URL API failed, using cached:', e.message);
      url = els.cfgUrl.value.trim(); // Fall back to cached/manual value
    }

    if (!url) {
      setConnStatus('off', 'No bridge URL');
      configOpen = true;
      els.config.classList.remove('hidden');
      return;
    }

    const pin = els.cfgPin.value.trim();

    lsSet('bridge_url', url);
    lsSet('bridge_pin', pin);

    // Clear any pending reconnect
    if (wsReconTimer) { clearTimeout(wsReconTimer); wsReconTimer = null; }

    if (ws) {
      wsIntentionalClose = true;
      ws.close();
      ws = null;
    }

    wsAuthed = false;
    wsIntentionalClose = false;
    setConnStatus('off', 'Connecting...');

    try {
      ws = new WebSocket(url);
    } catch (e) {
      setConnStatus('off', 'Invalid URL');
      return;
    }

    ws.onopen = () => {
      wsReconDelay = 1000;
      if (pin) {
        wsSend({ type: 'auth', pin });
      } else {
        setConnStatus('off', 'Need PIN');
        configOpen = true;
        els.config.classList.remove('hidden');
      }
    };

    ws.onmessage = e => {
      try {
        handleBridgeMessage(JSON.parse(e.data));
      } catch (err) {
        console.error('Bridge message parse error:', err);
      }
    };

    ws.onclose = () => {
      wsAuthed = false;
      if (wsIntentionalClose) return; // Don't reconnect on intentional close
      setConnStatus('off', 'Disconnected');
      reconBridge();
    };

    ws.onerror = () => {};
  }

  function reconBridge() {
    if (wsReconTimer) return;
    wsReconTimer = setTimeout(() => {
      wsReconTimer = null;
      if (els.cfgUrl.value && els.cfgPin.value) {
        connectBridge();
      }
    }, wsReconDelay);
    wsReconDelay = Math.min(wsReconDelay * 1.5, 15000);
  }

  function wsSend(msg) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }

  function setConnStatus(cls, label) {
    els.connDot.className = 'cline-dot ' + cls;
    els.connLabel.textContent = label;
  }

  // ── Handle Bridge Messages ─────────────────────────
  function handleBridgeMessage(m) {
    switch (m.type) {
      case 'auth':
        if (m.success) {
          wsAuthed = true;
          setConnStatus('ok', 'Connected');
          configOpen = false;
          els.config.classList.add('hidden');
          wsSend({ type: 'get-state' });
        } else {
          setConnStatus('off', 'Auth failed');
          configOpen = true;
          els.config.classList.remove('hidden');
        }
        break;

      case 'state':
        if (m.activeTask) {
          activeTask = m.activeTask;
          setConnStatus('busy', 'Running');
          els.btnCancel.classList.remove('hidden');
          els.stats.classList.remove('hidden');
          if (m.model) { currentModel = m.model; els.statModel.textContent = shortModel(m.model); }
          if (m.totalCost) { totalCost = m.totalCost; els.statCost.textContent = '$' + totalCost.toFixed(4); }
        }
        break;

      case 'task-started':
        activeTask = { id: m.taskId, prompt: m.prompt, cwd: m.cwd };
        streamEl = null;
        streamText = '';
        // Only clear messages for new conversations, not continuations
        if (!m.continuing) {
          els.messages.innerHTML = '';
          currentModel = '';
          totalCost = 0;
          apiCallCount = 0;
          els.statModel.textContent = '—';
          els.statCost.textContent = '$0.00';
          els.statCalls.textContent = '0';
        }
        setConnStatus('busy', 'Running');
        els.btnCancel.classList.remove('hidden');
        els.stats.classList.remove('hidden');
        // Remove empty state if present
        const empty = els.messages.querySelector('.cline-empty');
        if (empty) empty.remove();
        // Add a separator for continuations, or show the task for new conversations
        if (m.continuing) {
          addDivider();
        }
        addUserMsg('📋 ' + m.prompt);
        break;

      case 'model':
        currentModel = m.model || '';
        els.statModel.textContent = shortModel(currentModel);
        break;

      case 'thinking':
        showStatus(m.label + (m.model ? ` · ${shortModel(m.model)}` : ''));
        apiCallCount = m.apiCall || apiCallCount;
        els.statCalls.textContent = apiCallCount;
        break;

      case 'text':
        hideStatus();
        if (m.partial) {
          updateStream(m.text);
        } else {
          finalizeStream(m.text);
        }
        break;

      case 'tool':
        hideStatus();
        finalizeStream();
        addToolCard(m);
        break;

      case 'command':
        hideStatus();
        finalizeStream();
        addToolCard({ tool: 'execute_command', path: m.command, content: m.command });
        break;

      case 'command-output':
        addToolCard({ tool: 'command_output', path: 'Output', content: m.text });
        break;

      case 'result':
        hideStatus();
        finalizeStream();
        addResult(m.text);
        break;

      case 'progress':
        addProgress(m.text);
        break;

      case 'cost':
        if (m.total != null) { totalCost = m.total; els.statCost.textContent = '$' + totalCost.toFixed(4); }
        if (m.apiCall) { apiCallCount = m.apiCall; els.statCalls.textContent = apiCallCount; }
        break;

      case 'user-msg':
        addUserMsg(m.text);
        break;

      case 'error-output':
        addErrorMsg(m.text);
        break;

      case 'ask':
        hideStatus();
        finalizeStream();
        showAsk(m.askType, m.text);
        break;

      case 'task-done':
        hideStatus();
        hideAsk();
        finalizeStream();
        activeTask = null;
        // Track Cline task ID for conversation continuation (persist across page reloads)
        if (m.clineTaskId) {
          lastClineTaskId = m.clineTaskId;
          lsSet('last_task_id', lastClineTaskId);
        }
        els.btnCancel.classList.add('hidden');
        setConnStatus('ok', 'Connected');
        saveMessages();
        if (m.status === 'completed') {
          // Activity pulse on FAB if panel is closed
          if (!panelOpen) els.fab.classList.add('has-activity');
        }
        break;

      case 'conversation-cleared':
        lastClineTaskId = null;
        localStorage.removeItem(LS_PREFIX + 'last_task_id');
        localStorage.removeItem(LS_PREFIX + 'messages');
        addSystemMsg('🔄 New conversation started');
        break;

      case 'queued':
        addSystemMsg(`Queued at position #${m.position}`);
        break;

      case 'stalled':
        addErrorMsg(`⚠ No output for ${m.idle}s — task may be stalled`);
        break;

      case 'heartbeat':
        if (m.model) { currentModel = m.model; els.statModel.textContent = shortModel(m.model); }
        if (m.cost) { totalCost = m.cost; els.statCost.textContent = '$' + totalCost.toFixed(4); }
        break;

      case 'error':
        addErrorMsg(m.message || 'Unknown error');
        break;
    }
  }

  // ── Submit Task ────────────────────────────────────
  async function submitTask() {
    const text = els.prompt.value.trim();
    if (!text) return;
    if (!wsAuthed) {
      addErrorMsg('Not connected to Cline bridge. Configure and connect first.');
      configOpen = true;
      els.config.classList.remove('hidden');
      return;
    }

    els.sendBtn.disabled = true;
    els.sendBtn.textContent = '...';

    let prompt = text;

    // Gather context
    if (els.optContext.checked) {
      const ctx = gatherContext();
      prompt = formatContext(ctx) + '\n\n' + prompt;
    }

    // Capture screenshot
    if (els.optScreenshot.checked) {
      const screenshot = await captureScreenshot();
      if (screenshot) {
        prompt = prompt + '\n\n[Screenshot of current page attached as base64 JPEG]\n' + screenshot;
      }
    }

    const isYolo = els.optYolo.checked;
    const msg = {
      type: 'submit-task',
      prompt,
      cwd: CWD,
      mode: 'act',
      yolo: isYolo,
      timeout: 600,
    };
    // Continue existing conversation if we have a previous task ID
    if (lastClineTaskId) {
      msg.resumeTaskId = lastClineTaskId;
    }
    wsSend(msg);

    els.prompt.value = '';
    els.prompt.style.height = 'auto';
    els.sendBtn.disabled = false;
    els.sendBtn.textContent = 'Send';
  }

  function cancelTask() {
    if (activeTask) {
      wsSend({ type: 'cancel-task', taskId: activeTask.id });
    }
  }

  function startNewConversation() {
    // Clear the conversation on the bridge server
    wsSend({ type: 'clear-conversation', cwd: CWD });
    // Clear local UI and persisted state
    lastClineTaskId = null;
    localStorage.removeItem(LS_PREFIX + 'last_task_id');
    localStorage.removeItem(LS_PREFIX + 'messages');
    els.messages.innerHTML = `
      <div class="cline-empty">
        <div class="cline-empty-icon">🤖</div>
        <div class="cline-empty-text">New Conversation</div>
        <div class="cline-empty-hint">Send a new task to start fresh</div>
      </div>
    `;
    currentModel = '';
    totalCost = 0;
    apiCallCount = 0;
    els.statModel.textContent = '—';
    els.statCost.textContent = '$0.00';
    els.statCalls.textContent = '0';
    els.stats.classList.add('hidden');
    els.prompt.focus();
  }

  // ── Ask/Respond ────────────────────────────────────
  function showAsk(type, text) {
    // Build a descriptive label based on ask type
    const typeLabels = {
      tool: '🛠 Cline wants to use a tool',
      command: '⚡ Cline wants to run a command',
      command_output: '📤 Command produced output',
      completion_result: '✅ Task complete — type a follow-up or accept',
      followup: '❓ Cline has a follow-up question',
      api_req_failed: '⚠️ API request failed — retry?',
      mistake_limit: '⚠️ Cline hit the mistake limit',
      resume_task: '🔄 Resume previous task?',
      resume_completed_task: '🔄 Task was completed — continue?',
    };
    const label = typeLabels[type] || `Cline needs your response (${type})`;
    els.askLabel.innerHTML = md(label);
    els.askButtons.innerHTML = '';
    els.askInput.value = '';
    els.askInput.placeholder = 'Type a response...';

    if (type === 'tool' || type === 'command') {
      addAskBtn('✅ Approve', 'y', 'yes');
      addAskBtn('❌ Reject', 'n', 'no');
    } else if (type === 'completion_result') {
      addAskBtn('👍 Accept', '', 'yes');
      els.askInput.placeholder = 'Type a follow-up to continue the conversation...';
    } else if (type === 'followup') {
      addAskBtn('Continue', 'continue', '');
      addAskBtn('Stop', 'stop', 'no');
    } else if (type === 'api_req_failed' || type === 'mistake_limit') {
      addAskBtn('🔄 Retry', 'y', 'yes');
      addAskBtn('❌ Stop', 'n', 'no');
    } else if (type === 'resume_task' || type === 'resume_completed_task') {
      addAskBtn('▶ Resume', 'y', 'yes');
      addAskBtn('🗑 Discard', 'n', 'no');
    } else {
      addAskBtn('Yes', 'y', 'yes');
      addAskBtn('No', 'n', 'no');
    }

    els.ask.classList.remove('hidden');
    els.inputArea.style.display = 'none';
    els.askInput.focus();
  }

  function hideAsk() {
    els.ask.classList.add('hidden');
    els.inputArea.style.display = '';
  }

  function addAskBtn(label, value, cls) {
    const b = document.createElement('button');
    b.className = 'cline-ask-btn ' + (cls || '');
    b.textContent = label;
    b.onclick = () => respond(value);
    els.askButtons.appendChild(b);
  }

  function respond(text) {
    // Empty string is valid for Accept (sends empty line to stdin, Cline treats as accept)
    if (text == null) return;
    wsSend({ type: 'task-respond', response: text });
    hideAsk();
    if (text) addUserMsg(text);
  }

  // ── Message Rendering ──────────────────────────────
  const TOOL_ICONS = {
    write_to_file: '📝', replace_in_file: '📝', newFileCreated: '📝',
    read_file: '📖', search_files: '🔍', list_files: '📂',
    list_code_definition_names: '🔍', execute_command: '⚡',
    command_output: '📤', browser_action: '🌐',
    attempt_completion: '✅', ask_followup_question: '❓',
  };

  function addAIMsg(text) {
    const el = document.createElement('div');
    el.className = 'cline-msg cline-msg-ai';
    el.innerHTML = md(text);
    els.messages.appendChild(el);
    scrollMessages();
    trimMessages();
  }

  function addUserMsg(text) {
    const el = document.createElement('div');
    el.className = 'cline-msg cline-msg-user';
    el.textContent = text;
    els.messages.appendChild(el);
    scrollMessages();
    trimMessages();
  }

  function addErrorMsg(text) {
    const el = document.createElement('div');
    el.className = 'cline-msg cline-msg-err';
    el.textContent = text;
    els.messages.appendChild(el);
    scrollMessages();
    trimMessages();
  }

  function addSystemMsg(text) {
    const el = document.createElement('div');
    el.className = 'cline-msg' ;
    el.style.color = '#64748b';
    el.style.fontSize = '11px';
    el.textContent = text;
    els.messages.appendChild(el);
    scrollMessages();
  }

  function addDivider() {
    const el = document.createElement('div');
    el.className = 'cline-divider';
    el.innerHTML = '<span>continuation</span>';
    els.messages.appendChild(el);
    scrollMessages();
  }

  function addProgress(text) {
    const el = document.createElement('div');
    el.className = 'cline-msg cline-msg-progress';
    el.innerHTML = md(text);
    els.messages.appendChild(el);
    scrollMessages();
    trimMessages();
  }

  function addResult(text) {
    const el = document.createElement('div');
    el.className = 'cline-result';
    el.innerHTML = `<div class="cline-result-title">✅ Task Complete</div><div class="cline-result-text">${md(text)}</div>`;
    els.messages.appendChild(el);
    scrollMessages();
  }

  function addToolCard(m) {
    const icon = TOOL_ICONS[m.tool] || '🛠';
    const name = m.tool || 'tool';
    const path = m.path ? String(m.path).split('/').slice(-2).join('/') : '';

    const card = document.createElement('div');
    card.className = 'cline-tool-card';

    const head = document.createElement('div');
    head.className = 'cline-tool-head';
    head.innerHTML = `<span class="cline-tool-icon">${icon}</span><span class="cline-tool-name">${esc(name)}</span><span class="cline-tool-path">${esc(path)}</span><span class="cline-tool-chev">▶</span>`;
    head.onclick = () => card.classList.toggle('open');

    const body = document.createElement('div');
    body.className = 'cline-tool-body';
    const content = m.content || m.diff || '';
    body.textContent = content.length > 3000 ? content.substring(0, 3000) + '\n…' : content;

    card.appendChild(head);
    card.appendChild(body);
    els.messages.appendChild(card);
    scrollMessages();
    trimMessages();
  }

  // ── Streaming Text ─────────────────────────────────
  function updateStream(text) {
    if (!text) return;
    // Remove empty state if present
    const empty = els.messages.querySelector('.cline-empty');
    if (empty) empty.remove();

    if (!streamEl) {
      streamEl = document.createElement('div');
      streamEl.className = 'cline-msg cline-msg-ai streaming';
      els.messages.appendChild(streamEl);
    }
    const display = text.length > 5000 ? text.substring(0, 5000) + '…' : text;
    streamEl.innerHTML = md(display);
    scrollMessages();
  }

  function finalizeStream(text) {
    if (streamEl) {
      if (text) {
        const display = text.length > 5000 ? text.substring(0, 5000) + '…' : text;
        streamEl.innerHTML = md(display);
      }
      streamEl.classList.remove('streaming');
      streamEl = null;
    } else if (text) {
      addAIMsg(text);
    }
    scrollMessages();
  }

  // ── Status Strip ───────────────────────────────────
  function showStatus(label) {
    els.statusStrip.classList.remove('hidden');
    els.statusLabel.textContent = label;
  }

  function hideStatus() {
    els.statusStrip.classList.add('hidden');
  }

  // ── Scroll/Trim ────────────────────────────────────
  let scrollRAF = null;
  function scrollMessages() {
    if (scrollRAF) return;
    scrollRAF = requestAnimationFrame(() => {
      scrollRAF = null;
      els.messages.scrollTop = els.messages.scrollHeight;
    });
  }

  function trimMessages() {
    while (els.messages.children.length > 200) {
      els.messages.removeChild(els.messages.firstChild);
    }
  }

  // ── Dragging ───────────────────────────────────────
  function setupDrag() {
    let isDragging = false;
    let startX, startY, startRight, startTop;

    els.titlebar.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startRight = parseInt(els.panel.style.right) || DEFAULT_POS.right;
      startTop = parseInt(els.panel.style.top) || DEFAULT_POS.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newRight = Math.max(0, startRight - dx);
      const newTop = Math.max(0, startTop + dy);
      els.panel.style.right = newRight + 'px';
      els.panel.style.top = newTop + 'px';
      // Clear left if set
      els.panel.style.left = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        savePosition();
      }
    });
  }

  // ── Resizing ───────────────────────────────────────
  function setupResize() {
    let isResizing = false;
    let startX, startY, startW, startH, startRight;

    els.resize.addEventListener('mousedown', e => {
      isResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startW = els.panel.offsetWidth;
      startH = els.panel.offsetHeight;
      startRight = parseInt(els.panel.style.right) || DEFAULT_POS.right;
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('mousemove', e => {
      if (!isResizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Resize from bottom-left: width grows leftward (increase right offset), height grows down
      const newW = Math.max(360, startW - dx);
      const newH = Math.max(300, startH + dy);
      const newRight = startRight + (startW - newW);
      els.panel.style.width = newW + 'px';
      els.panel.style.height = newH + 'px';
      // Keep right edge stable by adjusting
      els.panel.style.right = Math.max(0, startRight - dx) + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        savePosition();
      }
    });
  }

  function savePosition() {
    const pos = {
      top: parseInt(els.panel.style.top) || DEFAULT_POS.top,
      right: parseInt(els.panel.style.right) || DEFAULT_POS.right,
      width: els.panel.offsetWidth,
      height: els.panel.offsetHeight,
    };
    lsSet('pos', JSON.stringify(pos));
  }

  // ── Message Persistence ────────────────────────────
  function saveMessages() {
    if (!els.messages) return;
    try {
      // Save the last 50 messages' HTML (keep it small for localStorage)
      const html = els.messages.innerHTML;
      // Only save if there's real content (not just the empty state)
      if (!els.messages.querySelector('.cline-empty')) {
        // Truncate to ~200KB max to avoid localStorage quota issues
        const toSave = html.length > 200000 ? html.substring(html.length - 200000) : html;
        lsSet('messages', toSave);
      }
    } catch (e) {
      // localStorage full or unavailable — silently ignore
    }
  }

  function restoreMessages() {
    if (!els.messages) return;
    const saved = lsGet('messages', '');
    if (saved && lastClineTaskId) {
      els.messages.innerHTML = saved;
      // Re-attach click handlers for tool card expand/collapse
      els.messages.querySelectorAll('.cline-tool-head').forEach(head => {
        head.onclick = () => head.parentElement.classList.toggle('open');
      });
      scrollMessages();
    }
  }

  // ── Boot ───────────────────────────────────────────
  // Check admin status after page loads
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAdmin);
  } else {
    checkAdmin();
  }

})();
