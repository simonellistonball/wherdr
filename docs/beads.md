# Board with beads

[Documentation](README.md) · [Project](../README.md)

The Board can run on [beads](https://github.com/steveyegge/beads) (`bd`) instead of
herdr-projects. beads is an issue tracker built for agents: issues with dependencies,
a ready queue and claims. On a beads machine the Board lists its issues, and **Start**
opens an agent on one in its repo. The agent claims the issue, works on it and closes
it itself. wherdr does not run reviews, merges, queues or coordinators for beads.

## Which backend a machine uses

`WHERDR_TASKS_BACKEND` in the service's environment (`~/wherdr/wherdr.env`):

| Value | Meaning |
| --- | --- |
| `auto` (default) | herdr-projects where Herdr has it ready, else beads where `bd` finds a database, else herdr-projects (its Board then says it is not installed). |
| `projects` | herdr-projects everywhere. |
| `beads` | beads everywhere. |
| `laptop=beads,devbox=projects,*=auto` | Per machine, by its label in wherdr. |

## Where the issues come from

On each beads machine, wherdr reads:

- **the hub**: the database `BEADS_DIR` names, when `bd where` finds one from the home
  folder. Each issue goes under the repo its `repo:<name>` label names; issues without
  one go under the hub's prefix.
- **each repo's own database**: every Git repo open in Herdr (a pane's folder or one of
  its parents) with its own `.beads/` folder. All its issues belong to that repo. `bd`
  runs there with `BEADS_DIR` unset.

The wherdr service does not read your interactive shell (`~/.zshrc`). Put the
variables `bd` needs in **`~/.config/wherdr/beads.env`** on each machine, as
`KEY=VALUE` lines. Only `BEADS_*` keys are read:

```sh
BEADS_DIR=/home/user/.beads-hub/.beads
BEADS_DOLT_SERVER_MODE=1
BEADS_DOLT_SERVER_HOST=dolt.example.ts.net
BEADS_ACTOR=laptop/wherdr
```

This file holds credentials when your Dolt server needs them: keep it `chmod 600`.

## Columns

| beads status | Board column |
| --- | --- |
| `needs_me` (custom), `blocked` | Needs you |
| `in_progress`, `hooked` | Working |
| `open`, `deferred`, `pinned` | To do; an open issue with an open blocker says **Waits for …** |
| `closed` | Done (the latest 50 of each database) |

## What the Board does on an issue

- **New task** runs `bd create`: in the repo's own database when it has one, else in the
  hub with a `repo:<name>` label.
- **Start** opens an agent (the one picked, `claude` by default) in a new Herdr space, in
  a worktree on branch `bd/<id>` when the repo is a Git repository. The folder is the
  repo's own (its database's), or for a hub issue an open Herdr folder named after the
  repo, else `~/<repo>`, `~/src/<repo>` or `~/code/<repo>`. Its first message names the
  issue and the `bd` commands to claim, note, ask (`--status=needs_me`) and close it.
  wherdr marks the issue `in_progress` on that agent.
- **Reply** goes to the agent Start opened while its pane is open, else becomes a
  `bd comment`.
- **Description** edits run `bd update --description`.
- **Close** (`bd close`) and **Reopen** (`bd reopen`) take the place of Archive and Restore.

Coordinators, Autopilot, Board settings, Archived, approvals, reviews and limits belong
to herdr-projects and are not shown on a beads machine.
