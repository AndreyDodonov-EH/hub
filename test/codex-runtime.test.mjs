import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { CodexRuntime } from "../codex-runtime.mjs";

test("fresh unsaved Codex chats report idle, work, waiting and completion through loaded-session metadata", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-runtime-test-"));
  const socket = path.join(dir, "daemon.sock");
  const server = new WebSocketServer({ path: "/", server: undefined, noServer: true });
  // ws speaks WebSocket over a local Unix HTTP socket, like the Codex daemon.
  const { createServer } = await import("node:http");
  const http = createServer();
  http.on("upgrade", (req, sock, head) => server.handleUpgrade(req, sock, head, (ws) => server.emit("connection", ws, req)));
  await new Promise((resolve) => http.listen(socket, resolve));
  let native = { type: "idle" };
  let threadsPresent = true;
  let paginate = false;
  let lastTurn = "completed"; // null: the daemon cannot list this chat's turns
  let readFails = false;
  const calls = [];
  server.on("connection", (ws) => ws.on("message", (raw) => {
    const message = JSON.parse(raw);
    calls.push(message.method);
    if (message.method === "initialized") return;
    // A server request reusing the client's id must not be taken for the response.
    if (message.method === "thread/loaded/list") ws.send(JSON.stringify({ id: message.id, method: "item/commandExecution/requestApproval", params: {} }));
    assert.ok(["initialize", "thread/loaded/list", "thread/read"].includes(message.method));
    let result = {};
    if (message.method === "thread/loaded/list") {
      result = paginate && !message.params.cursor
        ? { data: ["old", "child", "other-project", "unloaded"], nextCursor: "page2" }
        : { data: threadsPresent ? ["old", "child", "other-project", "unloaded", "current"] : [], nextCursor: null };
    }
    if (message.method === "thread/read") {
      if (message.params.includeTurns && !lastTurn) {
        ws.send(JSON.stringify({ id: message.id, error: { code: -32600, message: "list_turns is not supported yet" } }));
        return;
      }
      const summaries = {
        old: { id: "old", cwd: "/project", source: "cli", updatedAt: 1, status: { type: "notLoaded" } },
        child: { id: "child", cwd: "/project", source: { subAgent: {} }, updatedAt: 100, status: { type: "active" } },
        "other-project": { id: "other-project", cwd: "/unrelated", source: "cli", updatedAt: 100, status: { type: "active" } },
        // This chat has no saved history. It exists only in the loaded list.
        current: { id: "current", cwd: "/project", source: "vscode", updatedAt: 2, status: native },
      };
      const thread = !(readFails && message.params.threadId === "current") && summaries[message.params.threadId];
      if (thread && message.params.includeTurns) thread.turns = [{ status: "completed" }, { status: lastTurn }];
      if (!thread) {
        ws.send(JSON.stringify({ id: message.id, error: { code: -32600, message: "thread unloaded" } }));
        return;
      }
      result = { thread };
    }
    ws.send(JSON.stringify({ id: message.id, result }));
  }));
  const updates = [];
  let sidebar;
  const worktrees = [{ session: "project", dir: "/project", codexRunning: true }];
  const monitor = new CodexRuntime({ socket, getWorktrees: () => worktrees, onState: (session, state) => { updates.push([session, state]); sidebar = state; } });
  t.after(async () => {
    monitor.close();
    for (const ws of server.clients) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => http.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  await monitor.refresh();
  assert.equal(sidebar, "idle");
  await monitor.refresh();
  assert.equal(updates.length, 1);
  native = { type: "active", activeFlags: [] };
  await monitor.refresh();
  assert.equal(sidebar, "working");
  for (const flag of ["waitingOnApproval", "waitingOnUserInput"]) {
    native = { type: "active", activeFlags: [flag] };
    await monitor.refresh();
    assert.equal(sidebar, "waiting");
  }
  native = { type: "active", activeFlags: [] };
  await monitor.refresh();
  assert.equal(sidebar, "working");
  native = { type: "idle" };
  await monitor.refresh();
  assert.equal(sidebar, "done");
  await monitor.refresh();
  assert.equal(sidebar, "done");
  sidebar = "idle"; // the page has viewed the completed turn
  await monitor.refresh();
  assert.equal(sidebar, "idle");
  // an interrupted turn is not a completed one; without the turn list it counts as done
  for (const [status, state] of [["interrupted", "idle"], [null, "done"]]) {
    native = { type: "active", activeFlags: [] };
    await monitor.refresh();
    assert.equal(sidebar, "working");
    lastTurn = status;
    native = { type: "idle" };
    await monitor.refresh();
    assert.equal(sidebar, state);
  }
  sidebar = "idle";
  // a read that fails once is not an unload: nothing changes, and no older thread takes over
  native = { type: "active", activeFlags: [] };
  await monitor.refresh();
  readFails = true;
  await monitor.refresh();
  assert.equal(sidebar, "working");
  assert.equal(monitor.previous.get("project").id, "current");
  readFails = false;
  native = { type: "idle" };
  lastTurn = "completed";
  await monitor.refresh();
  assert.equal(sidebar, "done");
  sidebar = "idle";
  threadsPresent = false;
  await monitor.refresh();
  assert.equal(monitor.previous.size, 0);
  assert.equal(sidebar, "off"); // the thread unloaded: its last status must not linger
  threadsPresent = true;
  paginate = true;
  await monitor.refresh();
  assert.equal(sidebar, "idle");
  assert.equal(calls.filter((m) => m === "initialize").length, 1);
  assert.ok(!calls.includes("thread/list"));
  worktrees[0].codexRunning = false; // return to a shell or switch to Claude
  await monitor.refresh();
  assert.equal(monitor.previous.size, 0);
  assert.equal(sidebar, "idle"); // the hub clears a pane that left Codex, as it sees what took its place
});

test("missing daemon leaves hook statuses alone", async () => {
  const updates = [];
  const monitor = new CodexRuntime({ socket: "/tmp/hub-nonexistent-daemon.sock", getWorktrees: () => [{ session: "project", dir: "/project", codexRunning: true }], onState: (...args) => updates.push(args) });
  await monitor.refresh();
  assert.deepEqual(updates, []);
  monitor.close();
});
