#!/usr/bin/env node
// Hub: one browser page per project, listing its git worktrees, each with a terminal
// attached to that worktree's tmux session (the coding agent runs inside it).
//
//   hub [dir]        register the project at dir (default: cwd); starts the server in
//                    the background unless one is already running
//   hub --fg [dir]   same, but serve in the foreground
//   hub stop         stop the background server (tmux sessions stay)
//
//   HUB_PORT=5191        another port (default 5190)
//   HUB_SOCKET=hubtest   another tmux server (keeps tests off the real sessions)
//   HUB_CONFIG_DIR=...   where the project list is kept (default ~/.config/hub)
//   HUB_CMD=''           new sessions start a bare shell, whatever the project config says
//
// Sessions live on a private tmux server (socket `hub`), so they survive the page and
// the hub itself; from any terminal: `tmux -L hub attach -t <session>`.
// Each session has the chat window and, if the project has a dev command, a `dev` one.
//
// Per-project settings come from an optional `.hub.json` in the project root — see README.
import { createServer } from "node:http";
import { execFile, execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { withCodexHooks } from "./codex-status.mjs";
import { CodexRuntime } from "./codex-runtime.mjs";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.HUB_PORT ?? 5190);
const BASE = `http://127.0.0.1:${PORT}`;
const TMUX = ["-L", process.env.HUB_SOCKET ?? "hub", "-f", path.join(HERE, "tmux.conf")];
const CONFIG_DIR = process.env.HUB_CONFIG_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "hub");
const PROJECTS_FILE = path.join(CONFIG_DIR, "projects.json");
const ORDER_FILE = path.join(CONFIG_DIR, "order.json");
const LOG_FILE = path.join(CONFIG_DIR, "hub.log");
const STATES = ["idle", "working", "background", "waiting", "done", "off"];
const DEFAULTS = { agent: "claude", dev: null, port: null, url: "http://localhost:{port}/", worktree: null };

const lib = (spec) => require.resolve(spec);
const STATIC = {
  "/": [path.join(HERE, "public/index.html"), "text/html"],
  "/icon.svg": [path.join(HERE, "public/icon.svg"), "image/svg+xml"],
  "/xterm.css": [lib("@xterm/xterm/css/xterm.css"), "text/css"],
  "/xterm.mjs": [lib("@xterm/xterm").replace(/\.js$/, ".mjs"), "text/javascript"],
  "/addon-fit.mjs": [lib("@xterm/addon-fit").replace(/\.js$/, ".mjs"), "text/javascript"],
  "/addon-web-links.mjs": [lib("@xterm/addon-web-links").replace(/\.js$/, ".mjs"), "text/javascript"],
};

// ---- projects ---------------------------------------------------------------

function gitRoot(dir) {
  try {
    // the main checkout, even when called from inside a linked worktree
    const out = execFileSync("git", ["-C", dir, "worktree", "list", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.match(/^worktree (.+)$/m)[1];
  } catch {
    return null;
  }
}

function loadProjects() {
  try {
    return JSON.parse(readFileSync(PROJECTS_FILE, "utf8")).filter((dir) => existsSync(dir));
  } catch {
    return [];
  }
}

const projects = loadProjects(); // project roots; name = basename
const nameOf = (root) => path.basename(root);
const findProject = (name) => projects.find((root) => nameOf(root) === name) ?? projects[0];

function addProject(root) {
  if (projects.includes(root)) return;
  projects.push(root);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

// project root → its sessions in the order the sidebar shows them (set by dragging rows)
const order = (() => {
  try {
    return JSON.parse(readFileSync(ORDER_FILE, "utf8"));
  } catch {
    return {};
  }
})();

function setOrder(root, sessions) {
  order[root] = sessions;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(ORDER_FILE, JSON.stringify(order, null, 2));
}

function config(root) {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path.join(root, ".hub.json"), "utf8")) };
  } catch {
    return DEFAULTS;
  }
}

// ---- agent status -----------------------------------------------------------

