// Read runtime status from the existing Codex daemon. This never starts/resumes
// a conversation, subscribes to its tools, or answers approval requests.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

export class CodexRuntime {
  constructor({ getWorktrees, onState, socket = path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "app-server-control/app-server-control.sock") }) {
    this.getWorktrees = getWorktrees;
    this.onState = onState;
    this.socket = socket;
    this.pending = new Map();
    this.previous = new Map();
    this.nextId = 1;
    this.retryAt = 0;
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex status request timed out"));
      }, 1500);
      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (Date.now() < this.retryAt || !existsSync(this.socket)) throw new Error("No Codex daemon");
    const ws = this.ws = new WebSocket(`ws+unix://${this.socket}:/`, { handshakeTimeout: 1500 });
    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(raw);
        const pending = this.pending.get(message.id);
        if (!pending) return; // ignore notifications and server requests
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } catch {
        // Status monitoring must not affect the daemon's other clients.
      }
    });
    const disconnected = () => {
      this.retryAt = Date.now() + 5000;
      for (const pending of this.pending.values()) pending.reject(new Error("Codex daemon disconnected"));
      this.pending.clear();
    };
    ws.on("error", disconnected);
    ws.on("close", disconnected);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await this.request("initialize", { clientInfo: { name: "hub_status", version: "0.1.0" }, capabilities: { experimentalApi: false } });
    ws.send(JSON.stringify({ method: "initialized" }));
  }

  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.poll().catch(() => {
      // Hooks and the process-running fallback still work without a daemon.
      this.ws?.terminate();
    }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async poll() {
    const worktrees = this.getWorktrees().filter((w) => w.codexRunning);
    const live = new Set(worktrees.map((w) => w.session));
    for (const session of this.previous.keys()) if (!live.has(session)) this.previous.delete(session);
    if (!worktrees.length) return;
    await this.connect();
    const byDir = new Map(worktrees.map((w) => [w.dir, w.session]));
    const found = new Map();
    const threads = [];
    let cursor;
    do {
      // Fresh chats can be loaded and idle before they have any saved history.
      // thread/list omits those chats, so start with the daemon's in-memory list.
      const result = await this.request("thread/loaded/list", { limit: 100, cursor });
      const summaries = await Promise.allSettled(result.data.map((threadId) =>
        this.request("thread/read", { threadId, includeTurns: false })));
      for (const summary of summaries) {
        if (summary.status === "fulfilled") threads.push(summary.value.thread);
        // A thread can unload between listing and reading it.
      }
      cursor = result.nextCursor;
    } while (cursor);
    threads.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const thread of threads) {
      if (!["cli", "vscode", "appServer"].includes(thread.source) || !["active", "idle", "systemError"].includes(thread.status?.type)) continue;
      const session = byDir.get(thread.cwd);
      if (session && !found.has(session)) found.set(session, thread);
    }

    for (const [session, thread] of found) {
      const { type, activeFlags = [] } = thread.status;
      let state = type === "idle" ? "idle" : type === "systemError" || activeFlags.some((f) => ["waitingOnApproval", "waitingOnUserInput"].includes(f)) ? "waiting" : "working";
      const prev = this.previous.get(session);
      // Keep done until the page acknowledges it; an unchanged idle snapshot
      // must not repeatedly mark it done or overwrite that acknowledgement.
      if (prev?.id === thread.id && prev.type === type && prev.state === state) continue;
      this.previous.set(session, { id: thread.id, type, state });
      if (type === "idle" && prev?.id === thread.id && prev.type === "active") state = "done";
      this.onState(session, state);
    }
    for (const session of this.previous.keys()) if (!found.has(session)) this.previous.delete(session);
  }

  close() {
    this.ws?.terminate();
  }
}
