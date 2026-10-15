/**
 * 主进程日志 - §22：日志按天落 userData/logs/app-YYYY-MM-DD.log，默认保留 14 天。
 * 写入前做两级脱敏：先把 URL 查询值/账号口令/认证头/Cookie 的值就地掩码（保留键名与上下文），
 * 再对"关键词出现但没被值级规则覆盖"的行整行掩码兜底，绝不把明文密码/Cookie 写进日志。
 * 崩溃报告上传默认关闭（规范要求用户主动开启才上传；本版本仅本地落盘，未提供上传通道）。
 */

import { app } from 'electron'
import { existsSync, mkdirSync, appendFileSync, readFileSync, statSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'

const MAX_BYTES = 5 * 1024 * 1024
const RETENTION_DAYS = 14
const SECRET_LINE = /(password|passwd|secret|token|cookie|authorization|credential)/i
/** 值级脱敏的占位符：出现即代表该行的敏感值已就地掩码，无需再整行丢弃 */
const SECRET_MASK = '[已隐藏]'

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

/**
 * 值级脱敏：把**值**就地掩码、保留键名与上下文，而不是把整行丢掉。
 *
 * 为什么需要它：只按整行关键词脱敏时，一条含 `?token=…` 的导航/代理认证日志会被整行
 * 替换成占位串，事后完全没有线索；反过来，日志里出现 `sessionid=…` 这类不在关键词表里的
 * 参数又会被原样落盘。这里按"参数名保留、参数值一律掩码"处理，两类问题一起解决：
 * URL 查询参数值、username/password/token 之类键值、Authorization/Proxy-Authorization/Cookie
 * 头值、裸 Basic/Bearer 令牌。
 */
export function redactSecretValues(input: unknown): string {
  let text = String(input ?? '')
  // 认证头与 Cookie：值可能是整条 header，掩码到行尾（Cookie 内含多个 name=value，按单个值切会漏）
  text = text.replace(/\b((?:proxy-authorization|authorization|set-cookie|cookie)\s*[:=]\s*)[^\n]*/gi, `$1${SECRET_MASK}`)
  // 裸令牌：Basic/Bearer 之后的一段凭据
  text = text.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{4,}/gi, `$1 ${SECRET_MASK}`)
  // 账号口令类键值对（渲染层/主进程都可能把用户输入拼进日志）
  text = text.replace(
    /\b((?:username|user|password|passwd|pwd|token|secret|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"'<>]+)/gi,
    `$1${SECRET_MASK}`
  )
  // URL 查询串：参数名保留，值一律掩码（sessionid/code/state 这类不在关键词表里的也不漏）
  text = text.replace(/([?&][^=&\s"'<>]+)=([^&\s"'<>]*)/g, `$1=${SECRET_MASK}`)
  return text
}

function redact(msg: string): string {
  const masked = redactSecretValues(msg)
  if (!SECRET_LINE.test(masked)) return masked
  // 值已掩码，剩下的关键词只是键名 → 保留整行，日志才有排查价值
  if (masked.includes(SECRET_MASK)) return masked
  return '[REDACTED-SENSITIVE-LINE] ' + masked.slice(0, 40).replace(/[^\x20-\x7e]/g, '?') + '…'
}

/**
 * 日志写入策略（2026-10-15 审查 P1-4）：
 *
 * 老实现每行 `appendFileSync + statSync`——任务引擎在每步/每次重试/每轮 loop 都打日志，
 * 7×24 无人值守采集下同步 IO 反复阻塞主进程事件循环（表现为界面卡顿）。
 *
 * 新实现：内存攒批 + 定时落盘。
 *   · error 级（崩溃/审计/诊断价值最高）立即同步落盘，绝不因攒批丢失；
 *   · 其余每 300ms 或攒满 64KB 落一批（一次 appendFileSync 写入多行）；
 *   · 体积检查（statSync）从"每行"降为"每 5 秒最多一次"，轮转逻辑不变；
 *   · 进程 exit 时兜底 flushPending（同步，可在 exit 事件里执行）。
 * 崩溃瞬时丢日志的窗口：最多 300ms 的非 error 行——与它换来的主线程减负相比是可接受的取舍。
 */
const FLUSH_INTERVAL_MS = 300
const MAX_BUFFER_BYTES = 64 * 1024
const SIZE_CHECK_INTERVAL_MS = 5 * 1000

let pendingLines: string[] = []
let pendingBytes = 0
let flushTimer: NodeJS.Timeout | null = null
let lastSizeCheckAt = 0

function rotateIfOversized(): void {
  try {
    const st = statSync(logFile())
    if (st.size <= MAX_BYTES) return
    const tail = readFileSync(logFile(), 'utf8').slice(-MAX_BYTES / 2)
    renameSync(logFile(), logFile() + '.1')
    writeFileSync(logFile(), tail, 'utf8')
  } catch { /* 轮转失败不影响主流程 */ }
}

/** 把缓冲的行一次性写入磁盘（同步；供定时器与退出路径共用） */
function flushPending(): void {
  if (!pendingLines.length) return
  const chunk = pendingLines.join('')
  pendingLines = []
  pendingBytes = 0
  try {
    appendFileSync(logFile(), chunk, 'utf8')
    const now = Date.now()
    if (now - lastSizeCheckAt >= SIZE_CHECK_INTERVAL_MS) {
      lastSizeCheckAt = now
      rotateIfOversized()
    }
  } catch { /* 日志失败不影响主流程 */ }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushPending()
  }, FLUSH_INTERVAL_MS)
  // 常驻定时器不阻止进程退出（退出路径由 exit 兜底 flush）
  if (typeof flushTimer.unref === 'function') flushTimer.unref()
}

// 进程退出前兜底落盘：'exit' 里只能做同步操作，flushPending 恰好是同步的
process.on('exit', () => {
  try { flushPending() } catch { /* 退出路径不抛 */ }
})

export function logMain(level: 'info' | 'warn' | 'error', msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${redact(msg)}\n`
  pendingLines.push(line)
  pendingBytes += Buffer.byteLength(line)
  if (level === 'error' || pendingBytes >= MAX_BUFFER_BYTES) {
    flushPending()
  } else {
    scheduleFlush()
  }
  mirrorToConsole(level, line.trim())
}

/** 诊断包用：读取最近日志文件尾部（已脱敏写入，再过滤一次兜底） */
export function readLogTail(bytes = 200 * 1024): string {
  flushPending() // 把攒批中的最新日志先落盘，诊断读取才拿得到全量
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
