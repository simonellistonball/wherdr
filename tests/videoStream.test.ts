import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, truncateSync, utimesSync, writeFileSync, writeSync, closeSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { READ_SCRIPT } from '../server/utils/files'
import type { Machine } from '../server/utils/machines'
import { STREAM_SCRIPT, VIDEO_BLOCK, answer, cutOnError, openVideo, openWrittenVideo, parseRange, readPlan, videoEtag } from '../server/utils/videoStream'

const local = { exec: null } as unknown as Machine
let root = ''
const webm = readFileSync(path.join(__dirname, 'e2e/fixtures/sample.webm'))
// Distinct bytes everywhere, over several dd blocks, behind a WebM header.
const long = Buffer.concat([webm.subarray(0, 12), Buffer.from(Array.from({ length: 3 * VIDEO_BLOCK + 777 }, (_, i) => (i * 7 + (i >> 8)) & 0xFF))])
const BIG = 64 * 1024 ** 3

async function collect(r: NodeJS.ReadableStream) {
  const out: Buffer[] = []
  for await (const c of r as AsyncIterable<Buffer>) out.push(c)
  return Buffer.concat(out)
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'wherdr-video-'))
  writeFileSync(path.join(root, 'clip.webm'), webm)
  writeFileSync(path.join(root, 'long.webm'), long)
  writeFileSync(path.join(root, 'fake.mov'), '<html><script>alert(1)</script>\n')
  // 64 GiB, sparse: reading it all would take minutes, a seek takes nothing.
  writeFileSync(path.join(root, 'huge.webm'), webm.subarray(0, 12))
  truncateSync(path.join(root, 'huge.webm'), BIG)
  appendFileSync(path.join(root, 'huge.webm'), 'END!')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('Range header', () => {
  it('takes the first satisfiable range, alone', () => {
    expect(parseRange('bytes=0-1', 100)).toEqual({ kind: 'part', start: 0, end: 1 })
    expect(parseRange('bytes=10-', 100)).toEqual({ kind: 'part', start: 10, end: 99 })
    expect(parseRange('bytes=90-500', 100)).toEqual({ kind: 'part', start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ kind: 'part', start: 90, end: 99 })
    expect(parseRange('bytes=-500', 100)).toEqual({ kind: 'part', start: 0, end: 99 })
    expect(parseRange('Bytes = 0-10 , 20-30', 100)).toEqual({ kind: 'part', start: 0, end: 10 })
    // A first range past the end does not hide a later valid one.
    expect(parseRange('bytes=1000-1001,0-1', 100)).toEqual({ kind: 'part', start: 0, end: 1 })
    expect(parseRange('bytes=1000-,-5', 100)).toEqual({ kind: 'part', start: 95, end: 99 })
    expect(parseRange('bytes=-0,5-6', 100)).toEqual({ kind: 'part', start: 5, end: 6 })
  })

  it('keeps huge numbers bounded', () => {
    const huge = '9'.repeat(400)
    expect(parseRange(`bytes=0-${huge}`, 100)).toEqual({ kind: 'part', start: 0, end: 99 })
    expect(parseRange(`bytes=-${huge}`, 100)).toEqual({ kind: 'part', start: 0, end: 99 })
    expect(parseRange(`bytes=${huge}-`, 100)).toEqual({ kind: 'none' })
  })

  it('answers 416 only to a valid header with nothing satisfiable', () => {
    expect(parseRange('bytes=100-', 100)).toEqual({ kind: 'none' })
    expect(parseRange('bytes=-0', 100)).toEqual({ kind: 'none' })
    expect(parseRange('bytes=0-1', 0)).toEqual({ kind: 'none' })
  })

  it('ignores a missing, foreign or invalid header: the whole file', () => {
    for (const h of [undefined, 'items=0-1', 'bytes=', 'bytes=-', 'bytes=5-2', 'bytes=0-1junk', 'bytes=0-1.5', 'bytes=0-1,5-2', 'bytes=0-1;x', 'nonsense']) {
      expect(parseRange(h, 100)).toEqual({ kind: 'full' })
    }
  })
})

describe('read plan', () => {
  it('serves the first bytes from the head, the rest from whole dd blocks', () => {
    expect(readPlan(0, 2, 12)).toEqual({ fromHead: 2, skip: 0, count: 0, drop: 0 })
    expect(readPlan(10, 10, 12)).toEqual({ fromHead: 2, skip: 0, count: 1, drop: 0 })
    expect(readPlan(12, 1, 12)).toEqual({ fromHead: 0, skip: 0, count: 1, drop: 0 })
    expect(readPlan(12 + VIDEO_BLOCK * 5 + 3, VIDEO_BLOCK, 12)).toEqual({ fromHead: 0, skip: 5, count: 2, drop: 3 })
    expect(readPlan(0, 5, 3)).toEqual({ fromHead: 3, skip: 0, count: 1, drop: 0 })
  })
})

