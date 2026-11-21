// beads on every machine whose Board backend is beads (server/utils/tasksBackend.ts):
// its issues (GET /api/tasks), one issue's details, and what the Board does on
// one (create, describe, label, note, reply, close, reopen, Start an agent on it).
//
// Where a machine's issues come from (shared/beadsTasks.ts):
//  - its hub: the database `BEADS_DIR` names, when bd finds one from HOME;
//  - each Git repo open in Herdr there (a pane's folder) with a `.beads/`.
// bd runs with the machine's own environment plus `~/.config/wherdr/beads.env`
// (KEY=VALUE lines: BEADS_DIR, BEADS_DOLT_*…), since the wherdr service does not
// read the user's interactive shell. A repo's database is read with BEADS_DIR
// unset, so bd finds the repo's own `.beads/`.
//
// Reads are cached as herdr-projects' are: one bd at a time per machine, a list
// reused for REUSE_MS, the last list kept (marked stale) when a read fails.
import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  type BeadRow, CLOSED_SHOWN, REPO_LABEL, beadActions, cleanLabels, closeArgs, labelsArgs, noteArgs, closedArgs, commentArgs, commentsArgs, createArgs, describeArgs, isBeadId, listArgs,
  beadAgentName, onBeadBranch, parseBeadDetails, parseBeadList, parseWhere, reopenArgs, showArgs, sourceName, startArgs, startBranch, startLabel, startPrompt,
} from '../../shared/beadsTasks'
import { joinId } from '../../shared/ids'
import {
  type MachineTasks, type StartOptions, type TaskCommand, type TaskDetails, type TaskPanes, type TaskRow,
  cleanRepo, cleanTell, cleanTitle, isQmAction, isTaskCommand, isTaskId,
} from '../../shared/projectsTasks'
import type { SearchableBoard } from '../../shared/taskSearch'
import { fmt } from '../../shared/message'
import { USER_PATH_SH, userPath } from '../../bin/lib/userpath.mjs'
import { DATA_DIR, HERDR_CHILD_ENV, log } from './env'
import { HerdrError, herdrOn } from './herdr'
import type { Machine } from './machines'
import { installedAgentKinds } from './agentAvailability'
import { findPane, getState, sendPrompt } from './state'
import { createAgent } from './actions'
import { machineWorktrees } from './worktrees'
import type { BeadRef } from '../../shared/beadsTasks'

const REUSE_MS = 5000
const DISCOVER_MS = 60_000
const LIST_TIMEOUT_MS = 30_000
const ACTION_TIMEOUT_MS = 60_000
const OUTPUT_MAX = 16 * 1024 * 1024

export interface BeadsRunResult { code: number, stdout: string, stderr: string }
// `dir`: where bd runs; `hub`: with the hub's BEADS_DIR (false: a repo's own database).
export type BeadsRunner = (m: Machine, dir: string, hub: boolean, args: string[], timeoutMs: number) => Promise<BeadsRunResult>

export const BEADS_ENV_FILE = '.config/wherdr/beads.env'

// KEY=VALUE lines (`export` and quotes allowed), BEADS_* keys only.
export function parseBeadsEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const m = /^\s*(?:export\s+)?(BEADS_[A-Z0-9_]+)=(.*)$/.exec(raw)
    if (!m) continue
    let v = m[2]!.trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) v = v.slice(1, -1)
    out[m[1]!] = v
  }
  return out
}
// The BEADS_* variables bd gets here: the service's own, then the file's.
async function localBeadsEnv(home: string): Promise<Record<string, string>> {
  const own = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith('BEADS_') && typeof v === 'string')) as Record<string, string>
  try { return { ...own, ...parseBeadsEnv(await fsp.readFile(path.join(home, BEADS_ENV_FILE), 'utf8')) } }
  catch { return own }
}

// On an SSH machine: `$1` folder, `$2` hub|repo, then bd's arguments.
export const REMOTE_BEADS_SCRIPT = USER_PATH_SH
  + `f="$HOME/${BEADS_ENV_FILE}"; if [ -r "$f" ]; then set -a; . "$f"; set +a; fi; `
  + 'cd "$1" || exit 1; if [ "$2" = repo ]; then unset BEADS_DIR; fi; shift 2; NO_COLOR=1; export NO_COLOR; exec bd "$@"'

