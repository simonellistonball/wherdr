// beads on the server (server/utils/beadsTasks.ts, server/utils/tasksBackend.ts),
// bd replaced by recorded output (tests/recordings/beads-1.3.2): which
// databases are found, what runs where, and what Start opens.
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localFs } from '../server/utils/fsx'

const home = path.join(os.tmpdir(), 'wherdr-beads-server')
const repo = path.join(home, 'src/demo-app')
const web = path.join(home, 'src/web')
const machine = { key: '', label: 'devbox', local: true, status: 'online', home, session: 'default', exec: null, sock: () => null, fs: localFs, info: () => ({ key: '' }) }
let panes: { id: string, cwd: string, machine?: string, workspace?: string, agent?: string | null, name?: string | null }[] = []
// Herdr's `worktree.list` for a repo folder: what quartermaster (or Start) made.
let worktrees: Record<string, unknown>[] = []
const listed: unknown[] = []
const created: Record<string, unknown>[] = []
const sent: { pane: string, text: string }[] = []
let pluginStatus = 'missing'
vi.mock('../server/utils/machines', () => ({ allMachines: () => [machine], baseMachines: () => [machine], machineOfPane: () => null }))
vi.mock('../server/utils/actions', () => ({
  machineFor: () => machine,
  createAgent: async (b: Record<string, unknown>) => { created.push(b); return { pane_id: 'w9:p1', workspace_id: 'w9', name: 'x' } },
}))
vi.mock('../server/utils/projectsPlugin', () => ({ projectsPluginInfo: async () => ({ status: pluginStatus, version: null, launcher: null }) }))
vi.mock('../server/utils/state', () => ({
  findPane: (id: string) => panes.find(p => p.id === id),
  getState: () => ({ panes }),
  sendPrompt: async (p: { id: string }, text: string) => { sent.push({ pane: p.id, text }) },
}))
vi.mock('../server/utils/herdr', async orig => ({
  ...await orig<typeof import('../server/utils/herdr')>(),
  herdrOn: async (_m: string, method: string, params: Record<string, unknown>) => {
    listed.push({ method, ...params })
    return { source: { repo_root: params.cwd }, worktrees }
  },
}))
// Herdr's worktrees of the machine, as server/utils/worktrees.ts lists them.
let machineTrees: { branch: string | null, workspace: string | null, path: string }[] = []
vi.mock('../server/utils/worktrees', () => ({ machineWorktrees: async () => machineTrees }))
vi.mock('../server/utils/env', () => ({ HERDR_BIN: 'herdr', HERDR_CHILD_ENV: {}, DATA_DIR: path.join(home, 'wherdr-data'), log: () => {} }))
vi.mock('../server/utils/agentAvailability', () => ({ installedAgentKinds: async () => ['codex', 'claude'] }))

const B = await import('../server/utils/beadsTasks')
const D = await import('../server/utils/tasksBackend')
const rec = (f: string) => readFileSync(new URL(`./recordings/beads-1.3.2/${f}`, import.meta.url), 'utf8')

