/**
 * Cline Remote v4.0 — Server
 * 
 * Server-side intelligence: parses Cline CLI JSON output into clean,
 * lightweight messages for the phone client. The phone stays fast because
 * all parsing complexity lives here on the Mac.
 */

import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { spawn, execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { existsSync, readdirSync, statSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || "3000", 10);
const PIN = process.env.PIN || "1234";
const DEFAULT_CWD = process.env.DEFAULT_CWD || os.homedir();
const CLINE_PATH = process.env.CLINE_PATH || "cline";
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE || "10", 10);
const DEFAULT_TIMEOUT = parseInt(process.env.DEFAULT_TIMEOUT || "600", 10);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECTS_JSON = process.env.PROJECTS_JSON || join(dirname(__dirname), "projects.json");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let activeProcess = null;
let activeTask = null;
const taskQueue = [];
const taskLog = [];
const authenticatedClients = new Set();
let taskCounter = 0;

// Conversation continuation — track last Cline task ID per CWD
// Persisted to disk so it survives bridge restarts
const CONV_STATE_FILE = join(__dirname, ".conversation-state.json");
const lastClineTaskIdByCwd = loadConversationState(); // cwd → clineTaskId
let currentClineTaskId = null;

function loadConversationState() {
  try {
    if (existsSync(CONV_STATE_FILE)) {
      const data = JSON.parse(readFileSync(CONV_STATE_FILE, "utf-8"));
      return new Map(Object.entries(data));
    }
  } catch (e) {
    console.log("[conv] Failed to load conversation state:", e.message);
  }
  return new Map();
}

function saveConversationState() {
  try {
    const obj = Object.fromEntries(lastClineTaskIdByCwd);
    writeFileSync(CONV_STATE_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.log("[conv] Failed to save conversation state:", e.message);
  }
}

// Heartbeat / watchdog
let lastOutputTime = null;
let watchdogInterval = null;
let heartbeatInterval = null;
let taskStartTime = null;
let lastEventType = null;
let apiCallCount = 0;
let totalCost = 0;
let currentModel = null;

const WATCHDOG_WARN_MS = 300_000;
const WATCHDOG_STALL_MS = 600_000;

// Output buffer for reconnect replay
const OUTPUT_BUFFER_SIZE = 200;
let outputBuffer = [];
let outputBufferTaskId = null;

// Conversation continuation — skip replayed history during resume
let isReplayingHistory = false;

// Streaming text batching — accumulate partial text, send max every 150ms
let streamingText = "";
let streamingTimer = null;
const STREAM_BATCH_MS = 150;

function pushToOutputBuffer(msg) {
  outputBuffer.push(msg);
  if (outputBuffer.length > OUTPUT_BUFFER_SIZE) outputBuffer.shift();
}

function clearOutputBuffer() {
  outputBuffer = [];
  outputBufferTaskId = null;
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));
app.get("/api/health", (_req, res) => res.json({ status: "ok", version: "4.0.0" }));

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let isAuthenticated = false;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (msg.type === "auth") {
      if (msg.pin === PIN) {
        isAuthenticated = true;
        authenticatedClients.add(ws);
        ws.send(JSON.stringify({ type: "auth", success: true }));
        sendState(ws);
        if (activeTask && outputBuffer.length > 0) {
          for (const m of outputBuffer) ws.send(JSON.stringify(m));
        }
      } else {
        ws.send(JSON.stringify({ type: "auth", success: false, message: "Wrong PIN" }));
      }
      return;
    }

    if (!isAuthenticated) {
      ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
      return;
    }

    switch (msg.type) {
      case "submit-task": handleSubmitTask(ws, msg); break;
      case "cancel-task": handleCancelTask(ws, msg); break;
      case "get-state": sendState(ws); break;
      case "list-dirs": handleListDirs(ws, msg); break;
      case "create-dir": handleCreateDir(ws, msg); break;
      case "task-respond": handleTaskRespond(ws, msg); break;
      case "list-projects": handleListProjects(ws); break;
      case "clear-conversation": {
        const cwd = msg.cwd || DEFAULT_CWD;
        lastClineTaskIdByCwd.delete(cwd);
        saveConversationState();
        ws.send(JSON.stringify({ type: "conversation-cleared", cwd }));
        console.log(`[clear] Conversation cleared for ${cwd}`);
        break;
      }
      default:
        ws.send(JSON.stringify({ type: "error", message: `Unknown: ${msg.type}` }));
    }
  });

  ws.on("close", () => authenticatedClients.delete(ws));
});