const runBd: BeadsRunner = async (m, dir, hub, args, timeoutMs) => {
  if (m.exec) {
    const r = await m.exec(REMOTE_BEADS_SCRIPT, [dir, hub ? 'hub' : 'repo', ...args], { timeoutMs, maxBytes: OUTPUT_MAX })
    return { code: r.code ?? 1, stdout: r.stdout.toString('utf8'), stderr: r.stderr.trim() }
  }
  const beads = await localBeadsEnv(m.home)
  if (!hub) delete beads.BEADS_DIR
  const env: NodeJS.ProcessEnv = { ...HERDR_CHILD_ENV, PATH: userPath({ env: { PATH: HERDR_CHILD_ENV.PATH }, home: m.home }), NO_COLOR: '1', ...beads }
  if (!hub) delete env.BEADS_DIR
  return new Promise(resolve => execFile('bd', args, { cwd: dir, env, timeout: timeoutMs, maxBuffer: OUTPUT_MAX }, (err, stdout, stderr) => resolve({
    code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
    stdout: String(stdout),
    stderr: String(stderr || (err ? (err.killed ? `bd did not answer within ${Math.round(timeoutMs / 1000)} s` : err.message) : '')).trim(),
  })))
}
let runner: BeadsRunner = runBd
// Tests replace bd with recorded output.
export function setBeadsRunner(r: BeadsRunner | null) { runner = r || runBd }

// One bd at a time per machine.
const queues = new Map<string, Promise<unknown>>()
function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const before = queues.get(key) || Promise.resolve()
  const next = before.catch(() => {}).then(job)
  queues.set(key, next)
  next.finally(() => { if (queues.get(key) === next) queues.delete(key) }).catch(() => {})
  return next
}
const firstLine = (s: string) => s.split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 300) || ''
async function bd(m: Machine, src: Pick<BeadsSource, 'dir' | 'hub'>, args: string[], timeoutMs = ACTION_TIMEOUT_MS): Promise<string> {
  const r = await serial(m.key, () => runner(m, src.dir, src.hub, args, timeoutMs))
  if (r.code !== 0) throw new HerdrError('beads_failed', firstLine(r.stderr) || firstLine(r.stdout) || `bd ${args[0]}: code ${r.code}`)
  return r.stdout
}

// ---------------------------------------------------------------- databases
// A database: where bd runs for it (`dir`), its folder (`db`, as `bd where`
// says) and its name on the Board (`name`: the hub's prefix, a repo's folder name).
export interface BeadsSource { name: string, dir: string, hub: boolean, db: string }
const sources = new Map<string, { at: number, list: BeadsSource[] }>()

// The Git repos of the machine's panes that have a `.beads/` of their own.
// A pane's folder or one of its parents, up to (not including) HOME.
async function repoDirs(m: Machine): Promise<string[]> {
  const cwds = new Set(getState().panes.filter(p => (p.machine || '') === m.key && p.cwd).map(p => p.cwd!))
  const found = new Set<string>()
  for (const cwd of cwds) {
    for (let d = cwd; d.startsWith(m.home + '/') && d !== m.home; d = path.posix.dirname(d)) {
      if (found.has(d)) break
      const st = await m.fs.stat(path.posix.join(d, '.beads')).catch(() => null)
      if (st?.isDir) { found.add(d); break }
    }
  }
  return [...found].sort()
}
// `bd where`: the folder, then `prefix: <p>`.
const prefixOf = (stdout: string) => /^\s*prefix:\s*([A-Za-z][\w]{0,30})\s*$/m.exec(stdout)?.[1] || ''

// `fresh` (the Board opening, or Refresh): looked for again unless just found.
export async function beadsSources(m: Machine, fresh = false): Promise<BeadsSource[]> {
  const hit = sources.get(m.key)
  if (hit && Date.now() - hit.at < (fresh ? REUSE_MS : DISCOVER_MS)) return hit.list
  const list: BeadsSource[] = []
  const where = await serial(m.key, () => runner(m, m.home, true, ['where'], LIST_TIMEOUT_MS)).catch(() => null)
  const hubDb = where && where.code === 0 ? parseWhere(where.stdout) : ''
  if (hubDb) list.push({ name: sourceName(prefixOf(where!.stdout) || path.posix.basename(path.posix.dirname(hubDb))), dir: m.home, hub: true, db: hubDb })
  for (const dir of await repoDirs(m)) {
    const r = await serial(m.key, () => runner(m, dir, false, ['where'], LIST_TIMEOUT_MS)).catch(() => null)
    const db = r && r.code === 0 ? parseWhere(r.stdout) : ''
    if (db && !list.some(s => s.db === db)) list.push({ name: sourceName(path.posix.basename(dir)), dir, hub: false, db })
  }
  sources.set(m.key, { at: Date.now(), list })
  return list
}

// ---------------------------------------------------------------- the list
interface Cached { tasks: BeadRow[], at: number, readAt: number, error?: string, descriptions: Map<string, string> }
const lists = new Map<string, Cached>()
const reading = new Map<string, Promise<Cached>>()