let calls: { dir: string, hub: boolean, args: string[] }[]
let hubFound: boolean
// quartermaster: missing unless a test installs it; what it was asked.
let qm: ((args: string[]) => { code: number, stdout: string, stderr: string }) | null
let qmCalls: string[][]
// demo-fha closed: the hub lists it with the closed issues.
let fhaClosed: boolean
function hubList(closed: boolean): string {
  const open = JSON.parse(rec('list.json')) as Record<string, unknown>[]
  const done = JSON.parse(rec('list-closed.json')) as Record<string, unknown>[]
  if (!fhaClosed) return JSON.stringify(closed ? done : open)
  const fha = { ...open.find(r => r.id === 'demo-fha')!, status: 'closed', closed_at: '2026-11-18T10:00:00Z', close_reason: 'merged' }
  return JSON.stringify(closed ? [fha, ...done] : open.filter(r => r.id !== 'demo-fha'))
}
beforeEach(() => {
  fhaClosed = false
  rmSync(home, { recursive: true, force: true })
  mkdirSync(path.join(repo, '.beads'), { recursive: true })
  mkdirSync(path.join(repo, '.git'), { recursive: true })
  mkdirSync(path.join(web, '.git'), { recursive: true })
  panes = [{ id: 'w1:p1', cwd: path.join(repo, 'src') }, { id: 'w2:p1', cwd: web }]
  created.length = 0
  sent.length = 0
  worktrees = []
  machineTrees = []
  listed.length = 0
  calls = []
  hubFound = true
  pluginStatus = 'missing'
  B.resetBeadsCache()
  D.resetBackendChoices()
  qm = null
  qmCalls = []
  delete process.env.WHERDR_BEADS_START
  B.setQuartermasterRunner(async (_m, args) => {
    qmCalls.push(args)
    return qm ? qm(args) : { code: 127, stdout: '', stderr: 'quartermaster: not found' }
  })
  B.setBeadsRunner(async (_m, dir, hub, args) => {
    calls.push({ dir, hub, args })
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' })
    if (args[0] === 'where') {
      if (hub && !hubFound) return { code: 1, stdout: '', stderr: 'Error: No active beads workspace found.' }
      return ok(hub ? '/home/user/.beads-hub/.beads\n  prefix: hub\n' : rec('where.txt'))
    }
    // The repo's own database: one issue of its own.
    if (args[0] === 'list' && !hub) return ok(args.includes('--status=closed') ? '[]' : '[{"id":"app-k2","title":"Local bug","status":"open","priority":1,"issue_type":"bug","created_at":"2026-11-13T20:30:40Z","labels":["repo:elsewhere"]}]')
    if (args[0] === 'list') return ok(hubList(args.includes('--status=closed')))
    if (args[0] === 'show') return ok(rec('show.json'))
    if (args[0] === 'comments') return ok(rec('comments.json'))
    if (args[0] === 'create') return ok('{"id":"hub-new1","title":"x","status":"open"}')
    return ok('✓ done\n')
  })
})

describe('finding databases', () => {
  it('finds the hub from HOME and a repo of a Herdr pane with its own .beads/', async () => {
    const list = await B.beadsSources(machine as never)
    expect(list.map(s => ({ name: s.name, hub: s.hub, dir: s.dir }))).toEqual([
      { name: 'hub', hub: true, dir: home },
      { name: 'demo-app', hub: false, dir: repo },
    ])
    // A repo's own database is read with BEADS_DIR unset (hub: false).
    expect(calls.filter(c => c.args[0] === 'where').map(c => [c.dir, c.hub])).toEqual([[home, true], [repo, false]])
  })
  it('chooses beads where herdr-projects is not ready and a database is found, herdr-projects otherwise', async () => {
    expect(await D.backendOf(machine as never)).toBe('beads')
    D.resetBackendChoices(); B.resetBeadsCache()
    pluginStatus = 'ready'
    expect(await D.backendOf(machine as never)).toBe('projects')
    D.resetBackendChoices(); B.resetBeadsCache()
    pluginStatus = 'missing'; hubFound = false; panes = []
    expect(await D.backendOf(machine as never)).toBe('projects')
  })
  it('reads WHERDR_TASKS_BACKEND for every machine or by label', () => {
    expect(D.parseBackendSetting(undefined).all).toBe('auto')
    expect(D.parseBackendSetting('beads').all).toBe('beads')
    const s = D.parseBackendSetting('devbox=beads, *=projects, x=bogus')
    expect(s.all).toBe('projects')
    expect([...s.by]).toEqual([['devbox', 'beads']])
  })
})