// ---------------------------------------------------------------------------
// Broadcast (only clean messages go to clients)
// ---------------------------------------------------------------------------
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of authenticatedClients) {
    if (c.readyState === 1) c.send(data);
  }
  // Buffer for replay (skip status-only messages)
  if (msg.type !== "status" && msg.type !== "heartbeat") {
    pushToOutputBuffer(msg);
  }
}

function sendState(ws) {
  ws.send(JSON.stringify({
    type: "state",
    activeTask: activeTask ? { id: activeTask.id, prompt: activeTask.prompt, cwd: activeTask.cwd } : null,
    queueLength: taskQueue.length,
    recentTasks: taskLog.slice(-20).reverse(),
    defaultCwd: DEFAULT_CWD,
    model: currentModel,
    apiCallCount,
    totalCost,
  }));
}

// ---------------------------------------------------------------------------
// Task submission
// ---------------------------------------------------------------------------
function handleSubmitTask(ws, msg) {
  const prompt = (msg.prompt || "").trim();
  if (!prompt) { ws.send(JSON.stringify({ type: "error", message: "Empty prompt" })); return; }

  const cwd = msg.cwd || DEFAULT_CWD;
  if (!existsSync(cwd)) {
    try { mkdirSync(cwd, { recursive: true }); } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: `Can't create dir: ${err.message}` }));
      return;
    }
  }

  // Handle "new conversation" — clear stored conversation for this CWD
  if (msg.newConversation) {
    lastClineTaskIdByCwd.delete(cwd);
    console.log(`[submit] New conversation requested for ${cwd}`);
  }

  // Check for previous conversation to continue
  // Priority: 1) server's persisted state, 2) client's localStorage-backed resumeTaskId
  const continueTaskId = lastClineTaskIdByCwd.get(cwd) || msg.resumeTaskId || null;

  taskCounter++;
  const task = {
    id: `task-${taskCounter}`,
    prompt,
    cwd,
    mode: msg.mode === "plan" ? "plan" : "act",
    yolo: msg.yolo !== false,
    timeout: msg.timeout || DEFAULT_TIMEOUT,
    model: (msg.model || "").trim(),
    continueTaskId, // Cline task ID to resume, or null for new conversation
  };

  if (activeProcess) {
    if (taskQueue.length >= MAX_QUEUE_SIZE) {
      ws.send(JSON.stringify({ type: "error", message: "Queue full" }));
      return;
    }
    taskQueue.push(task);
    broadcast({ type: "queued", taskId: task.id, prompt: task.prompt, position: taskQueue.length });
  } else {
    startTask(task);
  }
}