async function readSource(m: Machine, s: BeadsSource, descriptions: Map<string, string>): Promise<BeadRow[]> {
  const open = await bd(m, s, listArgs(), LIST_TIMEOUT_MS)
  const closed = await bd(m, s, closedArgs(), LIST_TIMEOUT_MS).catch(() => '[]')
  const openRows = parseBeadList(open, s.name, undefined, s.hub)
  const ids = new Set(openRows.map(r => r.bead))
  const rows = [...openRows, ...parseBeadList(closed, s.name, ids, s.hub).slice(0, CLOSED_SHOWN)]
  // Descriptions for the global search only.
  for (const raw of safeList(open)) {
    if (raw && typeof raw.id === 'string' && typeof raw.description === 'string') {
      const row = rows.find(r => r.bead === raw.id)
      if (row) descriptions.set(row.id, raw.description.slice(0, 4000))
    }
  }
  return rows
}
const safeList = (t: string): Record<string, unknown>[] => { try { const v = JSON.parse(t); return Array.isArray(v) ? v : [] } catch { return [] } }

function readList(m: Machine): Promise<Cached> {
  const now = reading.get(m.key)
  if (now) return now
  const descriptions = new Map<string, string>()
  const read = (async (): Promise<Cached> => {
    const list = await beadsSources(m)
    if (!list.length) throw new HerdrError('beads_missing', fmt('No beads database found on {machine}', { machine: m.label }))
    const tasks: BeadRow[] = []
    const errors: string[] = []
    for (const s of list) {
      try {
        // Two databases may name one repo: the first keeps the id.
        for (const r of await readSource(m, s, descriptions)) if (!tasks.some(t => t.id === r.id)) tasks.push(r)
      } catch (e) { errors.push(`${s.name}: ${(e as Error).message}`) }
    }
    if (errors.length === list.length) throw new Error(errors.join('; '))
    return { tasks, descriptions, at: Date.now(), readAt: Date.now(), ...(errors.length ? { error: errors.join('; ') } : {}) }
  })()
    .catch((e: Error) => {
      const last = lists.get(m.key)
      return { tasks: last?.tasks || [], descriptions: last?.descriptions || new Map(), at: Date.now(), readAt: last?.readAt ?? 0, error: e.message }
    })
    .then((c) => { lists.set(m.key, c); return c })
    .finally(() => reading.delete(m.key))
  reading.set(m.key, read)
  return read
}

const strip = (r: BeadRow): TaskRow => { const { bead: _b, source: _s, ...row } = r; return row }
export async function beadsMachineTasks(m: Machine, fresh = false): Promise<MachineTasks | null> {
  const last = lists.get(m.key)
  const base = { machine: m.key, backend: 'beads' as const, version: '' }
  if (!m.local && m.status !== 'online') {
    const error = fmt('{machine} is unreachable', { machine: m.label })
    return last ? { ...base, status: 'ready', tasks: last.tasks.map(strip), ...(last.readAt ? { at: last.readAt } : {}), error, stale: true } : null
  }
  if (fresh) await beadsSources(m, true).catch(() => [])
  const c = last && !fresh && Date.now() - last.at < REUSE_MS ? last : await readList(m)
  return {
    ...base, status: 'ready', tasks: c.tasks.map(strip),
    ...(c.readAt ? { at: c.readAt } : {}),
    ...(c.error ? { error: c.error, stale: c.tasks.length > 0 } : {}),
  }
}

export async function beadsSearchable(m: Machine): Promise<SearchableBoard> {
  const c = lists.get(m.key) ?? await readList(m)
  return { machine: m.key, tasks: c.tasks.map(r => ({ row: strip(r), description: c.descriptions.get(r.id) || '' })) }
}

export function resetBeadsCache() { refsCache.clear(); lists.clear(); reading.clear(); queues.clear(); sources.clear(); links.clear(); linksRead = false; qmSeen.clear() }
function forget(m: Machine) { lists.delete(m.key) }

// ---------------------------------------------------------------- one bead
// The row a request names, and its database. The list is read again when it
// was dropped (an action just ran) or does not have it.
async function beadOf(m: Machine, id: unknown): Promise<{ row: BeadRow, src: BeadsSource }> {
  if (!isTaskId(id) || !isBeadId(id.split('/')[1])) throw new HerdrError('bad_task', 'Invalid task')
  let row = lists.get(m.key)?.tasks.find(t => t.id === id)
  if (!row) row = (await readList(m)).tasks.find(t => t.id === id)
  if (!row) throw new HerdrError('bad_task', 'This task is not on the board')
  const src = (await beadsSources(m)).find(s => s.name === row!.source)
  if (!src) throw new HerdrError('beads_missing', fmt('No beads database found on {machine}', { machine: m.label }))
  return { row, src }
}

