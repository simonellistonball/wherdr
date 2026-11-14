import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DOWNLOAD_BYTES, READ_SCRIPT, attachmentHeader, isPdf, isVideo, cleanRelative, listFiles, readFileBytes, readFilePreview, readWrittenBytes, readWrittenPreview } from '../server/utils/files'
import type { Machine } from '../server/utils/machines'
import { samplePdf } from './e2e/samplePdf.mjs'

const local = { exec: null } as unknown as Machine
let base = ''
let root = ''

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'wherdr-files-'))
  root = path.join(base, 'project')
  mkdirSync(path.join(root, 'src', 'deep'), { recursive: true })
  execFileSync('git', ['init', '-q', root])
  writeFileSync(path.join(root, 'README.md'), '# Hello\n')
  writeFileSync(path.join(root, '.env.example'), 'KEY=\n')
  writeFileSync(path.join(root, 'with space.txt'), 'a b\n')
  writeFileSync(path.join(root, 'src', 'app.ts'), 'export const x = 1\n')
  writeFileSync(path.join(root, 'blob.bin'), Buffer.from([1, 0, 2, 3]))
  writeFileSync(path.join(root, 'dot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(path.join(root, 'Guide.PDF'), samplePdf(['Page one', 'Page two']))
  writeFileSync(path.join(root, 'fake.pdf'), '<script>alert(1)</script>\n')
  writeFileSync(path.join(root, 'clip.MP4'), readFileSync(path.join(__dirname, 'e2e/fixtures/sample.mp4')))
  writeFileSync(path.join(root, 'clip.webm'), readFileSync(path.join(__dirname, 'e2e/fixtures/sample.webm')))
  writeFileSync(path.join(root, 'fake.mov'), '<html><script>alert(1)</script>\n')
  writeFileSync(path.join(root, 'big.txt'), 'line\n'.repeat(60000))
  writeFileSync(path.join(base, 'secret.txt'), 'nope\n')
  symlinkSync(path.join(base, 'secret.txt'), path.join(root, 'escape.txt'))
  symlinkSync(base, path.join(root, 'escape-dir'))
  symlinkSync(path.join(root, 'README.md'), path.join(root, 'inside.md'))
  symlinkSync(path.join(root, 'README.md'), path.join(root, '-e'))
  writeFileSync(path.join(root, 'min.js'), 'x'.repeat(300 * 1024))
  writeFileSync(path.join(root, 'accents.txt'), 'é'.repeat(200 * 1024))
  symlinkSync(root, path.join(base, 'via-link'))
  mkdirSync(path.join(base, 'crowded'))
  for (let i = 0; i < 30; i++) writeFileSync(path.join(base, 'crowded', `f${i}`), '')
  for (let i = 0; i < 3; i++) mkdirSync(path.join(base, 'crowded', `zdir${i}`))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))
afterAll(() => { if (elsewhere) rmSync(elsewhere, { recursive: true, force: true }) })
let elsewhere = ''

