// Codex lifecycle hooks, injected for this invocation without editing user config.
import { fileURLToPath } from "node:url";
import path from "node:path";

const FILE = fileURLToPath(import.meta.url);
export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function hookConfig(base) {
  const command = `${shellQuote(process.execPath)} ${shellQuote(FILE)} report ${shellQuote(base)}`;
  const handler = `{ type = "command", command = ${JSON.stringify(command)}, timeout = 3 }`;
  const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop", "Interrupt", "SessionEnd"];
  return `{ ${events.map((event) => `${event} = [{ hooks = [${handler}] }]`).join(", ")} }`;
}

export function withCodexHooks(agent, base) {
  // Command substitution keeps the launch command readable, including the one
  // printed for an existing session to resume with hooks.
  return `${agent} -c "hooks=$(${shellQuote(process.execPath)} ${shellQuote(FILE)} config ${shellQuote(base)})"`;
}

export function hookState(hook) {
  switch (hook.hook_event_name) {
    case "SessionStart": return hook.source === "compact" ? "working" : "idle";
    case "UserPromptSubmit":
    case "PostToolUse": return "working";
    case "PreToolUse": return /(^|[.])request_user_input(?:_async)?$/.test(hook.tool_name ?? "") ? "waiting" : "working";
    case "PermissionRequest": return "waiting";
    case "Stop": return "done";
    case "Interrupt": return "idle";
    case "SessionEnd": return "off";
    default: return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === FILE) {
  const [mode, base] = process.argv.slice(2);
  if (mode === "config") {
    console.log(hookConfig(base));
  } else if (mode === "report") {
    try {
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const hook = JSON.parse(input);
      const state = hookState(hook);
      if (state && typeof hook.cwd === "string") {
        await fetch(`${base}/api/status`, {
          method: "POST",
          body: new URLSearchParams({ dir: hook.cwd, state }),
          signal: AbortSignal.timeout(1500),
        });
      }
    } catch {
      // An unavailable hub must never prevent the agent from continuing.
    }
    // Valid, neutral hook output, including for Stop and Interrupt.
    console.log("{}");
  }
}
