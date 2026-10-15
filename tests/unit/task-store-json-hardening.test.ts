import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * B6（2026-10-15 全库审查）回归：JSON 降级解析。
 *
 * 背景：task-store 的若干 JSON 列（schedule / 步骤结果 payload / 快照 value）是应用自己写的，
 * 但一旦损坏（磁盘、半写、手改），裸 `JSON.parse` 会把**整表读取**（任务列表 / 快照列表）
 * 连坐拖垮——而同一文件里另两处早已做了降级（listScheduleCandidates 的 schedule）。
 *
 * 修复：统一 safeJson；**执行参数 input_json 刻意不降级**（宁可 fail-closed 报错，
 * 也不能静默换成 {} 去跑一个语义不明的步骤）。
 */

const read = (p: string) => readFileSync(resolve(p), 'utf8')
const STORE = read('apps/desktop/src/main/tasks/task-store.ts')

describe('B6 task-store JSON 降级解析', () => {
  it('提供统一 safeJson 帮助函数', () => {
    expect(STORE).toContain('function safeJson<T>(raw: string | null | undefined, fallback: T): T')
  })

  it('展示/元数据类字段全部走 safeJson（schedule / payload / 快照 value）', () => {
    expect(STORE).toContain('schedule: safeJson(row.schedule_json, null)')
    expect(STORE).toContain('const payload = safeJson(r.payload_json, null)')
    expect(STORE).toContain('value: safeJson(r.value_json, null)')
  })

  it('执行参数 input_json 保持 fail-closed（不降级，坏数据必须报错而不是静默 {}）', () => {
    expect(STORE).toMatch(/input: JSON\.parse\(r\.input_json \|\| '\{\}'\)/)
    expect(STORE).toContain('步骤输入（input_json）刻意不降级')
  })
})
