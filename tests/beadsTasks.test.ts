// beads as the Board reads it (shared/beadsTasks.ts), against bd 1.3.2's own
// output (tests/recordings/beads-1.3.2, a neutral database).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assigneeAgent, beadActions, beadAgentName, createArgs, onBeadBranch, startBranch, groupOfStatus, isBeadId, parseBeadDetails, parseBeadList, parseWhere, repoOfLabels, startPrompt,
} from '../shared/beadsTasks'
import { isTaskId, sortTasks, taskActions, taskKey } from '../shared/projectsTasks'

const rec = (f: string) => readFileSync(new URL(`./recordings/beads-1.3.2/${f}`, import.meta.url), 'utf8')

describe('bead ids', () => {
  it.each(['demo-fha', 'hub-ozxp.32', 'bd_x-1a'])('takes %s', id => expect(isBeadId(id)).toBe(true))
  it.each(['--json', '-x', 'demo', '../etc', 'demo-fha;rm', 'demo-'])('refuses %s', id => expect(isBeadId(id)).toBe(false))
  it('makes Board ids that both backends accept, and names a bead by itself', () => {
    expect(isTaskId('web/demo-fha')).toBe(true)
    expect(isTaskId('hub/hub-ozxp.32')).toBe(true)
    expect(isTaskId('demo-app/12')).toBe(true)
    expect(isTaskId('web/--json')).toBe(false)
    expect(taskKey('web/demo-fha')).toBe('demo-fha')
    expect(taskKey('demo-app/12', 'DEMO')).toBe('DEMO-12')
  })
})

describe('bd list', () => {
  const open = parseBeadList(rec('list.json'), 'demo')
  const byBead = Object.fromEntries(open.map(r => [r.bead, r]))

  it('puts each status in its Board group', () => {
    expect(byBead['demo-64h']).toMatchObject({ group: 'needs', state: 'blocked', stage: 'needs_me' })
    expect(byBead['demo-are']).toMatchObject({ group: 'working', state: 'working', app: 'claude', msg: 'claude is on it' })
    expect(byBead['demo-8tu']).toMatchObject({ group: 'todo', state: 'idle', stage: 'open' })
  })
  it('shows an open issue whose blocker is still open as waiting for it', () => {
    expect(byBead['demo-fha']).toMatchObject({ group: 'todo', stage: 'waiting', msg: 'Waits for demo-8tu' })
  })
  it('groups a hub issue under its repo label, a repo database’s under the repo', () => {
    expect(byBead['demo-fha']).toMatchObject({ id: 'web/demo-fha', repo: 'web' })
    expect(byBead['demo-8tu']).toMatchObject({ id: 'demo/demo-8tu', repo: 'demo' })
    expect(parseBeadList(rec('list.json'), 'demo-app', undefined, false).find(r => r.bead === 'demo-fha')).toMatchObject({ id: 'demo-app/demo-fha', repo: 'demo-app' })
  })
  it('marks every row as a beads row, with created times for ordering', () => {
    for (const r of open) {
      expect(r.backend).toBe('beads')
      expect(r.created).toBeGreaterThan(0)
    }
  })
  it('treats a blocker missing from the open list as done', () => {
    const closed = parseBeadList(rec('list.json'), 'demo', new Set(['demo-fha']))
    expect(closed.find(r => r.bead === 'demo-fha')).toMatchObject({ stage: 'open', msg: 'Changelog drafted' })
  })
  it('reads closed issues as Done, with the reason as the line', () => {
    const [done] = parseBeadList(rec('list-closed.json'), 'demo', new Set())
    expect(done).toMatchObject({ bead: 'demo-acy', group: 'done', state: 'done', msg: 'Merged in https://github.com/example/demo/pull/7' })
  })
  it('sorts with the herdr-projects rows’ rules', () => {
    expect(sortTasks(open).map(r => r.group)).toEqual(['needs', 'working', 'todo', 'todo'])
  })
  it('refuses what is not a list, and drops rows it cannot read', () => {
    expect(() => parseBeadList('{}', 'demo')).toThrow('not a list')
    expect(() => parseBeadList('nope', 'demo')).toThrow('not JSON')
    expect(parseBeadList('null', 'demo')).toEqual([])
    expect(parseBeadList('[{"id":"--x","title":"bad"},{"id":"demo-1","status":"open","title":"ok"}]', 'demo').map(r => r.bead)).toEqual(['demo-1'])
  })
})