describe('the Board', () => {
  it('lists every database’s issues, as a beads board', async () => {
    const r = await D.readBoard()
    if ('same' in r) throw new Error('expected a board')
    const [m] = r.machines
    expect(m).toMatchObject({ machine: '', backend: 'beads', status: 'ready' })
    // The hub's rows under their repo label (or the hub); the repo database's under the repo, whatever its labels.
    expect(m!.tasks.map(t => t.id).sort()).toEqual(['demo-app/app-k2', 'hub/demo-64h', 'hub/demo-8tu', 'hub/demo-acy', 'hub/demo-are', 'web/demo-fha'].sort())
    expect(m!.tasks.every(t => !('bead' in t) && !('source' in t))).toBe(true)
  })
  it('reads one bead’s details from its own database', async () => {
    await D.readBoard()
    const d = await D.boardTaskDetails('', 'web/demo-fha')
    expect(d).toMatchObject({ id: 'web/demo-fha', title: 'Ship the release', pane: null })
    expect(calls.slice(-2).map(c => c.args)).toEqual([['show', '--json', '--', 'demo-fha'], ['comments', '--json', '--', 'demo-fha']])
  })
  it('closes and reopens', async () => {
    await D.readBoard()
    await D.boardCommand('', 'web/demo-fha', 'archive')
    expect(calls.at(-1)!.args).toEqual(['close', '--reason=Closed from wherdr', '--', 'demo-fha'])
    await D.boardCommand('', 'hub/demo-acy', 'restore')
    expect(calls.at(-1)!.args).toEqual(['reopen', '--', 'demo-acy'])
    await expect(D.boardCommand('', 'hub/demo-acy', 'archive')).rejects.toThrow('already closed')
    await expect(D.boardCommand('', 'web/demo-fha', 'approve')).rejects.toThrow('Unknown action')
  })
  it('refuses an id that is not a bead before running bd', async () => {
    await expect(D.boardTaskDetails('', 'web/--json')).rejects.toThrow('Invalid task')
    await expect(D.boardTaskDetails('', 'demo-app/12')).rejects.toThrow('Invalid task')
  })
  it('adds a hub issue with its repo label', async () => {
    const r = await D.boardAdd('', { title: 'New thing', description: 'Why', repo: 'web' })
    expect(r.msg).toBe('hub-new1 created')
    expect(calls.find(c => c.args[0] === 'create')).toEqual({ dir: home, hub: true, args: ['create', '--json', '--description=Why', '--labels=repo:web', '--', 'New thing'] })
  })
  it('adds to a repo’s own database without a label', async () => {
    await D.boardAdd('', { title: 'Local', repo: 'demo-app' })
    expect(calls.find(c => c.args[0] === 'create')).toEqual({ dir: repo, hub: false, args: ['create', '--json', '--', 'Local'] })
  })
})

