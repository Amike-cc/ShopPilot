import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 打包期回归守卫：主进程 / preload 的本地模块会被 electron-vite(rollup) 内联进
 * 单个 index.js，产物里**不存在** `./agent-memory.js` 这类文件。因此
 * `require('./agent-memory')` 在开发态可能侥幸可用，打包后必然 MODULE_NOT_FOUND
 * ——记忆治理复盘和 Job 反馈都踩过这个坑（真机 CDP 验收暴露）。
 *
 * 需要延迟加载时一律用 `await import('./x')`（rollup 会内联成 promise），
 * 只有 node_modules 依赖可以用 require。
 */
const BUNDLED_ROOTS = ['apps/desktop/src/main', 'apps/desktop/src/preload']
const RELATIVE_REQUIRE_RE = /\brequire\(\s*['"`]\.{1,2}\//

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full))
    else if (/\.(ts|js|mts|cts)$/.test(entry)) found.push(full)
  }
  return found
}

describe('打包产物安全：主进程不得相对 require 本地模块', () => {
  it('main / preload 源码里没有 require("./…") 或 require("../…")', () => {
    const offenders: string[] = []
    for (const root of BUNDLED_ROOTS) {
      for (const file of sourceFiles(root)) {
        const source = readFileSync(file, 'utf8')
        source.split(/\r?\n/).forEach((line, index) => {
          if (RELATIVE_REQUIRE_RE.test(line)) offenders.push(`${relative(process.cwd(), file)}:${index + 1} ${line.trim().slice(0, 120)}`)
        })
      }
    }
    expect(offenders).toEqual([])
  })
})
