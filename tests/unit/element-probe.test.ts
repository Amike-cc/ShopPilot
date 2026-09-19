import { describe, it, expect } from 'vitest'
import {
  buildElementProbeScript,
  formatElementProbe,
  type ElementProbeResult
} from '../../apps/desktop/src/main/browser/element-probe'

/**
 * 「元素定位信息」采集的单测。
 *
 * 这里**不起 Electron**：注入脚本只做"能否当 JS 解析"的语法自检（理由见
 * injected-script-syntax.test.ts —— 注入脚本是模板字面量，内部再写反引号会被外层吃掉，
 * 只有构建期才暴露），格式化逻辑则是纯函数，直接喂结构断言。
 */

function makeResult(over: Partial<ElementProbeResult> = {}): ElementProbeResult {
  return {
    ok: true,
    tag: 'button',
    textAnchor: '批量邀约',
    ownText: '批量邀约',
    innerText: '批量邀约',
    attrs: {},
    cssPath: 'div > button',
    className: '',
    hashyClasses: [],
    stableClasses: [],
    rect: { x: 10, y: 20, w: 100, h: 32 },
    rowSelector: '',
    rowText: '',
    inShadowRoot: false,
    url: 'https://example.com/square',
    ...over
  }
}

describe('元素定位信息 · 注入脚本', () => {
  it('能当 JS 解析（防模板字面量被外层吃掉）', () => {
    const script = buildElementProbeScript(100, 200)
    // eslint-disable-next-line no-new-func
    expect(() => new Function(script)).not.toThrow()
  })

  it('坐标如实填进脚本，且不残留占位符', () => {
    const script = buildElementProbeScript(321, 654)
    expect(script).toContain('const px = 321')
    expect(script).toContain('py = 654')
    expect(script, '占位符没被替换会直接语法错').not.toContain('__PROBE_X__')
    expect(script).not.toContain('__PROBE_Y__')
  })

  it('坐标取整（页面 elementFromPoint 吃小数没问题，但取整让脚本可读、也避免浮点尾巴）', () => {
    const script = buildElementProbeScript(10.7, 20.2)
    expect(script).toContain('const px = 11')
    expect(script).toContain('py = 20')
  })

  it('脚本只读不写页面内容：除高亮遮罩外不出现点击/输入类调用', () => {
    const script = buildElementProbeScript(1, 1)
    // 高亮遮罩是允许的（会自行移除），但绝不能有 .click() / 派发事件这类会改变平台状态的动作
    expect(script).not.toContain('.click()')
    expect(script).not.toContain('dispatchEvent')
    expect(script, '高亮必须自动移除，不能常驻污染页面').toContain('setTimeout')
  })

  it('脚本穿透 ShadowRoot（微信小店页面在 micro-app 的 ShadowRoot 里）', () => {
    const script = buildElementProbeScript(1, 1)
    expect(script).toContain('shadowRoot')
  })

  it('脚本内嵌的哈希判定把 Tailwind 原子类名与真哈希分开（真机误报的根因）', () => {
    // 直接把脚本里的判定函数抠出来跑一遍——格式化层的用例证明不了判定本身对不对，
    // 而误报的根因在**判定规则**里（真机实测：h-[44px] 被判成哈希）。
    const script = buildElementProbeScript(1, 1)
    const fnSrc = script.slice(script.indexOf('const __hashyClass'), script.indexOf('const OUTLINE_ID'))
    // eslint-disable-next-line no-new-func
    const __hashyClass = new Function(`${fnSrc}; return __hashyClass`)() as (c: string) => {
      hashy: string[]; escape: string[]; stable: string[]
    }

    const tailwind = __hashyClass('flex items-center justify-start h-[44px] pl-[28px] cursor-pointer')
    expect(tailwind.hashy, 'Tailwind 原子类名不该被判成哈希').toEqual([])
    expect(tailwind.escape).toContain('h-[44px]')
    expect(tailwind.stable).toContain('flex')

    const cssInJs = __hashyClass('btn css-1x2y3z')
    expect(cssInJs.hashy, 'css-in-js 哈希必须认出来').toContain('css-1x2y3z')
    expect(cssInJs.stable).toContain('btn')

    const modules = __hashyClass('btn_a1b2c3')
    expect(modules.hashy, 'CSS Modules 形态必须认出来').toContain('btn_a1b2c3')

    // 含数字但语义明确的类名不能被误伤（text-2xl / col-md-6 / mt-4）
    const semantic = __hashyClass('text-2xl col-md-6 mt-4')
    expect(semantic.hashy, 'text-2xl / col-md-6 / mt-4 都是语义类名').toEqual([])
    expect(semantic.escape, '这些不需要转义').toEqual([])

    // 超长随机串仍要认出来（长度是哈希的可靠特征）
    expect(__hashyClass('aBcDeFgHiJkLmNoPqRsTuVw').hashy.length, '超长串应判为哈希').toBe(1)
    // 但长而语义可读的类名不该误伤（BEM 命名常很长）
    expect(__hashyClass('product-card__title-wrapper--highlighted').hashy, 'BEM 长类名不该判成哈希').toEqual([])
  })
})