describe('labels and notes', () => {
  it('adds and removes labels, then appends a note, on the bead’s own database', async () => {
    await D.readBoard()
    const r = await D.boardEditBead('', 'web/demo-fha', { add: ['ui', 'needs review'], remove: ['old'], note: '  Blocked on the API key  ' })
    expect(r.msg).toBe('Labels saved · Note added')
    expect(calls.slice(-2)).toEqual([
      { dir: home, hub: true, args: ['update', '--add-label=ui', '--add-label=needs review', '--remove-label=old', '--', 'demo-fha'] },
      { dir: home, hub: true, args: ['update', '--append-notes=Blocked on the API key', '--', 'demo-fha'] },
    ])
    await D.boardEditBead('', 'demo-app/app-k2', { note: 'Local' })
    expect(calls.at(-1)).toEqual({ dir: repo, hub: false, args: ['update', '--append-notes=Local', '--', 'app-k2'] })
  })
  it('keeps a hub issue’s repo label, not a repo database’s', async () => {
    await D.readBoard()
    await expect(D.boardEditBead('', 'web/demo-fha', { remove: ['repo:web'] })).rejects.toThrow('repo: label')
    await D.boardEditBead('', 'demo-app/app-k2', { remove: ['repo:elsewhere'] })
    expect(calls.at(-1)!.args).toEqual(['update', '--remove-label=repo:elsewhere', '--', 'app-k2'])
  })
  it('refuses bad labels and empty changes before running bd', async () => {
    await D.readBoard()
    const before = calls.length
    await expect(D.boardEditBead('', 'web/demo-fha', { add: ['a,b'] })).rejects.toThrow('Invalid label')
    await expect(D.boardEditBead('', 'web/demo-fha', { add: 'ui' })).rejects.toThrow('Invalid label')
    await expect(D.boardEditBead('', 'web/demo-fha', { note: '   ' })).rejects.toThrow('Nothing to change')
    await expect(D.boardEditBead('', 'web/--json', { note: 'x' })).rejects.toThrow('Invalid task')
    expect(calls.length).toBe(before)
  })
  it('says whether the bead is in the hub in its details', async () => {
    await D.readBoard()
    expect((await D.boardTaskDetails('', 'web/demo-fha')).bead).toMatchObject({ hub: true, notes: 'Changelog drafted' })
  })
  it('is for beads boards only', async () => {
    pluginStatus = 'ready'
    await expect(D.boardEditBead('', 'web/demo-fha', { note: 'x' })).rejects.toThrow('beads tasks only')
  })
})

describe('Start and replies', () => {
  it('opens an agent in a worktree of the repo’s folder, then marks the bead started', async () => {
    await D.readBoard()
    const opts = await D.boardStartOptions('', 'web/demo-fha')
    expect(opts.agent).toMatchObject({ kind: 'claude', place: 'builtin' })
    await D.boardCommand('', 'web/demo-fha', 'delegate')
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ kind: 'claude', machine: '', cwd: web, worktree: true, branch: 'bd/demo-fha' })
    expect(String(created[0]!.prompt)).toContain('bd update demo-fha --claim')
    expect(calls.at(-1)!.args).toEqual(['update', '--status=in_progress', '--assignee=claude', '--', 'demo-fha'])
  })
  it('starts with the agent picked, never one not installed', async () => {
    await D.readBoard()
    await D.boardCommand('', 'web/demo-fha', 'delegate', 'codex/gpt-5')
    expect(created[0]).toMatchObject({ kind: 'codex' })
    await expect(D.boardCommand('', 'web/demo-fha', 'delegate', 'gemini')).rejects.toThrow('gemini is not installed')
  })
  it('says which folder is missing when no repo of that name is open', async () => {
    panes = [{ id: 'w1:p1', cwd: path.join(repo, 'src') }]
    rmSync(web, { recursive: true, force: true })
    await D.readBoard()
    await expect(D.boardCommand('', 'web/demo-fha', 'delegate')).rejects.toThrow('No folder named web')
  })
  it('sends a reply to the agent Start opened, else adds it as a comment', async () => {
    await D.readBoard()
    expect((await D.boardTell('', 'web/demo-fha', 'Any news?')).msg).toBe('Added as a comment')
    expect(calls.at(-1)!.args).toEqual(['comment', '--', 'demo-fha', 'Any news?'])
    await D.boardCommand('', 'web/demo-fha', 'delegate')
    panes.push({ id: 'w9:p1', cwd: web })
    await D.readBoard()
    expect((await D.boardTell('', 'web/demo-fha', 'Use the staging key')).msg).toBe('Sent to its agent')
    expect(sent).toEqual([{ pane: 'w9:p1', text: 'Use the staging key' }])
  })
})