describe('video stream', () => {
  it('reads any range of the opened file, exactly', async () => {
    for (const [start, len] of [[0, 2], [0, long.length], [5, 20], [11, 2], [12, 1], [VIDEO_BLOCK, 10], [VIDEO_BLOCK - 3, 7], [long.length - 9, 9], [2 * VIDEO_BLOCK + 100, VIDEO_BLOCK + 500]]) {
      const v = await openVideo(local, root, 'long.webm')
      expect(v.size).toBe(long.length)
      expect(Buffer.compare(await collect(v.read(start!, len!)), long.subarray(start!, start! + len!))).toBe(0)
      await v.done
    }
  })

  it('gives an identity that changes with the file', async () => {
    const a = await openVideo(local, root, 'clip.webm')
    a.close()
    expect(a.etag).toMatch(/^(W\/)?"[0-9a-f]{20}"$/)
    expect(a.name).toBe('clip.webm')
    writeFileSync(path.join(root, 'other.webm'), long)
    renameSync(path.join(root, 'other.webm'), path.join(root, 'clip2.webm'))
    const b = await openVideo(local, root, 'clip2.webm')
    b.close()
    expect(b.etag).not.toBe(a.etag)
  })

  // The review's P1: BusyBox's wc -c and tail -c +N read every byte before
  // the one asked. Here a 64 GiB file: only seeks finish in time.
  it('seeks: a two-byte probe and the last bytes of a 64 GiB file come at once', async () => {
    const t = Date.now()
    const probe = await openVideo(local, root, 'huge.webm')
    expect(probe.size).toBe(BIG + 4)
    expect(Buffer.compare(await collect(probe.read(0, 2)), webm.subarray(0, 2))).toBe(0)
    const end = await openVideo(local, root, 'huge.webm')
    expect((await collect(end.read(BIG, 4))).toString()).toBe('END!')
    const preview = await new Promise<string>((resolve) => {
      const c = spawn('sh', ['-c', READ_SCRIPT, 'sh', root, 'huge.webm', '12'])
      let out = ''
      c.stdout.on('data', (b: Buffer) => { out += b.toString('latin1') })
      c.on('close', () => resolve(out))
    })
    expect(preview.split('\n')[0]).toBe(String(BIG + 4))
    expect(Date.now() - t).toBeLessThan(3000)
  })

  it('serves the bytes of the file it opened, never more than its size', async () => {
    writeFileSync(path.join(root, 'grow.webm'), long)
    const grown = await openVideo(local, root, 'grow.webm')
    appendFileSync(path.join(root, 'grow.webm'), Buffer.alloc(5000, 1))
    expect((await collect(grown.read(0, grown.size))).length).toBe(long.length)

    // Shrunk under the reader: an error, never a short body that ends well.
    writeFileSync(path.join(root, 'shrink.webm'), long)
    const shrunk = await openVideo(local, root, 'shrink.webm')
    truncateSync(path.join(root, 'shrink.webm'), 100)
    await expect(collect(shrunk.read(0, shrunk.size))).rejects.toMatchObject({ code: 'truncated' })
    await shrunk.done

    // Replaced by a rename between opening and reading: still the opened file.
    writeFileSync(path.join(root, 'swap.webm'), long)
    const swapped = await openVideo(local, root, 'swap.webm')
    writeFileSync(path.join(root, 'next.webm'), webm)
    renameSync(path.join(root, 'next.webm'), path.join(root, 'swap.webm'))
    expect(Buffer.compare(await collect(swapped.read(0, swapped.size)), long)).toBe(0)
  })

  it('stops reading when the request is dropped', async () => {
    const v = await openVideo(local, root, 'huge.webm')
    const r = v.read(0, 16 * 1024 ** 3)
    for await (const _ of r) break
    const exited = await Promise.race([v.done.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 2000))])
    expect(exited).toBe(true)
    // Closed before any read (HEAD, 416): nothing left running either.
    const head = await openVideo(local, root, 'clip.webm')
    head.close()
    await head.done
  })

  // Its server gone (stdin at EOF) or nothing to read: the script ends by
  // itself. macOS's bash 3.2 once spun at 100% CPU on these `exit`s, forever.
  it('ends on its own when stdin closes or nothing is asked', async () => {
    for (const input of ['', '0 0\n']) {
      const c = spawn('sh', ['-c', STREAM_SCRIPT, 'sh', root, 'long.webm'], { stdio: ['pipe', 'pipe', 'ignore'] })
      c.stdout.resume()
      c.stdin.end(input)
      const code = await Promise.race([
        new Promise(resolve => c.once('close', resolve)),
        new Promise(resolve => setTimeout(() => resolve('running'), 2000)),
      ])
      if (code === 'running') c.kill('SIGKILL')
      expect(code).toBe(0)
    }
  })

  it('refuses a file whose signature is not its extension, and paths outside', async () => {
    await expect(openVideo(local, root, 'fake.mov')).rejects.toMatchObject({ code: 'not_video' })
    await expect(openVideo(local, root, '../x.webm')).rejects.toMatchObject({ code: 'outside' })
    await expect(openVideo(local, root, 'missing.webm')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('streams through the machine’s shell session, refused when offline', async () => {
    const calls: string[][] = []
    const remote = (online: boolean) => ({
      home: root,
      exec: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }),
      spawnShell: (script: string, args: string[]) => {
        calls.push(args)
        return online ? spawn('sh', ['-c', script, 'sh', ...args]) : null
      },
    }) as unknown as Machine
    const v = await openWrittenVideo(remote(true), root, 'long.webm')
    expect(calls.at(-1)).toEqual([path.resolve(root), 'long.webm'])
    expect(Buffer.compare(await collect(v.read(VIDEO_BLOCK, 30)), long.subarray(VIDEO_BLOCK, VIDEO_BLOCK + 30))).toBe(0)
    await expect(openWrittenVideo(remote(false), root, 'long.webm')).rejects.toMatchObject({ code: 'unreachable' })
  })

  it('stops opening when the request closes first', async () => {
    // Already closed: nothing is started.
    const gone = new AbortController()
    gone.abort()
    await expect(openVideo(local, root, 'clip.webm', gone.signal)).rejects.toMatchObject({ code: 'closed' })
    // Closed during a slow SSH opening: the session is killed at once.
    let child: ChildProcess | undefined
    const slow = { home: root, exec: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }), spawnShell: () => (child = spawn('sleep', ['30'])) } as unknown as Machine
    const closing = new AbortController()
    const t = Date.now()
    const opening = openWrittenVideo(slow, root, 'clip.webm', closing.signal)
    setTimeout(() => closing.abort(), 50)
    await expect(opening).rejects.toMatchObject({ code: 'closed' })
    expect(Date.now() - t).toBeLessThan(2000)
    await new Promise(resolve => child!.exitCode !== null || child!.signalCode !== null ? resolve(null) : child!.once('close', resolve))
    expect(child!.signalCode).toBe('SIGKILL')
  })

  it('looks for no Git root once the request is closed', async () => {
    const calls: string[] = []
    const machine = (delay: number) => ({
      home: root,
      exec: (script: string) => { calls.push('exec'); return new Promise(resolve => setTimeout(() => resolve({ code: 0, stdout: Buffer.from(`${root}\n`), stderr: '' }), delay)) },
      spawnShell: () => { calls.push('video'); return null },
    }) as unknown as Machine
    // Already closed: no command at all.
    const gone = new AbortController()
    gone.abort()
    await expect(openVideo(machine(0), root, 'clip.webm', gone.signal)).rejects.toMatchObject({ code: 'closed' })
    expect(calls).toEqual([])
    // Closed during a slow SSH root lookup: the wait ends at once, no video opens afterwards.
    const closing = new AbortController()
    const t = Date.now()
    const opening = openVideo(machine(400), root, 'clip.webm', closing.signal)
    setTimeout(() => closing.abort(), 50)
    await expect(opening).rejects.toMatchObject({ code: 'closed' })
    expect(Date.now() - t).toBeLessThan(300)
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(calls).toEqual(['exec'])
  })

  it('kills a slow local Git root lookup with the request', async () => {
    // A `git` that hangs, first on the PATH.
    const bin = path.join(root, 'slow-bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nsleep 3\n', { mode: 0o755 })
    const saved = process.env.PATH
    process.env.PATH = `${bin}:${saved}`
    try {
      const closing = new AbortController()
      const t = Date.now()
      const opening = openVideo(local, root, 'clip.webm', closing.signal)
      setTimeout(() => closing.abort(), 50)
      await expect(opening).rejects.toMatchObject({ code: 'closed' })
      expect(Date.now() - t).toBeLessThan(1000)
    } finally {
      process.env.PATH = saved
    }
  })
})