export async function beadDetails(m: Machine, id: unknown): Promise<TaskDetails & TaskPanes> {
  const { row, src } = await beadOf(m, id)
  const [show, comments] = [await bd(m, src, showArgs(row.bead), LIST_TIMEOUT_MS), await bd(m, src, commentsArgs(row.bead), LIST_TIMEOUT_MS).catch(() => '')]
  const agent = await agentOf(m, row, src)
  const d = parseBeadDetails(show, row.id, comments)
  const qm = await qmOffers(m, row, src, agent)
  return { ...d, ...(d.bead ? { bead: { ...d.bead, hub: src.hub, ...qm } } : {}), branch: agent.branch, worktree: agent.worktree, pane: agent.pane }
}

export async function describeBead(m: Machine, id: unknown, text: unknown): Promise<{ ok: true, msg: string }> {
  if (typeof text !== 'string' || text.includes('\0')) throw new HerdrError('bad_action', 'Invalid description')
  const { row, src } = await beadOf(m, id)
  const out = await bd(m, src, describeArgs(row.bead, text))
  forget(m)
  return { ok: true, msg: firstLine(out) }
}

// Labels added and removed, and a note appended, in that order (each its own
// `bd update`). A hub issue's `repo:` labels place it on the Board: not changed here.
export async function editBead(m: Machine, id: unknown, b: { add?: unknown, remove?: unknown, note?: unknown }): Promise<{ ok: true, msg: string }> {
  const add = cleanLabels(b.add)
  const remove = cleanLabels(b.remove)
  if (add === null || remove === null) throw new HerdrError('bad_action', 'Invalid label: no commas, quotes or line breaks, at most 80 characters')
  if (b.note !== undefined && (typeof b.note !== 'string' || b.note.includes('\0'))) throw new HerdrError('bad_action', 'Invalid note')
  const note = cleanTell(b.note)
  if (!add.length && !remove.length && !note) throw new HerdrError('empty', 'Nothing to change')
  const { row, src } = await beadOf(m, id)
  if (src.hub && [...add, ...remove].some(l => l.startsWith(REPO_LABEL))) throw new HerdrError('bad_action', 'The repo: label places a hub issue on the Board: change it with bd')
  const done: string[] = []
  try {
    if (add.length || remove.length) {
      await bd(m, src, labelsArgs(row.bead, add, remove.filter(l => !add.includes(l))))
      done.push('Labels saved')
    }
    if (note) {
      await bd(m, src, noteArgs(row.bead, note))
      done.push('Note added')
    }
  } finally { if (done.length) forget(m) }
  log(`bd update ${row.bead}${m.local ? '' : ` on ${m.label}`}: ${done.join(', ').toLowerCase()}`)
  return { ok: true, msg: done.join(' · ') }
}

// A reply: to the agent's pane while it is there, else a comment on the bead.
export async function tellBead(m: Machine, id: unknown, text: unknown): Promise<{ ok: true, msg: string }> {
  const words = cleanTell(text)
  if (!words) throw new HerdrError('empty', 'Nothing to send')
  const { row, src } = await beadOf(m, id)
  const { pane } = await agentOf(m, row, src)
  const p = pane ? findPane(pane) : undefined
  if (p) {
    await sendPrompt(p, words)
    return { ok: true, msg: 'Sent to its agent' }
  }
  await bd(m, src, commentArgs(row.bead, words))
  forget(m)
  log(`bd comment ${row.bead}${m.local ? '' : ` on ${m.label}`}`)
  return { ok: true, msg: 'Added as a comment' }
}

// Start, Archive (close) and Restore (reopen). Anything else is herdr-projects'.
export async function beadCommand(m: Machine, id: unknown, action: unknown, agent?: unknown): Promise<{ ok: true, msg: string }> {
  if (!isTaskCommand(action)) throw new HerdrError('bad_action', 'Unknown action')
  const { row, src } = await beadOf(m, id)
  if (!beadActions(row)[action as keyof ReturnType<typeof beadActions>]) throw refused(action)
  if (action === 'delegate') return startBead(m, row, src, agent)
  const out = await bd(m, src, action === 'archive' ? closeArgs(row.bead) : reopenArgs(row.bead))
  forget(m)
  log(`bd ${action === 'archive' ? 'close' : 'reopen'} ${row.bead}${m.local ? '' : ` on ${m.label}`}`)
  return { ok: true, msg: firstLine(out) }
}
function refused(action: TaskCommand): HerdrError {
  if (action === 'delegate') return new HerdrError('bad_action', 'This task cannot be started now')
  if (action === 'archive') return new HerdrError('bad_action', 'This task is already closed')
  if (action === 'restore') return new HerdrError('bad_action', 'This task is not closed')
  return new HerdrError('bad_action', 'beads tasks do not take this action')
}