describe('Start through quartermaster', () => {
  const dispatched = 'started claude on demo-fha (w3:p1, branch bead/demo-fha-ship-the-release)'
  beforeEach(() => {
    qm = args => (args[0] === 'version'
      ? { code: 0, stdout: 'quartermaster 0.6.0\n', stderr: '' }
      : { code: 0, stdout: `${dispatched}\n`, stderr: '' })
  })
  it('dispatches a hub bead: quartermaster claims it, wherdr opens nothing itself', async () => {
    await D.readBoard()
    const opts = await D.boardStartOptions('', 'web/demo-fha')
    expect(opts).toMatchObject({ via: 'quartermaster', agent: { kind: 'claude', place: 'quartermaster' } })
    const r = await D.boardCommand('', 'web/demo-fha', 'delegate')
    expect(r.msg).toBe(dispatched)
    expect(qmCalls.at(-1)).toEqual(['dispatch', 'demo-fha'])
    expect(created).toHaveLength(0)
    // No bd update of its own: quartermaster claims the bead.
    expect(calls.some(c => c.args[0] === 'update')).toBe(false)
  })
  it('passes the agent picked, without its model, and only one quartermaster starts', async () => {
    await D.readBoard()
    await D.boardCommand('', 'web/demo-fha', 'delegate', 'codex/gpt-5')
    expect(qmCalls.at(-1)).toEqual(['dispatch', 'demo-fha', '--agent', 'codex'])
    await expect(D.boardCommand('', 'web/demo-fha', 'delegate', 'gemini')).rejects.toThrow('claude, codex or muse')
  })
  it('defaults to quartermaster’s worker_agent', async () => {
    mkdirSync(path.join(home, '.config/quartermaster'), { recursive: true })
    writeFileSync(path.join(home, '.config/quartermaster/config.toml'), 'repo = "~/x"\nworker_agent = "codex"\n')
    await D.readBoard()
    expect((await D.boardStartOptions('', 'web/demo-fha')).agent).toMatchObject({ kind: 'codex', place: 'quartermaster' })
  })
  it('says why quartermaster refused, and does not start the agent around it', async () => {
    qm = args => (args[0] === 'version' ? { code: 0, stdout: 'quartermaster 0.6.0\n', stderr: '' } : { code: 1, stdout: '', stderr: 'Error: local: all 12 slots are busy' })
    await D.readBoard()
    await expect(D.boardCommand('', 'web/demo-fha', 'delegate')).rejects.toThrow(/^local: all 12 slots are busy$/)
    expect(created).toHaveLength(0)
  })
  it('leaves a repo’s own database, and WHERDR_BEADS_START=wherdr, to wherdr’s Start', async () => {
    await D.readBoard()
    expect((await D.boardStartOptions('', 'demo-app/app-k2')).via).toBe('wherdr')
    await D.boardCommand('', 'demo-app/app-k2', 'delegate')
    expect(created).toHaveLength(1)
    expect(qmCalls.filter(a => a[0] === 'dispatch')).toHaveLength(0)
    B.resetBeadsCache()
    process.env.WHERDR_BEADS_START = 'wherdr'
    await D.readBoard()
    expect((await D.boardStartOptions('', 'web/demo-fha')).via).toBe('wherdr')
    await D.boardCommand('', 'web/demo-fha', 'delegate')
    expect(created).toHaveLength(2)
    expect(qmCalls.filter(a => a[0] === 'dispatch')).toHaveLength(0)
  })
  it('reads worker_agent only when it names an agent quartermaster starts', () => {
    expect(B.parseWorkerAgentSetting('worker_agent = "muse"')).toBe('muse')
    expect(B.parseWorkerAgentSetting('worker_agent = "gemini"')).toBe('')
    expect(B.parseWorkerAgentSetting('coordinator_agent = "codex"')).toBe('')
  })
})