describe('read-only file browser', () => {
  it('lists folders first, then files with sizes, dotfiles and spaces included', async () => {
    const l = await listFiles(local, root, null)
    expect(l.path).toBe('')
    expect(l.entries.slice(0, 3).map(e => [e.name, e.kind, e.link])).toEqual([['.git', 'dir', false], ['escape-dir', 'dir', true], ['src', 'dir', false]])
    expect(l.entries.find(e => e.name === 'README.md')).toMatchObject({ kind: 'file', size: 8, link: false })
    expect(l.entries.map(e => e.name)).toEqual(expect.arrayContaining(['.env.example', '.git', 'with space.txt']))
  })

  it('starts in the pane folder and walks into subfolders', async () => {
    expect((await listFiles(local, path.join(root, 'src'), null)).entries.map(e => e.name)).toEqual(['deep', 'app.ts'])
    expect((await listFiles(local, root, 'src/deep')).entries).toEqual([])
  })

  it('refuses paths outside the root, through .. or a symlink', async () => {
    expect(() => cleanRelative('../x')).toThrow()
    expect(() => cleanRelative('/etc/passwd')).toThrow()
    expect(cleanRelative('src/./deep/')).toBe('src/deep')
    await expect(listFiles(local, root, 'escape-dir')).rejects.toMatchObject({ code: 'outside' })
    await expect(readFilePreview(local, root, 'escape.txt')).rejects.toMatchObject({ code: 'outside' })
    await expect(readFilePreview(local, root, 'missing.txt')).rejects.toMatchObject({ code: 'not_found' })
    await expect(readFilePreview(local, root, 'src')).rejects.toMatchObject({ code: 'not_file' })
  })

  it('previews text, images and binaries, truncating large text', async () => {
    expect(await readFilePreview(local, root, 'inside.md')).toMatchObject({ kind: 'text', text: '# Hello\n', truncated: false })
    expect(await readFilePreview(local, root, 'src/app.ts')).toMatchObject({ kind: 'text', size: 19 })
    expect(await readFilePreview(local, root, 'blob.bin')).toMatchObject({ kind: 'binary', size: 4 })
    expect((await readFilePreview(local, root, 'dot.png')).dataUrl).toBe('data:image/png;base64,iVBORw==')
    const big = await readFilePreview(local, root, 'big.txt')
    expect(big).toMatchObject({ kind: 'text', size: 300000, truncated: true })
    expect(big.text!.endsWith('line\n')).toBe(true)
    expect(big.text!.length).toBeLessThanOrEqual(256 * 1024)
  })

  it('previews a PDF by its extension and signature, without reading it', async () => {
    const pdf = samplePdf(['Page one', 'Page two'])
    expect(await readFilePreview(local, root, 'Guide.PDF')).toEqual({ path: 'Guide.PDF', size: pdf.length, kind: 'pdf', truncated: false })
    // A .pdf that is not one (here HTML) is never handed to a PDF viewer.
    expect(await readFilePreview(local, root, 'fake.pdf')).toMatchObject({ kind: 'binary' })
    expect(isPdf('a.pdf', Buffer.from('\n%PDF-1.7'))).toBe(true)
    expect(isPdf('a.bin', pdf)).toBe(false)
    expect(isPdf('a.pdf', Buffer.concat([Buffer.alloc(1024, 32), pdf]))).toBe(false)
  })

  it('reads only the head of a remote PDF, and calls one past the download limit too large', async () => {
    const calls: string[][] = []
    const size = (n: number): NonNullable<Machine['exec']> => async (_script, args = []) => {
      calls.push(args)
      return { code: 0, stdout: Buffer.concat([Buffer.from(`${n}\n`), samplePdf().subarray(0, 1024)]), stderr: '' }
    }
    const remote = (n: number) => ({ exec: size(n), home: '/home/user' }) as unknown as Machine
    expect(await readWrittenPreview(remote(11_000_000), '/home/user/demo', 'docs/manual.pdf')).toMatchObject({ kind: 'pdf', size: 11_000_000 })
    expect(calls.at(-1)).toEqual(['/home/user', 'demo/docs/manual.pdf', '1024'])
    expect(await readWrittenPreview(remote(DOWNLOAD_BYTES + 1), '/home/user/demo', 'docs/manual.pdf')).toMatchObject({ kind: 'large' })
  })

  it('hides the size of a symlink, which may point outside the root', async () => {
    const l = await listFiles(local, root, null)
    expect(l.entries.find(e => e.name === 'escape.txt')).toMatchObject({ kind: 'file', size: null, link: true })
  })

  it('opens on the pane folder even when its path goes through a symlink', async () => {
    const l = await listFiles(local, path.join(base, 'via-link', 'src'), null)
    expect(l.path).toBe('src')
    expect(l.entries.map(e => e.name)).toEqual(['deep', 'app.ts'])
  })

  it('keeps the folders when a long listing is cut', async () => {
    const l = await listFiles(local, path.join(base, 'crowded'), null, { max: 10 })
    expect(l.truncated).toBe(true)
    expect(l.entries).toHaveLength(10)
    expect(l.entries.slice(0, 3).map(e => e.name)).toEqual(['zdir0', 'zdir1', 'zdir2'])
  })

  it('previews a symlink whose name starts with a dash', async () => {
    expect(await readFilePreview(local, root, '-e')).toMatchObject({ kind: 'text', text: '# Hello\n' })
  })

  it('cuts a long single-line file at the limit without splitting a character', async () => {
    const min = await readFilePreview(local, root, 'min.js')
    expect(min).toMatchObject({ kind: 'text', truncated: true })
    expect(min.text!.length).toBe(256 * 1024)
    const acc = await readFilePreview(local, root, 'accents.txt')
    expect(acc.text!.length).toBe(128 * 1024)
    expect(acc.text!.includes('\uFFFD')).toBe(false)
  })

  it('reports a timeout and an unreachable machine as such', async () => {

    const ok = { code: 0, stdout: Buffer.from('/srv/repo\n'), stderr: '' }
    const after = (c: number | null) => {
      let n = 0
      return { exec: async () => (n++ ? { code: c, stdout: Buffer.alloc(0), stderr: '' } : ok) } as unknown as Machine
    }

    await expect(listFiles(after(124), '/srv/repo', '')).rejects.toMatchObject({ code: 'timeout' })
    await expect(listFiles(after(255), '/srv/repo', '')).rejects.toMatchObject({ code: 'unreachable' })
  })

  it('passes paths to a remote machine only as positional arguments', async () => {
    const calls: { script: string, args: string[] }[] = []
    const name = 'a;$(touch x).ts'
    const exec: NonNullable<Machine['exec']> = async (script, args = []) => {
      calls.push({ script, args })
      const out = script.includes('rev-parse') ? '/srv/repo\n' : `12\nhello`
      return { code: 0, stdout: Buffer.from(out), stderr: '' }
    }
    expect(await readFilePreview({ exec } as Machine, '/srv/repo', name)).toMatchObject({ kind: 'text', text: 'hello', size: 12 })
    expect(calls.every(c => !c.script.includes(name) && !c.script.includes('/srv/repo'))).toBe(true)
    expect(calls.at(-1)!.args.slice(0, 2)).toEqual(['/srv/repo', name])
  })
})

