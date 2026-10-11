# Hub in detail

What the [README](../README.md) leaves out.

## Projects

A project is in the hub only once `hub init` (or `hub init <dir>`) has added it; a
running server takes it at once. Plain `hub` adds nothing: it starts the server, or says
where the running one is. Projects are remembered in `~/.config/hub/projects.json`. Each
browser tab shows one project (`?p=<name>`); the links at the top of the sidebar switch
(ctrl/middle-click opens a project in its own tab), and a badge on another project counts
its chats that are waiting or done.

## The page

- **Row colour**: one of four, keyed to the port (or git's worktree order without one).
- **Row order**: drag a row to move it. The order is kept per project in
  `~/.config/hub/order.json`; new worktrees go to the end.
- **Status**: idle / working / background tasks / needs you / done, with browser
  notifications for the last two on chats you are not looking at. "Background tasks" is
  a turn that ended with shells, subagents or scheduled wakeups still pending; it turns
  to done, with its notification, once a turn ends with none left. "Needs you" goes
  when you answer in the page, which no hook reports: Enter or a shortcut key allows
  (working), Esc refuses (idle). A question reports its own answer; one given outside
  the page (`tmux attach`) shows once the tool has run. Claude Code reports all of them through
  hooks the hub injects at launch (`claude --settings`). Codex CLI also reports idle,
  working, needs you, done, interruption and exit through injected lifecycle hooks.
  For Codex using its shared local daemon, Hub also reads runtime status directly:
  existing sessions show idle, working or needs you without restarting Codex or
  configuring hooks. A completed turn stays done until viewed. Once Codex reports
  through hooks, they speak for it instead of the daemon. A status belongs to the agent
  that reported it: it is dropped when the pane is back at its shell or runs another
  agent, so a killed agent leaves nothing behind. Codex without the
  shared daemon needs the injected hooks, reviewed and trusted once in `/hooks`.
  Other agents only show running / not running. Claude started outside the hub needs
  to be restarted with the command the hub prints at startup for detailed status.
- **Resume**: a session started for a worktree that already has a Claude Code chat
  continues the latest one (`claude --continue`); `/clear` or `/resume` inside it for
  another. Set `agent` to `claude --resume` to pick from the list each time instead.
- **New worktree**: *+ New worktree* under the list, then type a name. By
  default that is `git worktree add ../<project>-<name>` on branch `<name>` (created
  from the main checkout's HEAD unless it exists); a project can substitute its own
  command (`worktree` in `.hub.json`). The new row opens right away.
- **Port link**: lit when something answers on the worktree's port.
- **Dev server**: ▶ beside the port starts the project's dev command in a second tmux
  window of the worktree's session; ■ stops it with Ctrl-C, and closes the window on a
  server still there five seconds later. A new session does not start it unless
  `autostart` is set. Started on a worktree with no chat yet, it runs without one: the
  agent starts when you open the row. A server started some other way inside the
  worktree (by the agent, say) gets ■ too, which ends its process; whatever else holds
  the port has no button.
- **Editor**: `<>` on a row opens the worktree in your editor (`editor` in `.hub.json`).
- **Reconnect**: a terminal that loses the hub (a restart, the machine asleep) reattaches
  by itself once the hub answers. One whose session ended stays detached until you click
  it or its row, which starts a new session.
- **Clipboard**: a plain drag copies on release; shift+drag then right-click copies
  too; Ctrl+V pastes.
- **From a terminal**: `tmux -L hub attach -t <session>`.

## Codex

To start Codex instead, set `"agent": "codex"` (or `"codex resume --last"` to
resume the latest chat in each worktree) in `.hub.json`, or launch Hub with
`HUB_CMD=codex hub`. Use a Codex CLI version with lifecycle hooks and inline
`hooks` configuration (verified with 0.160.0). For hook-based reporting without
the shared daemon, use `/hooks` to review and trust the Hub status hooks. Hub supplies them only to that
invocation; it does not edit your Codex configuration. When the shared local daemon
is available, existing Codex panes are detected automatically through its read-only
`thread/loaded/list` and `thread/read` metadata, including fresh chats before their
first prompt. The same sidebar states,
project badges and browser notifications work for both agents. Codex reports
done at the end of a turn; its hooks do not report pending background tasks.
See the [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks).

## The hub's port

The hub writes its port to `~/.config/hub/port`. `hub` and `hub stop` look for the
server there, so they find it without `HUB_PORT`, and the next start takes the same
port again if it is free, whatever chose it: bookmarks, the notification permission
and the status hooks of chats already running all hang on the address. If the hub
does have to move, restart those chats for their status to show. `HUB_PORT=5190 hub`
once moves it back.

## Not yet

- Status hooks for agents other than Claude Code and Codex CLI.
- Configurable row metadata.
- Viewing the `dev` window's output from the page.
- An image viewer route agents can link to.