export async function beadStartOptions(m: Machine, id: unknown): Promise<StartOptions> {
  const { src } = await beadOf(m, id)
  const agents = await installedAgentKinds(m).catch(() => [] as string[])
  if (src.hub && await hasQuartermaster(m)) {
    const usable = agents.filter(k => QM_KINDS.includes(k))
    const own = await qmWorkerAgent(m)
    const kind = own || defaultAgent(usable)
    return { agent: kind ? { value: kind, kind, place: 'quartermaster', from: 'quartermaster' } : null, agents: usable, slots: null, via: 'quartermaster' }
  }
  const kind = defaultAgent(agents)
  return { agent: kind ? { value: kind, kind, place: 'builtin', from: 'wherdr' } : null, agents, slots: null, via: 'wherdr' }
}
const defaultAgent = (agents: string[]) => (agents.includes('claude') ? 'claude' : agents[0] || '')

// The folder an agent works on a bead in: its repo's own database's folder,
// else (a hub issue) the Git checkout named after the repo that an open Herdr
// pane is in (a folder of that name without `.git`, such as Herdr's
// worktrees/<repo>/ container, is not it).
const isCheckout = async (m: Machine, d: string) => (await m.fs.stat(path.posix.join(d, '.git')).catch(() => null)) !== null
async function repoFolder(m: Machine, row: BeadRow, src: BeadsSource): Promise<string> {
  if (!src.hub) return src.dir
  for (const p of getState().panes) {
    if ((p.machine || '') !== m.key || !p.cwd) continue
    for (let d = p.cwd; d.startsWith(m.home + '/'); d = path.posix.dirname(d)) {
      if (path.posix.basename(d) === row.repo && await isCheckout(m, d)) return d
      if (d === m.home) break
    }
  }
  for (const d of [path.posix.join(m.home, row.repo), path.posix.join(m.home, 'src', row.repo), path.posix.join(m.home, 'code', row.repo)]) {
    if ((await m.fs.stat(d).catch(() => null))?.isDir) return d
  }
  throw new HerdrError('bad_cwd', fmt('No folder named {repo} found on {machine}: open it in Herdr first', { repo: row.repo, machine: m.label }))
}

async function startBead(m: Machine, row: BeadRow, src: BeadsSource, agent: unknown): Promise<{ ok: true, msg: string }> {
  if (src.hub && await hasQuartermaster(m)) return dispatchBead(m, row, agent)
  const agents = await installedAgentKinds(m)
  const picked = typeof agent === 'string' && agent ? agent.split('/')[0]! : defaultAgent(agents)
  if (!picked || !agents.includes(picked)) throw new HerdrError('bad_agent', fmt('{agent} is not installed on {machine}', { agent: picked || '?', machine: m.label }))
  const cwd = await repoFolder(m, row, src)
  const git = (await m.fs.stat(path.posix.join(cwd, '.git')).catch(() => null)) !== null
  const created = await createAgent({
    kind: picked, machine: m.key, cwd, worktree: git, branch: git ? startBranch(row.bead) : undefined,
    label: startLabel(row.bead, row.title), name: startLabel(row.bead, row.title),
    prompt: startPrompt(row.bead, row.title, src.hub),
  }) as { pane_id: string }
  await rememberPane(m, row.id, created.pane_id)
  // Marked as started now; the agent claims it again itself.
  await bd(m, src, startArgs(row.bead, picked)).catch(e => log(`bd update ${row.bead}: ${(e as Error).message}`))
  forget(m)
  log(`beads start ${row.bead} with ${picked}${m.local ? '' : ` on ${m.label}`}`)
  return { ok: true, msg: fmt('{agent} started on {id}', { agent: picked, id: row.bead }) }
}

// ---------------------------------------------------------------- quartermaster
// A hub issue's Start is quartermaster's dispatch when the machine has
// quartermaster (travisjeffery/herdr-quartermaster): it checks the bead's repo:
// label against its repos, the host and its free worker slots, then claims the
// bead, opens its worktree on `<prefix><id>-<slug>` and briefs an agent named
// after it. Its refusal (no slot free, a repo it does not know…) is Start's
// error: wherdr never starts the agent itself around it. A repo's own database,
// a machine without quartermaster, or WHERDR_BEADS_START=wherdr: wherdr's Start.
export type QuartermasterRunner = (m: Machine, args: string[], timeoutMs: number) => Promise<BeadsRunResult>
const QM_KINDS = ['claude', 'codex', 'muse']
const QM_PROBE_MS = 10_000
const DISPATCH_TIMEOUT_MS = 180_000
const QM_CONFIG = '.config/quartermaster/config.toml'