// Paths written in a conversation, with `base` as the machine's home folder.
describe('files named in a conversation', () => {
  const home = () => ({ exec: null, home: base }) as unknown as Machine

  beforeAll(() => {
    elsewhere = mkdtempSync(path.join(tmpdir(), 'wherdr-elsewhere-'))
    writeFileSync(path.join(elsewhere, 'other.txt'), 'nope\n')
    symlinkSync(path.join(elsewhere, 'other.txt'), path.join(base, 'leaves-home.txt'))
  })

  it('previews a path relative to the agent folder, under ~ or absolute, without its :line', async () => {
    expect(await readWrittenPreview(home(), root, 'README.md:3')).toMatchObject({ kind: 'text', text: '# Hello\n', path: path.join(root, 'README.md') })
    expect(await readWrittenPreview(home(), root, '~/project/src/app.ts')).toMatchObject({ kind: 'text', size: 19 })
    expect(await readWrittenPreview(home(), null, path.join(root, 'with space.txt'))).toMatchObject({ kind: 'text', text: 'a b\n' })
    // Outside the project but in the home folder: still shown.
    expect(await readWrittenPreview(home(), root, '../secret.txt')).toMatchObject({ kind: 'text', text: 'nope\n' })
  })

  it('refuses a path outside the home folder, written or through a symlink', async () => {
    await expect(readWrittenPreview(home(), root, '/etc/hosts')).rejects.toMatchObject({ code: 'outside_home' })
    await expect(readWrittenPreview(home(), root, '../../../x.txt')).rejects.toMatchObject({ code: 'outside_home' })
    await expect(readWrittenPreview(home(), root, '~/leaves-home.txt')).rejects.toMatchObject({ code: 'outside' })
    await expect(readWrittenBytes(home(), root, '~/leaves-home.txt')).rejects.toMatchObject({ code: 'outside' })
    await expect(readWrittenPreview(home(), root, '~/')).rejects.toMatchObject({ code: 'not_file' })
    await expect(readWrittenPreview(home(), root, 'src')).rejects.toMatchObject({ code: 'not_file' })
  })

  it('downloads whole files, binary and past the preview limit', async () => {
    expect(await readWrittenBytes(home(), root, 'blob.bin')).toEqual({ name: 'blob.bin', body: Buffer.from([1, 0, 2, 3]) })
    const min = await readFileBytes(local, root, 'min.js')
    expect(min.name).toBe('min.js')
    expect(min.body.length).toBe(300 * 1024)
  })

  it('refuses a file over the limit without sending its content', async () => {
    // A timeout: a shell that never ends (bash 3.2 after `command exec`) fails here instead of hanging the worker.
    const run = (...args: string[]) => execFileSync('sh', ['-c', READ_SCRIPT, 'sh', root, 'big.txt', ...args], { timeout: 5000 }).toString('utf8')
    expect(run('10', '1')).toBe('300000\n')
    expect(run('10')).toBe('300000\nline\nline\n')
    const calls: string[][] = []
    const exec: NonNullable<Machine['exec']> = async (_script, args = []) => {
      calls.push(args)
      return { code: 0, stdout: Buffer.from(`${DOWNLOAD_BYTES + 1}\n`), stderr: '' }
    }
    await expect(readWrittenBytes({ exec, home: '/home/user' } as Machine, '/home/user/demo', 'dump.sql')).rejects.toMatchObject({ code: 'too_large' })
    expect(calls).toEqual([['/home/user', 'demo/dump.sql', String(DOWNLOAD_BYTES + 1), '1']])
  })

  it('previews a video by its extension and container signature', async () => {
    const mp4 = readFileSync(path.join(root, 'clip.MP4'))
    expect(await readFilePreview(local, root, 'clip.MP4')).toEqual({ path: 'clip.MP4', size: mp4.length, kind: 'video', truncated: false })
    expect(await readFilePreview(local, root, 'clip.webm')).toMatchObject({ kind: 'video' })
    // A .mov that is not one is never handed to the player.
    expect(await readFilePreview(local, root, 'fake.mov')).toMatchObject({ kind: 'binary' })
    expect(isVideo('a.mov', Buffer.from('\0\0\0\x14moov\0\0\0\0', 'latin1'))).toBe(true)
    expect(isVideo('a.webm', mp4)).toBe(false)
    expect(isVideo('a.mkv', mp4)).toBe(false)
  })

  it('names the attachment so that any file name survives', () => {
    expect(attachmentHeader('report.csv')).toBe(`attachment; filename="report.csv"; filename*=UTF-8''report.csv`)
    expect(attachmentHeader('guide.pdf', 'inline')).toBe(`inline; filename="guide.pdf"; filename*=UTF-8''guide.pdf`)
    expect(attachmentHeader('été "v2".csv')).toBe(`attachment; filename="_t_ _v2_.csv"; filename*=UTF-8''%C3%A9t%C3%A9%20%22v2%22.csv`)
  })
})