describe('Resume and Resolve through quartermaster', () => {
  const tree = path.join(home, '.herdr/worktrees/web/tj-demo-fha-ship-the-release')
  let answer: { code: number, stdout: string, stderr: string }
  beforeEach(() => {
    mkdirSync(tree, { recursive: true })
    answer = { code: 0, stdout: 'resumed demo-fha (w5:p1)\n', stderr: '' }
    qm = args => (args[0] === 'version' ? { code: 0, stdout: 'quartermaster 0.6.0\n', stderr: '' } : answer)
    worktrees = [
      { branch: 'main', path: web, is_linked_worktree: false },
      { branch: 'tj/demo-fha-ship-the-release', path: tree, is_linked_worktree: true, open_workspace_id: null },
    ]
  })
  it('offers Resume on an open bead whose worktree has no agent left, and runs quartermaster resume', async () => {
    await D.readBoard()
    const d = await D.boardTaskDetails('', 'web/demo-fha')
    expect(d.bead).toMatchObject({ resume: true })
    expect(d.bead?.resolve).toBeUndefined()
    const r = await D.boardQuartermaster('', 'web/demo-fha', 'resume')
    expect(r.msg).toBe('resumed demo-fha (w5:p1)')
    expect(qmCalls.at(-1)).toEqual(['resume', 'demo-fha'])
  })
  it('offers nothing while its agent is open, or where quartermaster is missing', async () => {
    worktrees[1] = { ...worktrees[1], open_workspace_id: 'w5' }
    panes.push({ id: 'w5:p2', cwd: tree, workspace: 'w5', agent: 'claude', name: 'demo-fha' })
    await D.readBoard()
    const d = await D.boardTaskDetails('', 'web/demo-fha')
    expect(d.bead?.resume).toBeUndefined()
    expect(d.bead?.resolve).toBeUndefined()
    qm = null
    B.resetBeadsCache()
    panes = panes.filter(p => p.workspace !== 'w5')
    await D.readBoard()
    expect((await D.boardTaskDetails('', 'web/demo-fha')).bead?.resume).toBeUndefined()
    await expect(D.boardQuartermaster('', 'web/demo-fha', 'resume')).rejects.toThrow('not installed')
  })
  it('offers Resolve on a closed bead with its worktree, and --force only when asked', async () => {
    fhaClosed = true
    answer = { code: 0, stdout: 'resolved demo-fha: removed worktree and branch tj/demo-fha-ship-the-release\n', stderr: '' }
    await D.readBoard()
    const d = await D.boardTaskDetails('', 'web/demo-fha')
    expect(d.bead).toMatchObject({ resolve: true })
    expect(d.bead?.resume).toBeUndefined()
    await D.boardQuartermaster('', 'web/demo-fha', 'resolve')
    expect(qmCalls.at(-1)).toEqual(['resolve', 'demo-fha'])
    await D.boardQuartermaster('', 'web/demo-fha', 'resolve', true)
    expect(qmCalls.at(-1)).toEqual(['resolve', 'demo-fha', '--force'])
    await expect(D.boardQuartermaster('', 'web/demo-fha', 'resume')).rejects.toThrow('closed')
  })
  it('says why quartermaster refused Resolve', async () => {
    fhaClosed = true
    answer = { code: 1, stdout: '', stderr: 'Error: demo-fha: worktree has uncommitted changes (use --force)' }
    await D.readBoard()
    await expect(D.boardQuartermaster('', 'web/demo-fha', 'resolve')).rejects.toThrow(/^demo-fha: worktree has uncommitted changes \(use --force\)$/)
  })
  it('refuses Resolve on an open bead unless forced, other actions, and a repo’s own database', async () => {
    await D.readBoard()
    await expect(D.boardQuartermaster('', 'web/demo-fha', 'resolve')).rejects.toThrow('not closed')
    await expect(D.boardQuartermaster('', 'web/demo-fha', 'dispatch')).rejects.toThrow('Unknown action')
    await expect(D.boardQuartermaster('', 'demo-app/app-k2', 'resume')).rejects.toThrow('hub issues only')
    expect(qmCalls.filter(a => a[0] !== 'version')).toEqual([])
  })
})

