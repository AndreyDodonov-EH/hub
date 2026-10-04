import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hookState, withCodexHooks } from "../codex-status.mjs";

const script = fileURLToPath(new URL("../codex-status.mjs", import.meta.url));
function run(args, input = "", env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => stdout += data);
    child.stderr.on("data", (data) => stderr += data);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("compaction preserves working status and unanswered questions need attention", () => {
  assert.equal(hookState({ hook_event_name: "SessionStart", source: "compact" }), "working");
  for (const tool_name of ["request_user_input", "functions.request_user_input", "request_user_input_async"]) {
    assert.equal(hookState({ hook_event_name: "PreToolUse", tool_name }), "asking");
  }
  assert.equal(hookState({ hook_event_name: "PreToolUse", tool_name: "Bash" }), "working");
  assert.equal(hookState({ hook_event_name: "unknown" }), null);
});

test("launch arguments survive shell quoting", async () => {
  const command = withCodexHooks("printf '%s\\n' resume --last --model 'a model'", "http://127.0.0.1:5190");
  const result = await run(["sh", "-c", command]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^resume\n--last\n--model\na model\n-c\nhooks=\{ SessionStart = /);
  const commandJson = result.stdout.match(/command = ("(?:\\.|[^"\\])*")/)[1];
  const hookCommand = JSON.parse(commandJson);
  assert.ok(hookCommand.includes(script));
  const hook = await run(["sh", "-c", hookCommand], "broken JSON");
  assert.equal(hook.code, 0, hook.stderr);
  assert.deepEqual(JSON.parse(hook.stdout), {});
});

test("hook commands report transitions without forwarding chat or tool contents", async (t) => {
  const received = [];
  const server = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    received.push({ method: req.method, url: req.url, body: Object.fromEntries(new URLSearchParams(data)) });
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const events = [
    ["SessionStart", "idle"], ["UserPromptSubmit", "working"],
    ["PermissionRequest", "waiting"], ["PostToolUse", "working"],
    ["Stop", "done"], ["Interrupt", "idle"], ["SessionEnd", "off"],
  ];
  for (const [hook_event_name, state] of events) {
    const result = await run([process.execPath, script, "report", base], JSON.stringify({
      hook_event_name, cwd: "/tmp/project with 'quotes'", prompt: "private prompt", last_assistant_message: "private reply",
    }));
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.deepEqual(received.at(-1), { method: "POST", url: "/api/status", body: { dir: "/tmp/project with 'quotes'", state } });
  }
  for (const input of ["broken JSON", "{}", '{"hook_event_name":"Stop"}']) {
    const result = await run([process.execPath, script, "report", base], input);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {});
  }
  assert.equal(received.length, events.length);
  await new Promise((resolve) => server.close(resolve));
  const unavailable = await run([process.execPath, script, "report", base], JSON.stringify({ hook_event_name: "Stop", cwd: "/tmp/project" }));
  assert.equal(unavailable.code, 0);
  assert.deepEqual(JSON.parse(unavailable.stdout), {});
});
