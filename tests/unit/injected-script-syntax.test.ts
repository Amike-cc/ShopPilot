import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * 注入页面的脚本片段必须能在页面里当 JS 解析。
 *
 * 为什么单列一条：task-runner 里大量脚本是**模板字面量**，`${...}` 会被外层模板吃掉——
 * 我曾在脚本内部写模板字面量（`` `矩形 ${r.left}` ``），TS 直接把整段判成语法错误，
 * 而这类错误只有构建/类型检查才暴露，运行时表现是"点击步骤报各种怪错"。
 * 这里把关键片段抽出来做一次语法自检。
 */
const SRC = fs.readFileSync(path.join(__dirname, '../../apps/desktop/src/main/tasks/task-runner.ts'), 'utf8')

describe('注入脚本的语法自检', () => {
  it('task-runner 源码里的注入片段不含"嵌套模板字面量"这类会被外层吃掉的写法', () => {
    // 抽 findTextTarget 里"离屏判定"那一段，检查它只用字符串拼接。
    // 要防的是在脚本字符串**内部**写反引号模板——那会被外层模板先吃掉，直接语法错。
    const start = SRC.lastIndexOf('const outsideViewport')
    expect(start).toBeGreaterThan(0)
    const snippet = SRC.slice(start, start + 500)
    expect(snippet).toContain('OUT_OF_VIEWPORT')
    expect(snippet).not.toContain('`')
  })

  it('视口外判定用的是"矩形与视口无交集"，而不是"被遮挡"', () => {
    expect(SRC).toContain('TASK_TARGET_OUT_OF_VIEWPORT')
    // 这两个错误码必须分开（处置不同：一个是页面被节流/弹层没开，一个是布局重叠）
    expect(SRC).toContain('sawOutsideBy')
    expect(SRC).toContain('sawCoveredBy')
  })

  it('店铺标签页必须关闭后台节流（否则遮挡时 rAF 停摆，平台弹层会停在屏幕外）', () => {
    expect(SRC.length).toBeGreaterThan(0)
    const wm = fs.readFileSync(path.join(__dirname, '../../apps/desktop/src/main/browser/window-manager.ts'), 'utf8')
    // WebContentsView 与独立窗口两处都要关
    const hits = wm.split('backgroundThrottling: false').length - 1
    expect(hits).toBeGreaterThanOrEqual(2)
  })
})