// ---------------------------------------------------------------------------
// Start task
// ---------------------------------------------------------------------------
function startTask(task) {
  activeTask = task;
  clearOutputBuffer();
  outputBufferTaskId = task.id;
  lastEventType = "starting";
  apiCallCount = 0;
  totalCost = 0;
  currentModel = null;
  streamingText = "";
  currentClineTaskId = null;

  // For continuations, skip replayed history messages until resume_task ask
  isReplayingHistory = !!task.continueTaskId;
  // Safety timeout: if resume_task ask never arrives, stop filtering after 30s
  if (isReplayingHistory) {
    setTimeout(() => {
      if (isReplayingHistory) {
        console.log(`[${task.id}] History replay safety timeout — forcing resume`);
        isReplayingHistory = false;
      }
    }, 30_000);
  }

  const logEntry = {
    id: task.id, prompt: task.prompt, cwd: task.cwd, mode: task.mode,
    status: "running", startedAt: new Date().toISOString(), output: [],
  };
  taskLog.push(logEntry);
  if (taskLog.length > 50) taskLog.splice(0, taskLog.length - 50);

  const isContinuation = !!task.continueTaskId;
  broadcast({
    type: "task-started", taskId: task.id, prompt: task.prompt, cwd: task.cwd, mode: task.mode,
    continuing: isContinuation, clineTaskId: task.continueTaskId || null,
  });

  // Build CLI args — note: --taskId (-T) is a TOP-LEVEL flag, not a task subcommand flag
    let args;
    if (task.continueTaskId) {
      // Resume: use top-level flags (not "task" subcommand)
      args = ["-T", task.continueTaskId, task.prompt];
      args.push(task.mode === "plan" ? "--plan" : "--act");
      if (task.yolo) { args.push("--yolo"); args.push("--timeout", String(task.timeout)); }
      args.push("--cwd", task.cwd);
      args.push("--json");
      if (task.model) args.push("--model", task.model);
      console.log(`[${task.id}] Continuing conversation ${task.continueTaskId}`);
    } else {
      // New task: use "task" subcommand
      args = ["task", task.prompt];
      args.push(task.mode === "plan" ? "--plan" : "--act");
      if (task.yolo) { args.push("--yolo"); args.push("--timeout", String(task.timeout)); }
      args.push("--cwd", task.cwd);
      args.push("--json");
      if (task.model) args.push("--model", task.model);
    }

  console.log(`[${task.id}] Starting: ${CLINE_PATH} ${args.join(" ")}`);

  const proc = spawn(CLINE_PATH, args, {
    cwd: task.cwd,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  activeProcess = proc;

  // Heartbeat
  taskStartTime = Date.now();
  lastOutputTime = Date.now();
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (!activeTask) { clearInterval(heartbeatInterval); return; }
    const elapsed = Math.round((Date.now() - taskStartTime) / 1000);
    const idle = lastOutputTime ? Math.round((Date.now() - lastOutputTime) / 1000) : elapsed;
    broadcast({
      type: "heartbeat", taskId: task.id, elapsed, idle,
      phase: lastEventType || "starting",
      model: currentModel, apiCalls: apiCallCount, cost: totalCost,
    });
  }, 3000);

  // Watchdog
  let watchdogWarned = false;
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(() => {
    if (!lastOutputTime || !activeProcess) return;
    const idle = Date.now() - lastOutputTime;
    if (idle >= WATCHDOG_STALL_MS) {
      broadcast({ type: "stalled", taskId: task.id, idle: Math.round(idle / 1000) });
      clearInterval(watchdogInterval); watchdogInterval = null;
    } else if (idle >= WATCHDOG_WARN_MS && !watchdogWarned) {
      watchdogWarned = true;
      broadcast({ type: "status", text: `No output for ${Math.round(idle / 1000)}s — LLM may still be thinking` });
    }
  }, 15_000);

  // -----------------------------------------------------------------------
  // Parse Cline JSON stdout → clean client messages
  // -----------------------------------------------------------------------
  let stdoutBuf = "";

  proc.stdout.on("data", (chunk) => {
    lastOutputTime = Date.now();
    stdoutBuf += chunk.toString();

    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.substring(0, nl).trim();
      stdoutBuf = stdoutBuf.substring(nl + 1);
      if (!line) continue;

      logEntry.output.push(line);

      let parsed;
      try { parsed = JSON.parse(line); } catch {
        // Non-JSON line — skip (don't spam client)
        console.log(`[${task.id}] non-json: ${line.substring(0, 80)}`);
        continue;
      }

      processCliMessage(task.id, parsed);
    }
  });

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (!text) return;
    lastOutputTime = Date.now();
    logEntry.output.push(`[stderr] ${text}`);
    broadcast({ type: "error-output", taskId: task.id, text });
  });

  proc.on("close", (code) => {
    cleanup();
    // Flush any remaining streaming text
    flushStreamingText(task.id);
    
    if (stdoutBuf.trim()) {
      try {
        processCliMessage(task.id, JSON.parse(stdoutBuf.trim()));
      } catch {}
    }

    const status = code === 0 ? "completed" : "failed";
    logEntry.status = status;
    logEntry.endedAt = new Date().toISOString();
    console.log(`[${task.id}] Finished: ${status} (exit ${code})`);

    // Save Cline task ID for conversation continuation (persisted to disk)
    if (currentClineTaskId && task.cwd) {
      lastClineTaskIdByCwd.set(task.cwd, currentClineTaskId);
      saveConversationState();
      console.log(`[${task.id}] Saved conversation ${currentClineTaskId} for ${task.cwd}`);
    }

    broadcast({
      type: "task-done", taskId: task.id, status, exitCode: code,
      clineTaskId: currentClineTaskId || null,
    });
    activeProcess = null;
    activeTask = null;

    if (taskQueue.length > 0) startTask(taskQueue.shift());
  });

  proc.on("error", (err) => {
    cleanup();
    logEntry.status = `error: ${err.message}`;
    logEntry.endedAt = new Date().toISOString();
    broadcast({ type: "task-done", taskId: task.id, status: "error", error: err.message });
    activeProcess = null;
    activeTask = null;
    if (taskQueue.length > 0) startTask(taskQueue.shift());
  });
}