// On an SSH machine: quartermaster's arguments, run from HOME with the beads env.
export const REMOTE_QM_SCRIPT = USER_PATH_SH
  + `f="$HOME/${BEADS_ENV_FILE}"; if [ -r "$f" ]; then set -a; . "$f"; set +a; fi; `
  + 'cd "$HOME" || exit 1; NO_COLOR=1; export NO_COLOR; exec quartermaster "$@"'

const runQm: QuartermasterRunner = async (m, args, timeoutMs) => {
  if (m.exec) {
    const r = await m.exec(REMOTE_QM_SCRIPT, args, { timeoutMs, maxBytes: OUTPUT_MAX })
    return { code: r.code ?? 1, stdout: r.stdout.toString('utf8'), stderr: r.stderr.trim() }
  }
  const env: NodeJS.ProcessEnv = { ...HERDR_CHILD_ENV, PATH: userPath({ env: { PATH: HERDR_CHILD_ENV.PATH }, home: m.home }), NO_COLOR: '1', ...await localBeadsEnv(m.home) }
  return new Promise(resolve => execFile('quartermaster', args, { cwd: m.home, env, timeout: timeoutMs, maxBuffer: OUTPUT_MAX }, (err, stdout, stderr) => resolve({
    code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
    stdout: String(stdout),
    stderr: String(stderr || (err ? (err.killed ? `quartermaster did not answer within ${Math.round(timeoutMs / 1000)} s` : err.message) : '')).trim(),
  })))
}
let qmRunner: QuartermasterRunner = runQm
// Tests replace quartermaster with what it would answer.
export function setQuartermasterRunner(r: QuartermasterRunner | null) { qmRunner = r || runQm }

// WHERDR_BEADS_START: `auto` (quartermaster where it is installed) or `wherdr`.
export const beadsStartSetting = (v = process.env.WHERDR_BEADS_START) => (v?.trim().toLowerCase() === 'wherdr' ? 'wherdr' : 'auto')

// Whether the machine has quartermaster: `quartermaster version` answers. Asked
// again after DISCOVER_MS, as databases are.
const qmSeen = new Map<string, { at: number, ok: boolean }>()
async function hasQuartermaster(m: Machine): Promise<boolean> {
  if (beadsStartSetting() === 'wherdr') return false
  const seen = qmSeen.get(m.key)
  if (seen && Date.now() - seen.at < DISCOVER_MS) return seen.ok
  const ok = await qmRunner(m, ['version'], QM_PROBE_MS).then(r => r.code === 0, () => false)
  qmSeen.set(m.key, { at: Date.now(), ok })
  return ok
}

