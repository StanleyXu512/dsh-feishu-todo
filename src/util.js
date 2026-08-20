'use strict'

/**
 * 通用工具函数（零依赖）。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 并发受限地跑异步任务（Promise.all 的有序 + 限流版本）。
 * 一旦某个任务抛错，则不再调度新任务并最终抛出该错误（fail-fast）。
 * 若希望单个任务失败不影响整体，请在 fn 内部自行 try/catch。
 */
export async function mapLimit(items, limit, fn) {
  const arr = Array.isArray(items) ? items : Array.from(items)
  const n = Math.max(1, Math.min(Number(limit) || 1, arr.length))
  let next = 0
  let firstError = null
  async function worker() {
    while (true) {
      const i = next++
      if (i >= arr.length || firstError) return
      try {
        await fn(arr[i], i)
      } catch (e) {
        if (!firstError) firstError = e
      }
    }
  }
  const workers = []
  for (let w = 0; w < n; w++) workers.push(worker())
  await Promise.all(workers)
  if (firstError) throw firstError
}

export function nowMs() {
  return Date.now()
}

export function nowSec() {
  return Math.floor(Date.now() / 1000)
}

/** 秒级时间戳 -> 'YYYY-MM-DD HH:mm' */
export function formatTime(sec) {
  const d = new Date(sec * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 毫秒时间戳 -> 'MM-DD HH:mm'（跨年补年份 'YYYY-MM-DD HH:mm'） */
export function formatClock(ms) {
  const d = new Date(Number(ms))
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  if (d.getFullYear() !== new Date().getFullYear()) return `${d.getFullYear()}-${md} ${hm}`
  return `${md} ${hm}`
}

/** 相对时间描述：'3 分钟前' / '2 小时前' / '5 天前' */
export function relativeTime(ms) {
  const diff = Math.max(0, Date.now() - Number(ms))
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/** 生成随机十六进制字符串（state 等） */
export function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex')
}

/** 生成 PKCE code_verifier（43~128 位，字符集符合 RFC 7636） */
export function generateCodeVerifier() {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const bytes = crypto.randomBytes(64)
  let out = ''
  for (const b of bytes) out += charset[b % charset.length]
  return out
}

/** S256: verifier -> code_challenge */
export function codeChallengeS256(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

/** 掩码敏感信息：只保留前 4 / 后 4 位 */
export function maskSecret(value) {
  if (!value) return '(未设置)'
  const s = String(value)
  if (s.length <= 8) return '****'
  return `${s.slice(0, 4)}****${s.slice(-4)}`
}

/** 在用户主目录之外寻找可写配置目录时的兜底（保留给未来扩展，暂未使用） */
export function defaultDataDir() {
  return path.join(os.homedir(), '.dsh')
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** 尝试打开系统浏览器（macOS / Linux / Windows） */
export function openBrowser(url) {
  const platform = process.platform
  let cmd
  let args
  if (platform === 'darwin') {
    cmd = 'open'
    args = [url]
  } else if (platform === 'win32') {
    cmd = 'cmd'
    args = ['/c', 'start', '', url]
  } else {
    cmd = 'xdg-open'
    args = [url]
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.unref()
    return true
  } catch {
    return false
  }
}

/** 从数组中取最近 N 个去重后的值（按顺序保留首个出现） */
export function dedupeById(items, idFn = (x) => x) {
  const seen = new Set()
  const out = []
  for (const it of items) {
    const id = idFn(it)
    if (id == null || seen.has(id)) continue
    seen.add(id)
    out.push(it)
  }
  return out
}

/** 把长字符串按长度切块，避免破坏行（用于 LLM 上下文分片） */
export function chunkLines(lines, maxChars = 6000) {
  const chunks = []
  let cur = []
  let curLen = 0
  for (const line of lines) {
    if (curLen + line.length + 1 > maxChars && cur.length > 0) {
      chunks.push(cur)
      cur = []
      curLen = 0
    }
    cur.push(line)
    curLen += line.length + 1
  }
  if (cur.length > 0) chunks.push(cur)
  return chunks
}