function cleanup() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }
  if (streamingTimer) { clearTimeout(streamingTimer); streamingTimer = null; }
  taskStartTime = null;
}

// ---------------------------------------------------------------------------
// Process a single Cline CLI JSON message → emit clean client message(s)
// ---------------------------------------------------------------------------
function processCliMessage(taskId, msg) {
  // Task started (from Cline) — capture the Cline task ID for conversation continuation
  if (msg.type === "task_started") {
    if (msg.taskId) {
      currentClineTaskId = msg.taskId;
      if (activeTask) {
        activeTask.clineTaskId = msg.taskId;
      }
      console.log(`[${taskId}] ✅ Captured Cline task ID: ${msg.taskId}`);
    } else {
      console.log(`[${taskId}] ⚠️ task_started but no taskId field! msg keys: ${Object.keys(msg).join(",")}`);
    }
    return;
  }

  // During conversation continuation, skip replayed history until resume_task ask
  if (isReplayingHistory) {
    const askType = msg.ask || (msg.type === "ask" ? msg.ask : null);
    if (askType === "resume_task" || askType === "resume_completed_task") {
      // This marks the end of history replay — the CLI auto-feeds the prompt as response
      isReplayingHistory = false;
      console.log(`[${taskId}] History replay complete, resuming conversation`);
      return; // Don't forward the resume_task ask to client
    }
    // Still replaying — extract model info but don't broadcast
    if (msg.modelInfo && msg.modelInfo.modelId) {
      currentModel = msg.modelInfo.modelId;
    }
    return; // Skip all replayed history messages
  }

  // Model info extraction
  if (msg.modelInfo && msg.modelInfo.modelId) {
    currentModel = msg.modelInfo.modelId;
  }

  const say = msg.say || msg.type;
  lastEventType = say;

  switch (say) {
    case "task":
      // Initial task echo — we already showed this, skip
      if (currentModel) {
        broadcast({ type: "model", taskId, model: currentModel, provider: msg.modelInfo?.providerId });
      }
      break;

    case "api_req_started":
      // LLM API call started — DON'T send the huge request text to client
      // Just tell client we're thinking
      apiCallCount++;
      let thinkingLabel = "Thinking...";
      try {
        const info = JSON.parse(msg.text);
        const req = info.request || "";
        if (req.includes("[ERROR]")) thinkingLabel = "Retrying after error...";
        else if (req.includes("<task>")) thinkingLabel = "Processing task...";
        else if (req.includes("[write_to_file") || req.includes("[replace_in_file")) thinkingLabel = "File saved → next step...";
        else if (req.includes("[execute_command")) thinkingLabel = "Command done → analyzing...";
        else if (req.includes("[read_file")) thinkingLabel = "File read → analyzing...";
        else if (req.includes("[search_files") || req.includes("[list_files")) thinkingLabel = "Search done → analyzing...";
        else if (req.includes("Result:")) thinkingLabel = "Processing result...";
      } catch {}
      broadcast({ type: "thinking", taskId, label: thinkingLabel, apiCall: apiCallCount, model: currentModel });
      break;

    case "api_req_finished":
      // Extract cost info only
      try {
        const info = JSON.parse(msg.text);
        if (info.cost != null) {
          totalCost += Number(info.cost);
          broadcast({ type: "cost", taskId, cost: Number(info.cost), total: totalCost, apiCall: apiCallCount });
        }
      } catch {}
      break;

    case "text":
      // Assistant text — batch streaming updates
      if (msg.text && msg.text.trim().length > 0) {
        if (msg.partial) {
          // Accumulate and batch-send
          streamingText = msg.text;
          if (!streamingTimer) {
            streamingTimer = setTimeout(() => {
              streamingTimer = null;
              if (streamingText) {
                broadcast({ type: "text", taskId, text: streamingText, partial: true });
              }
            }, STREAM_BATCH_MS);
          }
        } else {
          // Final text — send immediately
          flushStreamingText(taskId);
          broadcast({ type: "text", taskId, text: msg.text, partial: false });
        }
      }
      break;

    case "tool":
      // Tool use — parse and send clean summary
      flushStreamingText(taskId);
      try {
        const toolInfo = JSON.parse(msg.text);
        broadcast({
          type: "tool",
          taskId,
          tool: toolInfo.tool || toolInfo.name || "unknown",
          path: toolInfo.path || toolInfo.command || toolInfo.regex || "",
          content: (toolInfo.content || "").substring(0, 2000), // Limit content size
          diff: toolInfo.diff ? toolInfo.diff.substring(0, 2000) : undefined,
        });
      } catch {
        broadcast({ type: "tool", taskId, tool: "tool", path: "", content: msg.text?.substring(0, 500) || "" });
      }
      break;

    case "command":
      flushStreamingText(taskId);
      broadcast({ type: "command", taskId, command: msg.text || "" });
      break;

    case "command_output":
      broadcast({ type: "command-output", taskId, text: (msg.text || "").substring(0, 3000) });
      break;

    case "completion_result":
      flushStreamingText(taskId);
      broadcast({ type: "result", taskId, text: msg.text || "" });
      // completion_result is ALSO an ask — Cline is waiting for user to accept or provide follow-up
      // If we don't send this ask, the widget never shows Accept/Retry buttons
      if (msg.ask === "completion_result") {
        broadcast({ type: "ask", taskId, askType: "completion_result", text: msg.text || "" });
      }
      break;

    case "task_progress":
      broadcast({ type: "progress", taskId, text: msg.text || "" });
      break;

    case "user_feedback":
      broadcast({ type: "user-msg", taskId, text: msg.text || "" });
      break;

    case "error":
      broadcast({ type: "error-output", taskId, text: msg.text || "Unknown error" });
      break;

    default:
      // For ask messages
      if (msg.ask || msg.type === "ask") {
        flushStreamingText(taskId);
        broadcast({
          type: "ask",
          taskId,
          askType: msg.ask || "followup",
          text: msg.text || "",
        });
        return;
      }
      // Skip unknown message types silently
      console.log(`[${taskId}] skip: ${say}`);
  }
}

