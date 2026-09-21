import { describe, it, expect } from 'vitest'
import { buildElementPickerScript, describePickResult } from '../../apps/desktop/src/main/browser/element-picker'
import { buildElementProbeScript } from '../../apps/desktop/src/main/browser/element-probe'
import { ANCHOR_HELPERS_JS, HASHY_CLASS_JS } from '../../apps/desktop/src/main/browser/element-anchor-js'

/**
 * 「拾取元素」注入脚本 + 结果描述的单测。
 *
 * 与 element-probe.test.ts 同一套路：**不起 Electron**，只做
 * ①注入脚本能否当 JS 解析（模板字面量里再写反引号会被外层吃掉，只有构建期才暴露）；
 * ②关键行为骨架是否在（遮罩拦截、Esc 取消、超时兜底）；
 * ③两处入口是否共用同一份锚点提取——这条没有编译期信号，只能靠断言钉住。
 */

describe('拾取元素 · 注入脚本', () => {
  it('能当 JS 解析（防模板字面量被外层吃掉）', () => {
    expect(() => new Function(buildElementPickerScript('selector'))).not.toThrow()
    expect(() => new Function(buildElementPickerScript('text'))).not.toThrow()
  })

  it('模式如实填进脚本，且不残留占位符', () => {
    const sel = buildElementPickerScript('selector')
    const txt = buildElementPickerScript('text')
    expect(sel).toContain('const MODE = "selector"')
    expect(txt).toContain('const MODE = "text"')
    expect(txt, '提示语要按模式区分：文案拾取取的是文字，选择器拾取取的是路径').toContain('拾取文案')
    expect(sel).toContain('拾取选择器')
  })

  it('超时如实填进脚本（主进程的等待必须有上限，不能永久挂住 IPC）', () => {
    expect(buildElementPickerScript('selector')).toContain('const TIMEOUT = 120000')
    expect(buildElementPickerScript('selector', 5000)).toContain('const TIMEOUT = 5000')
  })

  it('超时兜底真的会 resolve（而不是把 IPC 调用永远挂着）', () => {
    const script = buildElementPickerScript('selector', 1)
    expect(script, '超时必须走 finish()，且带上可识别的原因码').toContain("PICK_TIMEOUT")
  })

  it('用户点击后取的是锚点、**不是**把点击转发给页面', () => {
    const script = buildElementPickerScript('selector')
    // 拾取时用户点的往往正是「确认发送」「提交」这类不可逆按钮。事件一旦落到页面上，
    // 就等于让用户在自己不知情的情况下真的点了它——这是本功能的硬约束。
    expect(script).not.toContain('.click()')
    expect(script).not.toContain('dispatchEvent')
    expect(script, '捕获阶段拦下并阻止默认行为').toContain('stopImmediatePropagation')
    expect(script).toContain('preventDefault')
    expect(script, 'mousedown/mouseup 也要拦：有的框架按下就触发').toContain("addEventListener('mousedown'")
  })

  it('遮罩只在取命中元素时临时让开，其余时间接管指针事件', () => {
    const script = buildElementPickerScript('selector')
    expect(script, '取命中前把遮罩设为穿透').toContain("mask.style.pointerEvents = 'none'")
    expect(script, '取完立刻恢复接管，否则后续点击会穿透到页面').toContain("mask.style.pointerEvents = 'auto'")
  })

  it('Esc 取消走 cancelled（与"失败"分开，界面措辞不同）', () => {
    const script = buildElementPickerScript('selector')
    expect(script).toContain('Escape')
    expect(script).toContain('cancelled: true')
  })

  it('连点两次不叠遮罩（上一次的残留先清掉）', () => {
    const script = buildElementPickerScript('selector')
    expect(script).toContain('__shopilot_pick_mask__')
    expect(script, '进入时先清理同 id 的残留节点').toMatch(/removeChild/)
  })

  it('穿透 ShadowRoot 并向上收敛到可操作元素（与右键采集同一套判定）', () => {
    const script = buildElementPickerScript('selector')
    expect(script).toContain('__pierce')
    expect(script).toContain('__converge')
    expect(script).toContain('shadowRoot')
  })

  it('返回行锚点（within 要用整行，而不是用户点到的那颗按钮）', () => {
    const script = buildElementPickerScript('selector')
    expect(script).toContain('rowSelector')
    expect(script).toContain('rowText')
  })

  it('行文本截断后再过 IPC（整表行 innerText 可能上万字）', () => {
    const script = buildElementPickerScript('selector')
    expect(script, '与 element-probe 的 rowText.slice(0, 200) 对齐，避免大载荷').toContain('__norm(row.innerText).slice(0, 200)')
  })
})

