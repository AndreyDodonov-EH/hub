# Hub

One browser page for all your coding-agent chats.

A sidebar lists the git worktrees of a project; each row shows its branch, the agent's
status and a link to its dev server. Clicking a row attaches a real terminal to that
worktree's tmux session, where the agent runs. Sessions survive closing the page and
the hub itself.

Local only: Linux, macOS, WSL. No hosting, no remote sessions.

## Install

Needs Node 20+, tmux 3.2+, git, curl, and a C++ toolchain (`node-pty` compiles on install).

```
npm install
npm link        # puts `hub` on your PATH
```

## Use

```
cd your-project
hub             # serves http://localhost:5190/?p=your-project, in the background
hub stop        # stops the server; tmux sessions stay
hub --fg        # serve in the foreground instead
```

The background server logs to `~/.config/hub/hub.log`.

Run `hub` in another repository while one is running and it is added to the same
server. Projects are remembered in `~/.config/hub/projects.json`. Each browser tab shows
one project (`?p=<name>`); the links at the top of the sidebar switch (ctrl/middle-click
opens a project in its own tab), and a badge on another project counts its chats that
are waiting or done.

- **Row colour**: one of four, keyed to the port (or git's worktree order without one).
- **Row order**: drag a row to move it. The order is kept per project in
  `~/.config/hub/order.json`; new worktrees go to the end.
- **Status**: idle / working / background tasks / needs you / done, with browser
  notifications for the last two on chats you are not looking at. "Background tasks" is
  a turn that ended with shells, subagents or scheduled wakeups still pending; it turns
  to done, with its notification, once a turn ends with none left. Claude Code reports all of them through
  hooks the hub injects at launch (`claude --settings`); other agents only show
  running / not running. A claude started outside the hub reports nothing until it is
  restarted with the command the hub prints at startup.
- **Resume**: a session started for a worktree that already has a Claude Code chat
  continues the latest one (`claude --continue`); `/clear` or `/resume` inside it for
  another. Set `agent` to `claude --resume` to pick from the list each time instead.
- **New worktree**: *+ New worktree* under the list, then type a name. By
  default that is `git worktree add ../<project>-<name>` on branch `<name>` (created
  from the main checkout's HEAD unless it exists); a project can substitute its own
  command (`worktree` below). The new row opens right away.
- **Port link**: lit when something answers on the worktree's port. Clicking a dimmed
  one starts the project's dev command in a second tmux window.
- **Clipboard**: a plain drag copies on release; shift+drag then right-click copies
  too; Ctrl+V pastes.
- **From a terminal**: `tmux -L hub attach -t <session>`.

## Project config

Optional `.hub.json` in the project's main checkout:

```json
{
  "agent": "claude",
  "dev": "npm run dev",
  "port": { "file": ".dev-port", "default": 5199 },
  "url": "http://localhost:{port}/",
  "worktree": "tools/worktree-create.sh {name}"
}
```

| key | default | meaning |
| --- | --- | --- |
| `agent` | `"claude"` | command a new session starts |
| `dev` | none | dev-server command, run in the worktree |
| `port.file` | none | file in each worktree holding its port number |
| `port.default` | none | port for worktrees without that file |
| `url` | `http://localhost:{port}/` | what the port link opens; `{port}` and `{branch}` are filled in, URL-encoded (so `{branch}` suits a path segment or query value, not a hostname); must be `http(s)` |
| `worktree` | `git worktree add` | shell command that creates a worktree for `{name}`, run in the main checkout |

Without `port`, rows have no link and no dev server.

## Environment

| variable | default | |
| --- | --- | --- |
| `HUB_PORT` | `5190` | port of the hub page |
| `HUB_SOCKET` | `hub` | tmux server socket name |
| `HUB_CONFIG_DIR` | `~/.config/hub` | where the project list and row order live |
| `HUB_CMD` | — | overrides `agent` for new sessions; empty = bare shell |

## Security

The page is a shell. The server binds to 127.0.0.1 and refuses requests from any
other web origin, but another user account on the same machine can reach the port.

## Not yet

- Status hooks for agents other than Claude Code.
- Configurable row metadata.
- Viewing the `dev` window's output from the page.
- An image viewer route agents can link to.