function flushStreamingText(taskId) {
  if (streamingTimer) { clearTimeout(streamingTimer); streamingTimer = null; }
  if (streamingText) {
    broadcast({ type: "text", taskId, text: streamingText, partial: true });
    streamingText = "";
  }
}

// ---------------------------------------------------------------------------
// Cancel task
// ---------------------------------------------------------------------------
function handleCancelTask(ws, msg) {
  if (activeTask && activeTask.id === msg.taskId && activeProcess) {
    activeProcess.kill("SIGTERM");
    ws.send(JSON.stringify({ type: "cancelled", taskId: msg.taskId }));
    return;
  }
  const idx = taskQueue.findIndex((t) => t.id === msg.taskId);
  if (idx !== -1) {
    taskQueue.splice(idx, 1);
    ws.send(JSON.stringify({ type: "cancelled", taskId: msg.taskId }));
    return;
  }
  ws.send(JSON.stringify({ type: "error", message: `Task not found: ${msg.taskId}` }));
}

// ---------------------------------------------------------------------------
// Task respond (write to stdin)
// ---------------------------------------------------------------------------
function handleTaskRespond(ws, msg) {
  if (!activeProcess || !activeTask) {
    ws.send(JSON.stringify({ type: "error", message: "No active task" }));
    return;
  }
  const response = msg.response || "";
  console.log(`[${activeTask.id}] User: ${response.substring(0, 100)}`);
  try {
    activeProcess.stdin.write(response + "\n");
    broadcast({ type: "user-msg", taskId: activeTask.id, text: response });
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: `Stdin error: ${err.message}` }));
  }
}