// Claude Code hooks post the chat state back here, keyed by the directory claude runs
// in. Injected with `claude --settings`, so they work on every branch of every project.
// `input` also sends the hook's own input (JSON on stdin) for the hub to look into.
const report = (state, input) => ({
  type: "command",
  command: `curl -s -m 2 -o /dev/null -X POST --data-urlencode "dir=$CLAUDE_PROJECT_DIR"${input ? ' --data-urlencode "hook@-"' : ""} "${BASE}/api/status?state=${state}" || true`,
});
const on = (state, matcher, input) => [{ ...(matcher && { matcher }), hooks: [report(state, input)] }];
const SETTINGS = path.join(tmpdir(), `hub-${PORT}-settings.json`);
const CLAUDE_HOOKS = {
  hooks: {
    SessionStart: on("idle"),
    UserPromptSubmit: on("working"),
    PostToolUse: on("working"), // also clears `waiting` once an allowed tool has run
    PreToolUse: on("asking", "AskUserQuestion|ExitPlanMode"),
    Notification: on("waiting", "permission_prompt|elicitation_dialog"),
    Stop: on("done", null, true), // `background` instead while shells, subagents or wakeups are pending
    SessionEnd: on("off"),
  },
};

const binOf = (agent) => path.basename(agent.trim().split(/\s+/)[0]);
// Claude Code keeps a directory's chats as <config>/projects/<dir, non-alphanumerics as ->/*.jsonl
function hasClaudeChat(dir) {
  const root = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
  try {
    return readdirSync(path.join(root, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"))).some((f) => f.endsWith(".jsonl"));
  } catch {
    return false; // never run here
  }
}

// Claude and Codex get status hooks. Claude also picks up the worktree's last chat
// (`--continue` alone exits when there is none).
function launchCommand({ agent, dir }) {
  agent = process.env.HUB_CMD ?? agent;
  if (binOf(agent) === "codex") return withCodexHooks(agent, BASE);
  if (binOf(agent) !== "claude") return agent;
  const resume = !/\s(-c|--continue|-r|--resume)\b/.test(agent) && hasClaudeChat(dir) ? " --continue" : "";
  return `${agent} --settings ${SETTINGS}${resume}`;
}

// session → chat state; absent = nothing reporting. Kept in a file so a restarted hub
// still knows the chats that are sitting still; `working` is not carried over, as the
// turn may have ended while nobody was listening.
const STATUS_FILE = path.join(tmpdir(), `hub-${PORT}-status.json`);
const status = new Map();
// session → what its pane was running when the state came in: the state is that
// agent's, and goes when the agent does. None for a report from outside the hub's tmux.
const owner = new Map();
// sessions whose Codex reports through hooks, which then speak for it instead of the
// daemon. Not kept across a restart: the next hook says so again.
const hooked = new Set();
// sessions whose `waiting` is a question, not a permission prompt
const asking = new Set();
try {
  for (const [session, entry] of Object.entries(JSON.parse(readFileSync(STATUS_FILE, "utf8")))) {
    const { state, agent } = typeof entry === "string" ? { state: entry } : entry; // a string: written by an older hub
    if (!STATES.includes(state) || state === "working") continue;
    status.set(session, state);
    if (agent) owner.set(session, agent);
  }
} catch {
  // first run
}
// `agent`: the pane command the state belongs to (null: none); left out, it stays as it is
function setStatus(session, state, agent = owner.get(session) ?? null) {
  if (state !== "waiting") asking.delete(session);
  if (state === "off") {
    hooked.delete(session);
    if (!status.delete(session)) return;
    owner.delete(session);
  } else {
    if (status.get(session) === state && (owner.get(session) ?? null) === agent) return;
    status.set(session, state);
    if (agent) owner.set(session, agent);
    else owner.delete(session);
  }
  writeFileSync(STATUS_FILE, JSON.stringify(Object.fromEntries([...status].map(([s, state]) => [s, { state, agent: owner.get(s) }]))));
}

// No hook says that a prompt was answered: an allowed tool reports once it has run, a
// refusal never. The keys typed into a waiting chat stand in for it: Esc refuses and
// leaves the chat idle; Enter or a shortcut key allows, and the tool is running. A
// question reports its own answer at once, so only its Esc counts.
function answered(session, keys) {
  if (status.get(session) !== "waiting") return;
  if (keys === "\x1b") setStatus(session, "idle");
  else if (!asking.has(session) && /^[\r!-~]$/.test(keys)) setStatus(session, "working");
}

// A turn can end with work still in flight that will wake the chat up again: Stop's
// input lists it (a Claude Code too old to send the arrays just reports done).
function stillBusy(hook) {
  try {
    const { background_tasks = [], session_crons = [] } = JSON.parse(hook);
    return background_tasks.length + session_crons.length > 0;
  } catch {
    return false;
  }
}

// ---- tmux -------------------------------------------------------------------

function tmux(...args) {
  return execFileSync("tmux", [...TMUX, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", path.basename(process.env.SHELL ?? "sh")]);

// session → what its chat window is running (so an agent without hooks still shows)
function liveSessions() {
  try {
    const rows = tmux("list-panes", "-a", "-f", "#{==:#{window_index},0}", "-F", "#{session_name}\t#{pane_current_command}");
    return new Map(rows.split("\n").filter(Boolean).map((r) => r.split("\t")));
  } catch {
    return new Map(); // no server yet
  }
}

function portOpen(port) {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = connect({ port, host: "localhost" });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(300, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

// The project's url with {port} and {branch} filled in; null unless it is a web link.
function linkUrl(template, values) {
  try {
    const url = new URL(String(template).replace(/\{(port|branch)\}/g, (_, key) => encodeURIComponent(values[key])));
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

// The dev command in a second window; it closes by itself if the server exits.
function startDev(wt) {
  if (!wt.devCommand) return;
  const windows = tmux("list-windows", "-t", `=${wt.session}`, "-F", "#{window_name}").split("\n");
  if (!windows.includes("dev")) tmux("new-window", "-d", "-t", `=${wt.session}:`, "-n", "dev", "-c", wt.dir, wt.devCommand);
}

function worktrees(root) {
  const cfg = config(root);
  const out = execFileSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  const live = liveSessions();
  const list = out.trim().split("\n\n").map((block, index) => {
    const dir = block.match(/^worktree (.+)$/m)[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? "(detached)";
    const portFile = cfg.port?.file && path.join(dir, cfg.port.file);
    const port = (portFile && existsSync(portFile) ? Number(readFileSync(portFile, "utf8").trim()) : cfg.port?.default) || null;
    const session = path.basename(dir).replace(/[.:]/g, "_"); // tmux forbids . and : in names
    const alive = live.has(session);
    const command = live.get(session);
    const running = [binOf(process.env.HUB_CMD ?? cfg.agent), "claude", "codex"].includes(command);
    // A state outlives its agent when that is killed, or exits while the hub is down:
    // drop it once the pane is back at its shell or runs another agent. Anything else
    // in the pane is the agent's own doing (its editor), and the state stays.
    const from = owner.get(session);
    if (from && (!alive || SHELLS.has(command) || (running && command !== from))) setStatus(session, "off");
    return {
      session, dir, branch, port, index, main: dir === root, alive, command, running,
      codexRunning: command === "codex",
      url: port && linkUrl(cfg.url, { port, branch }),
      state: (alive && (status.get(session) ?? (running && "unknown"))) || "off",
      agent: cfg.agent, devCommand: cfg.port ? cfg.dev : null, // no port config, no dev server
    };
  });
  // the saved order first; worktrees it does not know (new ones) follow in git's order
  const saved = order[root] ?? [];
  const rank = (w) => (saved.includes(w.session) ? saved.indexOf(w.session) : saved.length);
  return list.sort((a, b) => rank(a) - rank(b));
}

const allWorktrees = () => projects.flatMap(worktrees);
const codexRuntime = new CodexRuntime({
  getWorktrees: allWorktrees,
  onState: (session, state) => {
    // Hooks report each change as it happens; a snapshot of the daemon can trail them.
    if (hooked.has(session)) return;
    // `off`: the thread unloaded. Only a state the daemon's Codex gave is its to clear.
    if (state === "off") return void (owner.get(session) === "codex" && setStatus(session, "off"));
    if (state !== "idle" || status.get(session) !== "done") setStatus(session, state, "codex");
  },
});

const run = promisify(execFile);

// A new worktree: the project's own `worktree` command if it has one, else a sibling
// directory <project>-<name> on branch <name> (created from the main checkout's HEAD
// unless it exists). Returns the row of whatever worktree appeared.
async function createWorktree(root, name) {
  const cfg = config(root);
  const before = new Set(worktrees(root).map((w) => w.dir));
  if (cfg.worktree) {
    // the name is validated by the caller, so it is safe inside the shell command
    await run("sh", ["-c", cfg.worktree.replaceAll("{name}", name)], { cwd: root, timeout: 120_000 });
  } else {
    const exists = await run("git", ["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${name}`]).then(() => true, () => false);
    await run("git", ["-C", root, "worktree", "add", `${root}-${name}`, ...(exists ? [name] : ["-b", name])]);
  }
  return worktrees(root).find((w) => !before.has(w.dir));
}

// ---- http -------------------------------------------------------------------

const ownHost = (h) => [`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(h);
function ownOrigin(origin) {
  try {
    return ownHost(new URL(origin).host);
  } catch {
    return false;
  }
}

function body(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(new URLSearchParams(data)));
  });
}

async function handle(req, url, send) {
  if (url.pathname === "/api/sessions") {
    await codexRuntime.refresh();
    const root = findProject(url.searchParams.get("p"));
    const list = root ? worktrees(root) : [];
    const up = await Promise.all(list.map((w) => portOpen(w.port)));
    return send(200, "application/json", JSON.stringify({
      project: root && nameOf(root),
      // chats needing attention, so the page can flag projects it is not showing
      projects: projects.map((r) => ({
        name: nameOf(r),
        pending: (r === root ? list : worktrees(r)).filter((w) => ["waiting", "done"].includes(w.state)).length,
      })),
      sessions: list.map((w, i) => ({ ...w, dev: up[i] })),
    }));
  }
  if (req.method === "POST" && url.pathname === "/api/projects") {
    const root = gitRoot((await body(req)).get("dir") ?? "");
    if (!root) return send(400, "text/plain", "not a git repository");
    addProject(root);
    return send(200, "text/plain", nameOf(root));
  }
  if (req.method === "POST" && url.pathname === "/api/worktrees") {
    const q = await body(req);
    const root = projects.find((r) => nameOf(r) === q.get("p"));
    const name = q.get("name")?.trim() ?? "";
    if (!root) return send(400, "text/plain", "unknown project");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return send(400, "text/plain", "letters, digits, . _ - only");
    try {
      const wt = await createWorktree(root, name);
      if (!wt) return send(400, "text/plain", "the command ran, but no worktree appeared");
      return send(200, "text/plain", wt.session);
    } catch (e) {
      return send(400, "text/plain", (e.stderr || e.message).trim());
    }
  }
  if (req.method === "POST" && url.pathname === "/api/order") {
    const q = await body(req);
    const root = projects.find((r) => nameOf(r) === q.get("p"));
    if (!root) return send(400, "text/plain", "unknown project");
    const known = new Set(worktrees(root).map((w) => w.session));
    setOrder(root, [...new Set(q.getAll("s"))].filter((s) => known.has(s)));
    return send(200, "text/plain", "ok");
  }
  if (req.method === "POST" && url.pathname === "/api/stop") {
    send(200, "text/plain", "stopping");
    return setImmediate(() => process.exit(0));
  }
  if (req.method === "POST" && url.pathname === "/api/status") {
    const q = new URLSearchParams([...url.searchParams, ...(await body(req))]);
    const wt = allWorktrees().find((w) => w.session === q.get("s") || w.dir === q.get("dir"));
    const asks = q.get("state") === "asking"; // waiting, on a question
    const state = asks ? "waiting" : q.get("state") === "done" && stillBusy(q.get("hook")) ? "background" : q.get("state");
    if (!wt || !STATES.includes(state)) return send(400, "text/plain", "bad request");
    // `seen` from the page must not overwrite a turn that started meanwhile
    if (q.get("if") && status.get(wt.session) !== q.get("if")) return send(200, "text/plain", "stale");
    if (asks) asking.add(wt.session);
    // hooks report by directory, the page by session (its `seen` changes no owner)
    // (nor does a hook that fires while the agent has its editor in the pane)
    if (q.has("dir") && (wt.running || !wt.command || SHELLS.has(wt.command))) setStatus(wt.session, state, wt.running ? wt.command : null);
    else setStatus(wt.session, state);
    if (q.has("dir") && wt.codexRunning && state !== "off") hooked.add(wt.session);
    return send(200, "text/plain", "ok");
  }
  if (req.method === "POST" && url.pathname === "/api/dev") {
    const wt = allWorktrees().find((w) => w.session === url.searchParams.get("s"));
    if (!wt?.alive) return send(400, "text/plain", "no session");
    if (!(await portOpen(wt.port))) startDev(wt);
    return send(200, "text/plain", "ok");
  }
  const hit = STATIC[url.pathname];
  if (!hit) return send(404, "text/plain", "not found");
  send(200, hit[1], readFileSync(hit[0]));
}

const server = createServer(async (req, res) => {
  const send = (code, type, data) => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(data);
  };
  // hooks and the CLI send no Origin; a browser always does on a cross-site POST
  if (!ownHost(req.headers.host) || (req.headers.origin && !ownOrigin(req.headers.origin))) {
    return send(403, "text/plain", "forbidden");
  }
  try {
    await handle(req, new URL(req.url, BASE), send);
  } catch (e) {
    console.error(e);
    send(500, "text/plain", String(e.message ?? e));
  }
});

// The socket is a shell: accept it only from the hub's own page.
const wss = new WebSocketServer({ server, path: "/pty", verifyClient: ({ origin }) => ownOrigin(origin) });

wss.on("connection", async (ws, req) => {
  const q = new URL(req.url, BASE).searchParams;
  const wt = allWorktrees().find((w) => w.session === q.get("s"));
  if (!wt) return ws.close(4004, "unknown session");

  if (!wt.alive) {
    // a page coming back from a dropped connection reattaches; a new session takes a click
    if (q.has("again")) return ws.close(4000, "session ended");
    tmux("new-session", "-d", "-s", wt.session, "-c", wt.dir);
    // typed into a shell, so the session outlives the agent exiting
    const cmd = launchCommand(wt);
    if (cmd) tmux("send-keys", "-t", `=${wt.session}:`, cmd, "Enter");
    if (!(await portOpen(wt.port))) startDev(wt);
  }
  const env = { ...process.env, TERM: "xterm-256color" };
  delete env.TMUX;
  const term = pty.spawn("tmux", [...TMUX, "attach-session", "-t", `=${wt.session}:0`], {
    name: "xterm-256color",
    cols: Number(q.get("cols")) || 120,
    rows: Number(q.get("rows")) || 40,
    cwd: wt.dir,
    env,
  });
  term.onData((d) => ws.readyState === ws.OPEN && ws.send(d));
  term.onExit(() => ws.close());
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.t === "i") {
      answered(wt.session, m.d);
      term.write(m.d);
    } else if (m.t === "r") term.resize(m.cols, m.rows);
  });
  ws.on("close", () => term.kill()); // detaches the client; the tmux session stays
});

// ---- start ------------------------------------------------------------------

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [arg] = args.filter((a) => !a.startsWith("--"));
const call = (route, params = {}) =>
  fetch(`${BASE}${route}`, { method: "POST", body: new URLSearchParams(params), signal: AbortSignal.timeout(500) }).catch(() => null);
const pageUrl = (r) => `http://localhost:${PORT}/${r ? `?p=${encodeURIComponent(nameOf(r))}` : ""}`;
function printStatusHelp() {
  console.log(`status for a claude started outside the hub: restart it with\n  claude --settings ${SETTINGS} --continue`);
  console.log(`Codex status is read automatically from its shared local daemon.\nWithout the daemon, restart Codex with\n  ${withCodexHooks("codex", BASE)} resume --last\nthen review and trust the Hub hooks in /hooks`);
}

if (arg === "stop") {
  const res = await call("/api/stop");
  if (res && !res.ok) {
    // it answers but does not know /api/stop: an older hub, or not a hub at all
    console.error(`hub: whatever is on port ${PORT} did not stop (HTTP ${res.status}) — end that process yourself`);
    process.exit(1);
  }
  console.log(res ? "hub stopped" : "hub is not running");
  process.exit(0);
}

const root = gitRoot(path.resolve(arg ?? "."));

// A hub already on this port: hand it the project and leave.
const running = await call("/api/projects", { dir: root ?? "" });
if (running?.status === 404) {
  console.error(`hub: port ${PORT} is taken by something that is not this hub`);
  process.exit(1);
}
if (running) {
  if (!root) console.log(`hub is running: ${pageUrl()} (not in a git repository, nothing added)`);
  else console.log(`hub is running: ${pageUrl(root)}`);
  process.exit(0);
}

if (root) addProject(root);
if (!projects.length) {
  console.error("hub: run it inside a git repository (or pass one) to add the first project");
  process.exit(1);
}

if (!flags.has("--fg")) {
  // re-run detached, so the server outlives this terminal
  mkdirSync(CONFIG_DIR, { recursive: true });
  const log = openSync(LOG_FILE, "a");
  spawn(process.execPath, [fileURLToPath(import.meta.url), "--fg", root ?? projects[0]], { detached: true, stdio: ["ignore", log, log] }).unref();
  for (let i = 0; i < 50 && !(await call("/api/projects", { dir: "" })); i++) await new Promise((r) => setTimeout(r, 100));
  if (!(await call("/api/projects", { dir: "" }))) {
    console.error(`hub: server did not start — see ${LOG_FILE}`);
    process.exit(1);
  }
  console.log(`hub: ${pageUrl(root ?? projects[0])}`);
  console.log(`running in the background (log: ${LOG_FILE}); \`hub stop\` ends it`);
  printStatusHelp();
  process.exit(0);
}

writeFileSync(SETTINGS, JSON.stringify(CLAUDE_HOOKS, null, 2));
server.listen(PORT, "127.0.0.1", () => {
  setInterval(() => codexRuntime.refresh(), 1500).unref();
  console.log(`hub: ${pageUrl(root ?? projects[0])}`);
  console.log(`projects: ${projects.map(nameOf).join(", ")}`);
  printStatusHelp();
});