// quartermaster's own default agent (`worker_agent` in its config), if it names one it starts.
export function parseWorkerAgentSetting(toml: string): string {
  const v = /^\s*worker_agent\s*=\s*["']([a-z]+)["']/m.exec(toml)?.[1] || ''
  return QM_KINDS.includes(v) ? v : ''
}
async function qmWorkerAgent(m: Machine): Promise<string> {
  try { return parseWorkerAgentSetting(await m.fs.readFile(path.posix.join(m.home, QM_CONFIG))) }
  catch { return '' }
}

// `quartermaster dispatch <id> [--agent K]`: an agent picked for this start
// only, else quartermaster's worker_agent. A model in the pick (`codex/gpt-5`)
// is the program's own to choose there: quartermaster takes no model.
async function dispatchBead(m: Machine, row: BeadRow, agent: unknown): Promise<{ ok: true, msg: string }> {
  const kind = typeof agent === 'string' && agent ? agent.split('/')[0]! : ''
  if (kind && !QM_KINDS.includes(kind)) throw new HerdrError('bad_agent', fmt('quartermaster starts claude, codex or muse, not {agent}', { agent: kind }))
  if (kind && !(await installedAgentKinds(m)).includes(kind)) throw new HerdrError('bad_agent', fmt('{agent} is not installed on {machine}', { agent: kind, machine: m.label }))
  const r = await qmRunner(m, ['dispatch', row.bead, ...(kind ? ['--agent', kind] : [])], DISPATCH_TIMEOUT_MS)
  forget(m)
  if (r.code !== 0) throw new HerdrError('dispatch_failed', firstLine(r.stderr).replace(/^Error:\s*/i, '') || firstLine(r.stdout) || `quartermaster dispatch: code ${r.code}`)
  log(`quartermaster dispatch ${row.bead}${kind ? ` --agent ${kind}` : ''}${m.local ? '' : ` on ${m.label}`}`)
  return { ok: true, msg: firstLine(r.stdout) || fmt('quartermaster dispatched {id}', { id: row.bead }) }
}

// Resume and Resolve, quartermaster's, on a hub issue where it is installed:
// Resume (`quartermaster resume <id>`) when the issue is open and its worktree
// has no agent left, continuing that agent's last conversation; Resolve
// (`quartermaster resolve <id>`) once it is closed and its worktree is still
// there, removing it and its merged branch. quartermaster refuses Resolve on an
// open issue, a working agent or a dirty worktree: `force` (asked hard in the
// sheet) passes --force, which removes it all the same.
async function qmOffers(m: Machine, row: BeadRow, src: BeadsSource, agent: BeadAgent): Promise<{ resume?: boolean, resolve?: boolean }> {
  if (!src.hub || !agent.worktree || !await hasQuartermaster(m)) return {}
  return row.group === 'done' ? { resolve: true } : agent.pane ? {} : { resume: true }
}
const RESUME_TIMEOUT_MS = 180_000
const RESOLVE_TIMEOUT_MS = 60_000
export async function beadQuartermaster(m: Machine, id: unknown, action: unknown, force?: unknown): Promise<{ ok: true, msg: string }> {
  if (!isQmAction(action)) throw new HerdrError('bad_action', 'Unknown action')
  const { row, src } = await beadOf(m, id)
  if (!src.hub) throw new HerdrError('bad_action', 'quartermaster works on hub issues only')
  if (!await hasQuartermaster(m)) throw new HerdrError('bad_action', fmt('quartermaster is not installed on {machine}', { machine: m.label }))
  const forced = action === 'resolve' && force === true
  if (action === 'resume' && row.group === 'done') throw new HerdrError('bad_action', 'This task is closed: Reopen it first')
  if (action === 'resolve' && row.group !== 'done' && !forced) throw new HerdrError('bad_action', 'This task is not closed')
  const args = [action, row.bead, ...(forced ? ['--force'] : [])]
  const r = await qmRunner(m, args, action === 'resume' ? RESUME_TIMEOUT_MS : RESOLVE_TIMEOUT_MS)
  forget(m)
  if (r.code !== 0) throw new HerdrError(`${action}_failed`, firstLine(r.stderr).replace(/^Error:\s*/i, '') || firstLine(r.stdout) || `quartermaster ${action}: code ${r.code}`)
  log(`quartermaster ${args.join(' ')}${m.local ? '' : ` on ${m.label}`}`)
  return { ok: true, msg: firstLine(r.stdout) || fmt(action === 'resume' ? 'quartermaster resumed {id}' : 'quartermaster resolved {id}', { id: row.bead }) }
}

export async function addBead(m: Machine, b: { title?: unknown, description?: unknown, repo?: unknown, delegate?: unknown }): Promise<{ ok: true, msg: string }> {
  const title = cleanTitle(b.title)
  if (!title) throw new HerdrError('empty', 'A task needs a title')
  const repo = cleanRepo(b.repo)
  if (repo === null) throw new HerdrError('bad_repo', 'Invalid repo')
  const list = await beadsSources(m)
  // A folder: its own database when it has one; a name: its repo's database,
  // else the hub with that repo's label.
  const name = repo.startsWith('/') || repo.startsWith('~') ? path.posix.basename(repo) : repo
  const own = list.find(s => !s.hub && (s.name === name || s.dir === repo))
  const hub = list.find(s => s.hub)
  const src = own || hub
  if (!src) throw new HerdrError('beads_missing', fmt('No beads database found on {machine}', { machine: m.label }))
  const out = await bd(m, src, createArgs({ title, description: cleanTell(b.description), repoLabel: src.hub && name ? name : '' }))
  forget(m)
  let id = ''
  try { id = String(JSON.parse(out).id || '') } catch { /* the message alone */ }
  log(`bd create${m.local ? '' : ` on ${m.label}`}`)
  if (b.delegate === true && isBeadId(id)) {
    const row = (await readList(m)).tasks.find(t => t.bead === id)
    if (row) return startBead(m, row, src, null)
  }
  return { ok: true, msg: id ? fmt('{id} created', { id }) : firstLine(out) }
}

// ---------------------------------------------------------------- agents on beads
// The pane Start opened for each bead (`machine|<repo>/<bead>` → pane id), in
// wherdr's data folder: only while Herdr still shows that pane.
const LINKS_FILE = () => path.join(DATA_DIR, 'beads-panes.json')
const links = new Map<string, string>()
let linksRead = false
async function readLinks() {
  if (linksRead) return
  linksRead = true
  try {
    const v = JSON.parse(await fsp.readFile(LINKS_FILE(), 'utf8'))
    for (const [k, p] of Object.entries(v || {})) if (typeof p === 'string') links.set(k, p)
  } catch { /* none yet */ }
}
async function rememberPane(m: Machine, id: string, pane: string) {
  await readLinks()
  links.set(`${m.key}|${id}`, pane)
  for (const [k, p] of links) if (!findPane(p) && p !== pane) links.delete(k)
  await fsp.mkdir(DATA_DIR, { recursive: true })
  await fsp.writeFile(LINKS_FILE(), JSON.stringify(Object.fromEntries(links), null, 2) + '\n')
}
async function paneOf(m: Machine, id: string): Promise<string | null> {
  await readLinks()
  const p = links.get(`${m.key}|${id}`)
  return p && findPane(p) ? p : null
}

// The agent at work on a bead, found by its worktree: Herdr's worktrees of the
// bead's repo (`worktree.list`), the one on the bead's branch (onBeadBranch:
// wherdr's Start, quartermaster or any tool that names it so), and the agent
// in its open workspace (the one named after the bead first). Without one,
// the pane wherdr's Start opened, if Herdr still shows it. Its branch and
// folder are given either way: the panel's files and changes are the worktree's.
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
export interface BeadAgent { pane: string | null, branch: string, worktree: string }
async function agentOf(m: Machine, row: BeadRow, src: BeadsSource): Promise<BeadAgent> {
  const started = await paneOf(m, row.id)
  let root: string
  try { root = await repoFolder(m, row, src) } catch { return { pane: started, branch: '', worktree: '' } }
  const r: Json | null = await herdrOn<Json>(m.key, 'worktree.list', { cwd: root, trust_repository: true }, 8000).catch(() => null)
  const trees: Json[] = Array.isArray(r?.worktrees) ? r!.worktrees : []
  // The open one first: two checkouts of the bead's branch, the one with agents is it.
  const mine = trees.filter(w => w?.is_linked_worktree && !w.is_bare && typeof w.branch === 'string' && onBeadBranch(w.branch, row.bead))
    .sort((a, b) => Number(Boolean(b.open_workspace_id)) - Number(Boolean(a.open_workspace_id)))
  const w = mine[0]
  if (!w) return { pane: started, branch: '', worktree: '' }
  const ws = w.open_workspace_id ? joinId(m.key, String(w.open_workspace_id)) : null
  const panes = ws ? getState().panes.filter(p => p.workspace === ws && p.agent) : []
  const named = beadAgentName(row.bead)
  const pane = panes.find(p => p.name === named) ?? (started && panes.some(p => p.id === started) ? panes.find(p => p.id === started) : undefined) ?? panes[0]
  return { pane: pane?.id ?? started, branch: String(w.branch), worktree: typeof w.path === 'string' ? w.path : '' }
}

// ---------------------------------------------------------------- mentions
// Every bead of the machine's Board, with the agent at work on it, for links
// in conversations: an agent named after it (quartermaster names its workers
// so), one in the open workspace of a worktree on its branch, or the one
// wherdr's Start opened. Kept REFS_MS: a conversation asks again as it grows.
const REFS_MS = 10_000
const refsCache = new Map<string, { at: number, refs: Promise<BeadRef[]> }>()
export function beadRefs(m: Machine): Promise<BeadRef[]> {
  const hit = refsCache.get(m.key)
  if (hit && Date.now() - hit.at < REFS_MS) return hit.refs
  const refs = (async () => {
    const c = lists.get(m.key) && Date.now() - lists.get(m.key)!.at < REUSE_MS ? lists.get(m.key)! : await readList(m)
    await readLinks()
    const panes = getState().panes.filter(p => (p.machine || '') === m.key && p.agent)
    const byName = new Map(panes.filter(p => p.name).map(p => [p.name!, p.id]))
    const trees = await machineWorktrees(m).catch(() => [])
    return c.tasks.map((r): BeadRef => {
      const named = byName.get(beadAgentName(r.bead))
      const tree = named ? null : trees.find(w => w.branch && w.workspace && onBeadBranch(w.branch, r.bead))
      const inTree = tree ? panes.find(p => p.workspace === tree.workspace) : undefined
      const started = links.get(`${m.key}|${r.id}`)
      const pane = named ?? inTree?.id ?? (started && findPane(started) ? started : null)
      return { machine: m.key, id: r.id, bead: r.bead, title: r.title, group: r.group, pane }
    })
  })()
  refs.catch(() => refsCache.delete(m.key))
  refsCache.set(m.key, { at: Date.now(), refs })
  return refs
}
