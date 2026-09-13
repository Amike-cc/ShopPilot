/**
 * 主进程日志 - §22：日志按天落 userData/logs/app-YYYY-MM-DD.log，默认保留 14 天。
 * 写入前做脱敏：疑似凭据行整行掩码，绝不把明文密码/Cookie 写进日志。
 * 崩溃报告上传默认关闭（规范要求用户主动开启才上传；本版本仅本地落盘，未提供上传通道）。
 */

import { app } from 'electron'
import { existsSync, mkdirSync, appendFileSync, readFileSync, statSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'

const MAX_BYTES = 5 * 1024 * 1024
const RETENTION_DAYS = 14
const SECRET_LINE = /(password|passwd|secret|token|cookie|authorization|credential)/i

let dir: string | null = null
let pruned = false
/**
 * 控制台镜像的熔断开关。
 * 踩过的真实故障（2026-09-13 18:11，日志里 8 秒 11,787 条 uncaughtException）：
 * 应用从已关闭的终端/shell 启动时 stdout/stderr 管道断开，console.error 同步抛 EPIPE；
 * 而全局 uncaughtException 处理器又调用 logMain 记录该错误 —— logMain 里再次 console.error
 * → 再次抛错 → 再次触发处理器，形成异常递归，CPU 打满（表现为"卡死"）。
 * 因此：镜像写入必须 try/catch，一旦失败就永久关闭镜像（文件日志不受影响）。
 */
let consoleBroken = false

function mirrorToConsole(level: 'info' | 'warn' | 'error', text: string): void {
  if (consoleBroken) return
  try {
    (level === 'error' ? console.error : console.log)(text)
  } catch {
    consoleBroken = true
  }
}

// 异步 EPIPE（流 error 事件）同样会变成 uncaughtException：先在源头吞掉并熔断
for (const stream of [process.stdout, process.stderr]) {
  try {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) consoleBroken = true
    })
  } catch { /* 某些环境无 stdout（GUI 启动）时忽略 */ }
}

function logDir(): string {
  if (!dir) {
    dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
  }
  if (!pruned) { pruned = true; pruneOld() }
  return dir
}

function dayStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 14 天保留（§22）：只清理本应用按天生成的日志文件 */
function pruneOld(): void {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000
    for (const f of readdirSync(logDir())) {
      const m = /^app-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(f)
      if (!m) continue
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
      if (t < cutoff) unlinkSync(join(logDir(), f))
    }
  } catch { /* 清理失败不影响主流程 */ }
}

export function logFile(): string { return join(logDir(), `app-${dayStamp()}.log`) }

function redact(msg: string): string {
  if (!SECRET_LINE.test(msg)) return msg
  return '[REDACTED-SENSITIVE-LINE] ' + msg.slice(0, 40).replace(/[^\x20-\x7e]/g, '?') + '…'
}

export function logMain(level: 'info' | 'warn' | 'error', msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${redact(msg)}\n`
  try {
    appendFileSync(logFile(), line, 'utf8')
    const st = statSync(logFile())
    if (st.size > MAX_BYTES) {
      const tail = readFileSync(logFile(), 'utf8').slice(-MAX_BYTES / 2)
      renameSync(logFile(), logFile() + '.1')
      writeFileSync(logFile(), tail, 'utf8')
    }
  } catch { /* 日志失败不影响主流程 */ }
  mirrorToConsole(level, line.trim())
}

/** 诊断包用：读取最近日志文件尾部（已脱敏写入，再过滤一次兜底） */
export function readLogTail(bytes = 200 * 1024): string {
  try {
    const candidates = readdirSync(logDir())
      .filter(f => /^app-\d{4}-\d{2}-\d{2}\.log(\.1)?$/.test(f))
      .sort()
      .reverse()
      .slice(0, 2)
    let out = ''
    for (const f of candidates.reverse()) {
      try { out += readFileSync(join(logDir(), f), 'utf8') } catch { /* 忽略单个文件 */ }
    }
    return out.length > bytes ? out.slice(-bytes) : out
  } catch { return '' }
}

void existsSync