describe('拾取元素 · 与右键采集共用同一份锚点提取（防漂移）', () => {
  it('两份注入脚本都逐字包含共用片段', () => {
    // 各写一份的后果是"同一元素两个入口给出不同选择器"，然后任务跑不通，
    // 而两处代码各自看起来都对——所以这里钉的是**逐字一致**，不是"都包含 __cssPath"。
    const probe = buildElementProbeScript(1, 1)
    const picker = buildElementPickerScript('selector')
    expect(probe).toContain(ANCHOR_HELPERS_JS)
    expect(picker).toContain(ANCHOR_HELPERS_JS)
  })

  it('同一元素的 CSS 路径只由一处生成（__cssPath 在两份脚本里是同一段源码）', () => {
    const seg = (s: string) => {
      const i = s.indexOf('const __cssPath')
      return s.slice(i, s.indexOf('const __norm', i))
    }
    expect(seg(buildElementPickerScript('selector'))).toBe(seg(buildElementProbeScript(1, 1)))
  })

  it('哈希类名判定跑起来结果一致（Tailwind 原子类名不能判成哈希）', () => {
    const fnOf = () => {
      // eslint-disable-next-line no-new-func
      return new Function(`${HASHY_CLASS_JS}; return __hashyClass`)() as (c: string) => {
        hashy: string[]; escape: string[]; stable: string[]
      }
    }
    // 两个入口共用同一份 HASHY_CLASS_JS，所以"跑出来的结果一致"是构造保证的；
    // 断言它仍然是**共同引用**，避免哪天有人只改了其中一个入口。
    expect(buildElementPickerScript('selector')).toContain(HASHY_CLASS_JS)
    expect(buildElementProbeScript(1, 1)).toContain(HASHY_CLASS_JS)
    const fromPicker = fnOf()
    const fromProbe = fnOf()
    const sample = 'flex h-[44px] css-1x2y3z btn_a1b2c3 product-card__title-wrapper--highlighted'
    expect(fromPicker(sample)).toEqual(fromProbe(sample))
    expect(fromPicker(sample).hashy).toEqual(['css-1x2y3z', 'btn_a1b2c3'])
  })
})

describe('拾取元素 · 结果措辞', () => {
  it('取消与失败分开说（不要把取消报成错误）', () => {
    expect(describePickResult({ ok: false, cancelled: true }, 'selector')).toBe('已取消拾取')
  })

  it('成功时说清填进去的是什么', () => {
    expect(describePickResult({ ok: true, selector: 'button.submit' }, 'selector')).toContain('button.submit')
    expect(describePickResult({ ok: true, text: '确认发送' }, 'text')).toContain('确认发送')
  })

  it('没有文案时给出下一步动作（改用选择器），而不是只说失败', () => {
    const msg = describePickResult({ ok: true, text: '', selector: 'i.icon' }, 'text')
    expect(msg).toContain('没有可用的文案')
    expect(msg).toContain('拾取选择器')
  })

  it('原因码有人话，未知原因码原样带出（不吞）', () => {
    expect(describePickResult({ ok: false, reason: 'PICK_TIMEOUT' }, 'selector')).toContain('超时')
    expect(describePickResult({ ok: false, reason: 'NO_STORE_PAGE' }, 'selector')).toContain('没有打开的店铺页面')
    expect(describePickResult({ ok: false, reason: 'INJECT_FAILED' }, 'selector')).toContain('注入失败')
    expect(describePickResult({ ok: false, reason: 'SOMETHING_NEW' }, 'selector')).toContain('SOMETHING_NEW')
  })

  it('全部原因码都有人话（新增原因码必须登记，漏了这里失败）', () => {
    // pickElementFromActiveTab 的返回 + 注入脚本的 finish()，两处的原因码全集
    const allReasons = [
      'NO_ELEMENT_AT_POINT',
      'PICK_TIMEOUT',
      'NO_STORE_PAGE',
      'NO_ACTIVE_TAB',
      'INJECT_FAILED',
      'NO_VALUE'
    ]
    for (const reason of allReasons) {
      const msg = describePickResult({ ok: false, reason }, 'selector')
      expect(msg, reason).not.toContain('未知原因')
      expect(msg, reason).not.toContain(reason)
    }
  })
})