// ---------------------------------------------------------------------------
// Projects list (from projects.json)
// ---------------------------------------------------------------------------
function handleListProjects(ws) {
  try {
    if (!existsSync(PROJECTS_JSON)) {
      ws.send(JSON.stringify({ type: "projects", projects: [], error: "projects.json not found" }));
      return;
    }
    const raw = JSON.parse(readFileSync(PROJECTS_JSON, "utf-8"));
    const baseDir = dirname(PROJECTS_JSON);
    const projects = Object.entries(raw).map(([key, p]) => ({
      key,
      name: p.name || key,
      dir: join(baseDir, p.dir || key),
      description: p.description || "",
      category: p.category || "other",
      tags: p.tags || [],
      type: p.type || "local",
      liveUrl: p.liveUrl || null,
    }));
    ws.send(JSON.stringify({ type: "projects", projects }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "projects", projects: [], error: err.message }));
  }
}

// ---------------------------------------------------------------------------
// Directory browsing
// ---------------------------------------------------------------------------
function handleListDirs(ws, msg) {
  const parentDir = msg.path || os.homedir();
  try {
    const resolved = resolve(parentDir);
    if (!existsSync(resolved)) {
      ws.send(JSON.stringify({ type: "dirs", path: resolved, dirs: [], error: "Path does not exist" }));
      return;
    }
    const entries = readdirSync(resolved)
      .filter((name) => {
        if (name.startsWith(".")) return false;
        if (["node_modules", "Library", "Applications"].includes(name)) return false;
        try { return statSync(join(resolved, name)).isDirectory(); } catch { return false; }
      })
      .sort();
    ws.send(JSON.stringify({ type: "dirs", path: resolved, dirs: entries }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "dirs", path: parentDir, dirs: [], error: err.message }));
  }
}

function handleCreateDir(ws, msg) {
  const parentDir = msg.parentPath || "";
  const name = (msg.name || "").trim();
  if (!name || /[\/\\:*?"<>|]/.test(name)) {
    ws.send(JSON.stringify({ type: "error", message: "Invalid folder name" }));
    return;
  }
  try {
    const newPath = join(resolve(parentDir), name);
    if (existsSync(newPath)) { ws.send(JSON.stringify({ type: "error", message: "Already exists" })); return; }
    mkdirSync(newPath, { recursive: true });
    ws.send(JSON.stringify({ type: "dir-created", path: newPath, name }));
    handleListDirs(ws, { path: resolve(parentDir) });
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: err.message }));
  }
}

// ---------------------------------------------------------------------------
// Network IP
// ---------------------------------------------------------------------------
function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const config of iface || []) {
      if (config.family === "IPv4" && !config.internal) return config.address;
    }
  }
  return "localhost";
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, "0.0.0.0", () => {
  const ip = getLocalIP();
  console.log(`\n🚀 Cline Remote v4.0`);
  console.log(`   Local:  http://localhost:${PORT}`);
  console.log(`   Phone:  http://${ip}:${PORT}`);
  console.log(`   PIN:    ${PIN}`);
  console.log(`   Cline:  ${CLINE_PATH}`);
  console.log(`   CWD:    ${DEFAULT_CWD}\n`);
});

setInterval(() => {
  for (const c of wss.clients) { if (c.readyState === 1) c.ping(); }
}, 30_000);

process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down...");
  cleanup();
  if (activeProcess) activeProcess.kill("SIGTERM");
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  cleanup();
  if (activeProcess) activeProcess.kill("SIGTERM");
  server.close(() => process.exit(0));
});