describe('an agent found by its worktree', () => {
  const qm = path.join(home, '.herdr/worktrees/web/tj-demo-fha-ship-the-release')
  beforeEach(() => {
    mkdirSync(qm, { recursive: true })
    worktrees = [
      { branch: 'main', path: web, is_linked_worktree: false },
      { branch: 'tj/demo-fha-7-child', path: path.join(home, 'x'), is_linked_worktree: true, open_workspace_id: 'w7' },
      { branch: 'tj/demo-fha-ship-the-release', path: qm, is_linked_worktree: true, open_workspace_id: 'w5' },
    ]
    panes.push(
      { id: 'w5:p1', cwd: qm, workspace: 'w5', agent: null, name: null },
      { id: 'w5:p2', cwd: qm, workspace: 'w5', agent: 'claude', name: 'demo-fha' },
      { id: 'w7:p1', cwd: path.join(home, 'x'), workspace: 'w7', agent: 'claude', name: 'demo-fha-7' },
    )
  })
  it('gives the panel the worker quartermaster opened, its branch and its folder', async () => {
    await D.readBoard()
    const d = await D.boardTaskDetails('', 'web/demo-fha')
    expect(d).toMatchObject({ pane: 'w5:p2', branch: 'tj/demo-fha-ship-the-release', worktree: qm })
    // Asked in the repo's own checkout (not Herdr's worktrees/web container).
    expect(listed).toEqual([{ method: 'worktree.list', cwd: web, trust_repository: true }])
  })
  it('sends a reply to that worker', async () => {
    await D.readBoard()
    expect((await D.boardTell('', 'web/demo-fha', 'Rebase first')).msg).toBe('Sent to its agent')
    expect(sent).toEqual([{ pane: 'w5:p2', text: 'Rebase first' }])
  })
  it('keeps the branch and folder of a worktree with no agent open', async () => {
    panes = panes.filter(p => p.workspace !== 'w5')
    worktrees = worktrees.map(w => (w.path === qm ? { ...w, open_workspace_id: null } : w))
    await D.readBoard()
    expect(await D.boardTaskDetails('', 'web/demo-fha')).toMatchObject({ pane: null, branch: 'tj/demo-fha-ship-the-release', worktree: qm })
  })
})

describe('beads conversations link to', () => {
  it('names each bead’s agent: by its name, by its worktree, or as Start opened it', async () => {
    panes.push(
      { id: 'w3:p1', cwd: web, workspace: 'w3', agent: 'claude', name: 'demo-64h' },
      { id: 'w4:p1', cwd: web, workspace: 'w4', agent: 'codex', name: 'something-else' },
    )
    machineTrees = [{ branch: 'bead/demo-are-fix-login-bug', workspace: 'w4', path: path.join(home, 'wt') }]
    await D.readBoard()
    await D.boardCommand('', 'web/demo-fha', 'delegate')
    panes.push({ id: 'w9:p1', cwd: web, workspace: 'w9', agent: 'claude', name: 'x' })
    B.resetBeadsCache()
    // Start's link survives in its file; the caches start again.
    const r = await D.boardBeadRefs()
    if ('same' in r) throw new Error('expected refs')
    const pane = Object.fromEntries(r.refs.map(x => [x.bead, x.pane]))
    expect(pane).toMatchObject({ 'demo-64h': 'w3:p1', 'demo-are': 'w4:p1', 'demo-fha': 'w9:p1', 'demo-8tu': null, 'demo-acy': null })
    expect(r.refs.find(x => x.bead === 'demo-fha')).toMatchObject({ machine: '', id: 'web/demo-fha', title: 'Ship the release' })
    expect(await D.boardBeadRefs(r.version)).toEqual({ same: true, version: r.version })
  })
  it('says there is no beads board, without reading herdr-projects', async () => {
    pluginStatus = 'ready'
    const r = await D.boardBeadRefs()
    expect(r).toMatchObject({ refs: [], none: true })
    expect(calls.filter(c => c.args[0] === 'list')).toEqual([])
  })
})