describe('versions', () => {
  it('gives a strong ETag only to precise, settled times', () => {
    const base = { now: 1000, ino: '7', size: 10, mtime: 900, version: '2026-10-18 10:00:00.250000000 +0000 2026-10-18 10:00:00.250000000 +0000' }
    expect(videoEtag(base)).toMatch(/^"[0-9a-f]{20}"$/)
    expect(videoEtag({ ...base, version: base.version.replace('.250', '.750') })).not.toBe(videoEtag(base))
    expect(videoEtag({ ...base, version: '1760781600.250000000 1760781600.250000000' })).toMatch(/^"/)
    // Whole seconds only, no descriptor metadata, or written just now: weak.
    expect(videoEtag({ ...base, version: '2026-10-18 10:00:00.000000000 +0000 x' })).toMatch(/^W\//)
    expect(videoEtag({ ...base, version: '' })).toMatch(/^W\//)
    expect(videoEtag({ ...base, now: 901 })).toMatch(/^W\//)
  })

  it('tells apart two versions written in the same second', async () => {
    const file = path.join(root, 'inplace.webm')
    writeFileSync(file, long)
    const second = Math.floor(Date.now() / 1000) - 100
    utimesSync(file, second + 0.25, second + 0.25)
    const before = await openVideo(local, root, 'inplace.webm')
    before.close()
    // Same inode, same size, one byte changed, same second.
    const fd = openSync(file, 'r+')
    writeSync(fd, Buffer.from([0xAB]), 0, 1, 500)
    closeSync(fd)
    utimesSync(file, second + 0.75, second + 0.75)
    const after = await openVideo(local, root, 'inplace.webm')
    after.close()
    expect(after.size).toBe(before.size)
    expect(before.etag).toMatch(/^"/)
    expect(after.etag).toMatch(/^"/)
    expect(after.etag).not.toBe(before.etag)
    // The old version's If-Range gets the whole file again.
    expect(answer(after, { method: 'GET', range: 'bytes=10-20', ifRange: before.etag })).toMatchObject({ status: 200, start: 0, len: after.size })
  })
})

describe('answers', () => {
  const v = { size: 100, etag: '"abc"' }
  it('serves a Range only to GET, and only for the same strong version', () => {
    expect(answer(v, { method: 'GET', range: 'bytes=0-1' })).toEqual({ status: 206, start: 0, len: 2, contentRange: 'bytes 0-1/100' })
    expect(answer(v, { method: 'GET' })).toEqual({ status: 200, start: 0, len: 100 })
    expect(answer(v, { method: 'GET', range: 'bytes=500-' })).toEqual({ status: 416, start: 0, len: 0, contentRange: 'bytes */100' })
    expect(answer(v, { method: 'GET', range: 'bytes=0-1', ifRange: '"abc"' })).toMatchObject({ status: 206 })
    expect(answer(v, { method: 'GET', range: 'bytes=0-1', ifRange: '"old"' })).toMatchObject({ status: 200, len: 100 })
    expect(answer(v, { method: 'GET', range: 'bytes=0-1', ifRange: 'Sat, 18 Oct 2026 10:00:00 GMT' })).toMatchObject({ status: 200 })
    expect(answer({ size: 100, etag: 'W/"abc"' }, { method: 'GET', range: 'bytes=0-1', ifRange: 'W/"abc"' })).toMatchObject({ status: 200 })
    // HEAD ignores Range: the whole file's headers, never 206 nor 416.
    expect(answer(v, { method: 'HEAD', range: 'bytes=0-1' })).toEqual({ status: 200, start: 0, len: 100 })
    expect(answer(v, { method: 'HEAD', range: 'bytes=500-' })).toEqual({ status: 200, start: 0, len: 100 })
  })

  it('cuts the HTTP connection when the file shrinks during a 200 or a 206', async () => {
    for (const range of [undefined, `bytes=10-${long.length - 1}`]) {
      writeFileSync(path.join(root, 'cut.webm'), long)
      const server = http.createServer(async (req, res) => {
        const v = await openVideo(local, root, 'cut.webm')
        const a = answer(v, { method: req.method!, range: req.headers.range })
        truncateSync(path.join(root, 'cut.webm'), 50)
        res.writeHead(a.status, { 'content-length': a.len })
        cutOnError(res, v.read(a.start, a.len)).pipe(res)
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port
      const got = await new Promise<{ status?: number, bytes: number, failed: boolean }>((resolve) => {
        const req = http.get({ port, host: '127.0.0.1', headers: range ? { range } : {}, agent: false }, (res) => {
          let bytes = 0
          res.on('data', (c: Buffer) => { bytes += c.length })
          res.on('end', () => resolve({ status: res.statusCode, bytes, failed: !res.complete }))
          res.on('error', () => resolve({ status: res.statusCode, bytes, failed: true }))
        })
        req.on('error', () => resolve({ bytes: 0, failed: true }))
      })
      server.close()
      expect(got.status).toBe(range ? 206 : 200)
      expect(got.failed).toBe(true)
      expect(got.bytes).toBeLessThan(long.length - 10)
    }
  })
})