describe('元素定位信息 · 格式化输出', () => {
  it('三层锚点都给出，且文案层排在最前（最稳的优先）', () => {
    const text = formatElementProbe(makeResult({
      attrs: { 'data-test': 'batch-invite' },
      cssPath: 'div > button.btn',
      stableClasses: ['btn']
    }))
    const iText = text.indexOf('文案锚点')
    const iAttr = text.indexOf('稳定属性')
    const iCss = text.indexOf('CSS 路径')
    expect(iText).toBeGreaterThan(-1)
    expect(iAttr).toBeGreaterThan(-1)
    expect(iCss).toBeGreaterThan(-1)
    expect(iText, '文案锚点应排在稳定属性之前').toBeLessThan(iAttr)
    expect(iAttr, '稳定属性应排在 CSS 路径之前').toBeLessThan(iCss)
  })

  it('给出可直接抄进档案的写法', () => {
    const text = formatElementProbe(makeResult({
      attrs: { 'data-test': 'batch-invite', name: 'inviteBtn' }
    }))
    expect(text, '文案层应给出 clickByText 写法').toContain('clickByText')
    expect(text, '属性层应给出 waitForSelector 写法').toContain('waitForSelector')
    expect(text).toContain('data-test')
  })

  it('疑似构建哈希的类名被显式警告（写死等于埋雷）', () => {
    const text = formatElementProbe(makeResult({
      hashyClasses: ['css-1x2y3z', 'btn_a1b2c3'],
      stableClasses: ['btn']
    }))
    expect(text).toContain('哈希')
    expect(text).toContain('css-1x2y3z')
  })

  it('Tailwind 原子类名不算哈希，但提示需要转义（真机误报修正）', () => {
    // 真机实测微信小店：`h-[44px]` / `pl-[28px]` 含数字与方括号，但它们是原子化 CSS，
    // 不是构建哈希。早先"含数字即哈希"的规则把它们全判成哈希，导致这个警告失去可信度——
    // 用户连着看几次假警报后，真正危险的 css-1x2y3z 也不会被当回事。
    const text = formatElementProbe(makeResult({
      hashyClasses: [],
      escapeClasses: ['h-[44px]', 'pl-[28px]'],
      stableClasses: ['flex', 'items-center']
    }))
    expect(text, '原子类名不该被标成哈希').not.toContain('疑似构建哈希')
    expect(text, '但应提示需要转义').toContain('转义')
    expect(text).toContain('h-[44px]')
    expect(text, '语义化类名应作为可用项给出').toContain('flex')
  })

  it('真哈希与原子类名同时存在时分别归位（不混为一谈）', () => {
    const text = formatElementProbe(makeResult({
      hashyClasses: ['css-1x2y3z'],
      escapeClasses: ['h-[44px]'],
      stableClasses: ['btn']
    }))
    expect(text).toContain('疑似构建哈希')
    expect(text).toContain('css-1x2y3z')
    expect(text).toContain('转义')
    expect(text).toContain('h-[44px]')
  })

  it('无自有文本时如实说明"不能直接用文案定位"，不假装有锚点', () => {
    const text = formatElementProbe(makeResult({
      textAnchor: '',
      ownText: '',
      innerText: '这段文字都在子元素里'
    }))
    expect(text).toContain('没有自有文本')
    expect(text).not.toContain('clickByText: { text: "" }')
  })

  it('无任何文本（图标按钮）时说明只能靠属性或 CSS', () => {
    const text = formatElementProbe(makeResult({ textAnchor: '', ownText: '', innerText: '' }))
    expect(text).toContain('无文本')
  })

  it('ShadowRoot 内会提示需要 deep: true（否则引擎取不到）', () => {
    const text = formatElementProbe(makeResult({ inShadowRoot: true }))
    expect(text).toContain('deep')
  })

  it('在表格行/列表项内时给出 within 用的行锚点', () => {
    const text = formatElementProbe(makeResult({
      rowSelector: 'table > tbody > tr:nth-of-type(2)',
      rowText: '某达人 粉丝10万 已邀约'
    }))
    expect(text).toContain('within')
    expect(text).toContain('tr:nth-of-type(2)')
  })

  it('采集失败时给出人话原因，不是空白或 undefined', () => {
    const text = formatElementProbe({ ok: false, reason: 'NO_ELEMENT_AT_POINT' })
    expect(text).toContain('落点处没有元素')
    expect(text).not.toContain('undefined')
  })

  it('未知失败原因也不崩（原样带出 reason）', () => {
    const text = formatElementProbe({ ok: false, reason: 'SOMETHING_NEW' })
    expect(text).toContain('SOMETHING_NEW')
  })

  it('保留原始数据尾巴（剪贴板文本被覆盖后仍能从日志追溯细节）', () => {
    const text = formatElementProbe(makeResult({ attrs: { 'aria-label': 'x' } }))
    expect(text).toContain('原始数据')
    expect(text).toContain('aria-label')
  })
})