describe('bd show', () => {
  const d = parseBeadDetails(rec('show.json'), 'web/demo-fha', rec('comments.json'))
  it('reads its description, notes and comments', () => {
    expect(d).toMatchObject({ id: 'web/demo-fha', title: 'Ship the release', description: 'Tag and publish.', stage: 'open' })
    expect(d.summary).toBe('Changelog drafted\n\nalice: Waiting on CI')
    expect(d.bead).toMatchObject({ id: 'demo-fha', status: 'open', labels: ['repo:web'], comments: 1 })
  })
  it('names what it waits for, and which are still open', () => {
    expect(d.after).toEqual({ waitsFor: ['demo-8tu'], left: ['demo-8tu'], waiting: true, forYou: '', titles: { 'demo-8tu': 'Set up CI' } })
  })
  it('refuses an unexpected reply', () => {
    expect(() => parseBeadDetails('[]', 'web/demo-fha')).toThrow('unexpected reply')
  })
})

describe('what the Board offers on a bead', () => {
  it('Start, Close and replies while open; Reopen once closed; nothing herdr-projects-only', () => {
    expect(beadActions({ group: 'todo', stage: 'open' })).toEqual({ tell: true, approve: false, delegate: true, stop: false, retry: false, finish: false, archive: true, restore: false })
    expect(beadActions({ group: 'working', stage: 'in_progress' })).toMatchObject({ delegate: false, archive: true, tell: true })
    expect(beadActions({ group: 'done', stage: 'closed' })).toMatchObject({ delegate: false, archive: false, restore: true, tell: false })
  })
  it('is what taskActions answers for a beads row', () => {
    const [row] = parseBeadList(rec('list-closed.json'), 'demo', new Set())
    expect(taskActions(row!)).toEqual(beadActions(row!))
  })
})

describe('commands and helpers', () => {
  it('keeps the user’s words out of flags', () => {
    expect(createArgs({ title: '--force', description: '-d x', repoLabel: 'web' })).toEqual(['create', '--json', '--description=-d x', '--labels=repo:web', '--', '--force'])
  })
  it('reads repo labels, statuses, assignees and `bd where`', () => {
    expect(repoOfLabels(['src:gitea', 'repo:support'])).toBe('support')
    expect(repoOfLabels(['repo:../x'])).toBe('')
    expect(groupOfStatus('hooked')).toBe('working')
    expect(groupOfStatus('deferred')).toBe('todo')
    expect(assigneeAgent('codex/gpt-5')).toBe('codex')
    expect(assigneeAgent('alice')).toBe('')
    expect(parseWhere(rec('where.txt'))).toBe('/home/user/demo-app/.beads')
    expect(parseWhere('Error: no beads')).toBe('')
  })
  it('tells the agent how to claim, report and close the bead', () => {
    const p = startPrompt('demo-fha', 'Ship the release', true)
    expect(p).toContain('bd show demo-fha')
    expect(p).toContain('bd update demo-fha --claim')
    expect(p).toContain('bd close demo-fha')
    expect(p).toContain('repo:')
  })
})

describe('a bead’s branch', () => {
  it('names its agent as quartermaster does', () => {
    expect(beadAgentName('Hub-OZXP.32')).toBe('hub-ozxp-32')
  })
  it.each([
    ['tj/hub-ab', 'hub-ab'], ['bead/hub-ab-fix-login', 'hub-ab'], ['hub-ab-fix', 'hub-ab'],
    ['tj/hub-ozxp-32-pii-guard', 'hub-ozxp.32'], [startBranch('hub-ozxp.32'), 'hub-ozxp.32'],
  ])('%s is %s’s', (branch, id) => expect(onBeadBranch(branch, id)).toBe(true))
  it.each([
    ['tj/hub-ab-7-child-work', 'hub-ab'], ['tj/hub-abc', 'hub-ab'], ['main', 'hub-ab'], ['tj/other-hub-ab', 'hub-ab'],
  ])('%s is not %s’s', (branch, id) => expect(onBeadBranch(branch, id)).toBe(false))
})
