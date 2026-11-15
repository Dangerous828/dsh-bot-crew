#!/usr/bin/env node
/**
 * worker 文件读面隔离的固定 helper（#22 补口 / task-5）。
 *
 * 由 `WorkerFileSystem` 起在一个**已隔离**的子进程里（`sandbox-exec` + 同 shell/fs 组的
 * seatbelt profile：写白名单 + `sensitivePaths()` 读 deny）。本进程只做**一件事**：按 stdin
 * 的 JSON 请求对一个绝对路径做一次文件系统观察，把结果当 JSON 打到 stdout。路径不进 argv、
 * 不拼 shell。命中内核拒绝（EPERM/EACCES）就 exit 3、**不输出任何文件内容**；目标不存在
 * exit 4；其它错误 exit 5（stderr 只打错误码，不泄内容）。
 *
 * 是纯 JS `worker-fs-helper.mjs`（不是被 import 的模块，而是被 `node worker-fs-helper.mjs`
 * 直接拉起的可执行脚本）。tsdown 以 `copy` 把它原样拷到 `lib/`，源码期从 `src/executor/` 直接
 * 可跑（vitest / tsx 都不需要编译它）。
 *
 * 支持的 op：
 *   readText      → { op:'text', text }
 *   readBytes     → { op:'base64', base64 }（整读，上限由上层 maxBytes 兜）
 *   readByteRange → { op:'base64', base64 }（带 offset/length）
 *   stat          → { op:'stat', type, size? }
 *   lstat         → { op:'lstat', type, size? }
 *   listDir       → { op:'list', entries:[{name,type}] }
 */
import {
  readFileSync, statSync, lstatSync, readdirSync, openSync, readSync, closeSync, fstatSync,
} from 'node:fs'

const DENIED = 3
const ABSENT = 4
const FAILED = 5

/** 退出并只回错误码，绝不回文件内容。 */
function fail(code, err) {
  const name = err !== null && typeof err === 'object' && 'code' in err ? String(err.code) : 'UNKNOWN'
  process.stderr.write(`worker-fs-helper: ${String(code)} ${name}\n`)
  process.exit(code)
}

/** 读完 stdin 的 JSON 请求。 */
function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

function kindOf(stats, allowSymlink) {
  if (stats.isFile()) return 'file'
  if (stats.isDirectory()) return 'directory'
  if (allowSymlink && stats.isSymbolicLink()) return 'symlink'
  return 'other'
}

async function main() {
  const raw = await readStdin()
  let req
  try {
    req = JSON.parse(raw)
  } catch {
    fail(FAILED, { code: 'BAD_REQUEST' })
  }
  const op = req && req.op
  const path = req && req.path
  if (typeof path !== 'string' || path.length === 0) fail(FAILED, { code: 'BAD_PATH' })

  try {
    switch (op) {
      case 'readText': {
        const buf = readFileSync(path)
        process.stdout.write(JSON.stringify({ op: 'text', text: buf.toString('utf8') }))
        return
      }
      case 'readBytes': {
        const buf = readFileSync(path)
        process.stdout.write(JSON.stringify({ op: 'base64', base64: buf.toString('base64') }))
        return
      }
      case 'readByteRange': {
        const offset = Number(req.offset) >>> 0
        const length = Number(req.length) >>> 0
        const fd = openSync(path, 'r')
        try {
          const got = fstatSync(fd).size
          const n = Math.max(0, Math.min(length, got - offset))
          const buf = Buffer.alloc(n)
          if (n > 0) readSync(fd, buf, 0, n, offset)
          process.stdout.write(JSON.stringify({ op: 'base64', base64: buf.toString('base64') }))
        } finally {
          closeSync(fd)
        }
        return
      }
      case 'stat': {
        const stats = statSync(path)
        process.stdout.write(JSON.stringify({ op: 'stat', type: kindOf(stats, false), size: stats.isFile() ? stats.size : undefined, mtimeMs: stats.mtimeMs }))
        return
      }
      case 'lstat': {
        const stats = lstatSync(path)
        process.stdout.write(JSON.stringify({ op: 'lstat', type: kindOf(stats, true), size: stats.size, mtimeMs: stats.mtimeMs }))
        return
      }
      case 'listDir': {
        const entries = readdirSync(path, { withFileTypes: true }).map((d) => ({
          name: d.name,
          type: d.isFile() ? 'file' : d.isDirectory() ? 'directory' : 'other',
        }))
        process.stdout.write(JSON.stringify({ op: 'list', entries }))
        return
      }
      default:
        fail(FAILED, { code: 'BAD_OP' })
    }
  } catch (err) {
    const code = err !== null && typeof err === 'object' && 'code' in err ? String(err.code) : ''
    if (code === 'ENOENT' || code === 'ENOTDIR') fail(ABSENT, err)
    if (code === 'EPERM' || code === 'EACCES') fail(DENIED, err)
    fail(FAILED, err)
  }
}

void main().catch((err) => fail(FAILED, err))
