/**
 * IPC 契约三方一致性守卫（task-3 落地契约 → task-7 固化为常驻单测）
 *
 * 三方：`IpcContract`（通道 → { req, res } 的唯一声明）↔ preload 的转发 ↔ 渲染层
 * `window.shopilot` 的类型声明。三份东西由不同的人在三个文件里维护，少改一处都不会立刻报错：
 *   · 契约漏了通道 → 只是失去类型保护，编译照样过；
 *   · preload 漏了方法 / 改了通道字符串 → 运行期才炸（渲染层调 window.shopilot.x）；
 *   · env.d.ts 漏了方法 → 渲染层用到时才发现，还只是"编译不过"。
 * 这里把三方的**结构不变量**钉死，失败信息直接点名漂移的方法/通道。
 *
 * 纯静态：只用 TypeScript 编译器 API 解析源码文本（不 import electron、不起 Electron、不联网）。
 * preload 运行时才注入 `ipcRenderer`，不能 import 进来跑，所以它的「转发关系」按 AST 里的
 * `invoke(IPC_CHANNELS.X)`（走契约）与 `ipcRenderer.invoke(IPC_CHANNELS.X)`（未接入契约）取。
 *
 * 背景数字（2026-10-19）：契约 105 通道 / 12 域，preload 212 方法 / 32 分组，其中 105 个方法
 * 走类型化 invoke、104 个方法仍在旧路径。日常改动只需要让这些不变量继续成立。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { IPC_CHANNELS } from '@shared/contracts/ipc'

const IPC_CONTRACT_PATH = 'packages/shared/src/contracts/ipc.ts'
const PRELOAD_PATH = 'apps/desktop/src/preload/index.ts'
const ENV_DTS_PATH = 'apps/desktop/src/renderer/src/env.d.ts'

/**
 * preload 里不转发任何 IPC 的方法（事件订阅 / 本地文件路径），白名单必须显式列出来：
 * 少了方法会报"无 IPC 调用"，多了会报"白名单已过期"，两边都不许静默。
 */
const NON_IPC_METHODS = ['on', 'off', 'products.library.getPathForFile']

/** 通道取值集合（运行期真值；IPC_CHANNELS 是纯常量表，不依赖 electron） */
const CHANNEL_VALUES: ReadonlySet<string> = new Set(Object.values(IPC_CHANNELS) as string[])

const channelConstValue = (name: string): string | undefined => (IPC_CHANNELS as Record<string, string>)[name]

const sorted = (items: readonly string[]): string[] => [...items].sort()

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(resolve(path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

const propertyName = (name: ts.PropertyName | undefined): string | null => {
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

function mustFind<T>(value: T | null | undefined, message: string): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(`${message}（IPC 契约守卫解析失效，请检查该文件的形状是否被改动）`)
  }
  return value as NonNullable<T>
}

/** 渲染层声明的 API 形状（方法与分组） */
interface ApiShape {
  /** 方法（箭头函数 / 函数类型） */
  methods: string[]
  /** 分组（嵌套对象 / 内联对象类型） */
  groups: string[]
  /** 非方法成员（如 platforms 静态目录） */
  values: string[]
}

/** preload 某个方法对某个通道的转发 */
interface Forward {
  /** preload 方法路径，如 browser.tab.closeMany */
  method: string
  /** 源码里的通道常量名，如 BROWSER_TAB_CLOSE_MANY */
  channelConst: string
  /** true = `invoke(IPC_CHANNELS.X)`（走契约）；false = `ipcRenderer.invoke(...)`（未接入契约） */
  typed: boolean
}

function collectContractKeys(file: ts.SourceFile): string[] {
  const decl = mustFind(findInterface(file, 'IpcContract'), `找不到 ${IPC_CONTRACT_PATH} 的 IpcContract 接口`)
  return decl.members
    .filter(ts.isPropertySignature)
    .map(member => propertyName(member.name))
    .filter((name): name is string => name !== null)
}

function findInterface(file: ts.SourceFile, name: string): ts.InterfaceDeclaration | null {
  const found: ts.InterfaceDeclaration[] = []
  const visit = (node: ts.Node): void => {
    if (found.length) return
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      found.push(node)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found[0] ?? null
}

/** 收集 preload 方法里对 IPC 的转发（含通道常量名与是否走契约） */
function collectForwards(fn: ts.FunctionLikeDeclaration, method: string, out: Forward[]): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const typed = ts.isIdentifier(callee) && callee.text === 'invoke'
      const raw = ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'invoke' &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'ipcRenderer'
      const first = node.arguments[0]
      if ((typed || raw) && first &&
        ts.isPropertyAccessExpression(first) &&
        ts.isIdentifier(first.expression) &&
        first.expression.text === 'IPC_CHANNELS') {
        out.push({ method, channelConst: first.name.text, typed })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(fn)
}

function walkApiObject(node: ts.ObjectLiteralExpression, prefix: string, shape: ApiShape, forwards: Forward[]): void {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = propertyName(property.name)
    if (!name) continue
    const path = prefix ? `${prefix}.${name}` : name
    const init = property.initializer
    if (ts.isObjectLiteralExpression(init)) {
      shape.groups.push(path)
      walkApiObject(init, path, shape, forwards)
    } else if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
      shape.methods.push(path)
      collectForwards(init, path, forwards)
    } else {
      shape.values.push(path)
    }
  }
}

function parsePreloadApi(file: ts.SourceFile): { shape: ApiShape; forwards: Forward[] } {
  const found: ts.ObjectLiteralExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'api' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)) {
      found.push(node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  const shape: ApiShape = { methods: [], groups: [], values: [] }
  const forwards: Forward[] = []
  walkApiObject(mustFind(found[0] ?? null, `找不到 ${PRELOAD_PATH} 的 const api = { ... } 对象`), '', shape, forwards)
  return { shape, forwards }
}

function walkTypeLiteral(node: ts.TypeLiteralNode, prefix: string, shape: ApiShape): void {
  for (const member of node.members) {
    if (!ts.isPropertySignature(member)) continue
    const name = propertyName(member.name)
    if (!name) continue
    const path = prefix ? `${prefix}.${name}` : name
    const type = member.type
    if (type && ts.isTypeLiteralNode(type)) {
      shape.groups.push(path)
      walkTypeLiteral(type, path, shape)
    } else if (type && ts.isFunctionTypeNode(type)) {
      shape.methods.push(path)
    } else {
      shape.values.push(path)
    }
  }
}

/** 取 env.d.ts 里 `interface Window { shopilot: { ... } }` 的声明形状 */
function parseEnvShopilot(file: ts.SourceFile): ApiShape {
  const windowInterface = mustFind(findInterface(file, 'Window'), `找不到 ${ENV_DTS_PATH} 的 Window 接口`)
  const shopilot = mustFind(
    windowInterface.members
      .filter(ts.isPropertySignature)
      .find(member => propertyName(member.name) === 'shopilot'),
    `找不到 ${ENV_DTS_PATH} 里 Window.shopilot 的声明`
  )
  const type = mustFind(shopilot.type, `Window.shopilot 没有类型声明`)
  if (!ts.isTypeLiteralNode(type)) throw new Error('Window.shopilot 的声明不是对象字面量类型')
  const shape: ApiShape = { methods: [], groups: [], values: [] }
  walkTypeLiteral(type, '', shape)
  return shape
}

const contractKeys = collectContractKeys(parse(IPC_CONTRACT_PATH))
const contractKeySet = new Set(contractKeys)
const preload = parsePreloadApi(parse(PRELOAD_PATH))
const envShape = parseEnvShopilot(parse(ENV_DTS_PATH))

const typedForwards = preload.forwards.filter(forward => forward.typed)
const rawForwards = preload.forwards.filter(forward => !forward.typed)
const channelOf = (forward: Forward): string => channelConstValue(forward.channelConst) ?? forward.channelConst
const describeForward = (forward: Forward): string => `${forward.method} → ${forward.channelConst}`

describe('IPC 契约：IpcContract ↔ IPC_CHANNELS', () => {
  it('契约里的每个通道都是 IPC_CHANNELS 的真实取值（编译期守卫之外的运行期兜底）', () => {
    const unknown = sorted(contractKeys.filter(key => !CHANNEL_VALUES.has(key)))
    expect(
      unknown,
      `IpcContract 里这些键不是 IPC_CHANNELS 的取值（写错通道名就等于这条契约永远匹配不上）：${unknown.join('、')}`
    ).toEqual([])
  })

  it('契约没有重复通道（重复声明会静默覆盖前一条）', () => {
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const key of contractKeys) {
      if (seen.has(key)) duplicates.push(key)
      seen.add(key)
    }
    expect(sorted(duplicates), `IpcContract 重复声明的通道：${sorted(duplicates).join('、')}`).toEqual([])
  })
})

describe('IPC 契约：preload 方法树 ↔ env.d.ts 的 window.shopilot 声明', () => {
  it('方法 / 分组 / 非方法字段逐项一致（谁漂移就点名谁）', () => {
    const drift: string[] = []
    const compare = (label: string, preloadItems: readonly string[], envItems: readonly string[]): void => {
      const a = sorted(preloadItems)
      const b = sorted(envItems)
      const onlyPreload = a.filter(item => !b.includes(item))
      const onlyEnv = b.filter(item => !a.includes(item))
      if (onlyPreload.length) drift.push(`${label}：preload 有、env.d.ts 没有 → ${onlyPreload.join('、')}`)
      if (onlyEnv.length) drift.push(`${label}：env.d.ts 有、preload 没有 → ${onlyEnv.join('、')}`)
    }
    compare('方法', preload.shape.methods, envShape.methods)
    compare('分组', preload.shape.groups, envShape.groups)
    compare('非方法字段', preload.shape.values, envShape.values)
    expect(drift, drift.join('\n')).toEqual([])
  })

  it('解析规模正常（防止解析失效后所有断言静默空转）', () => {
    expect(preload.shape.methods.length, 'preload 暴露的方法数异常偏少').toBeGreaterThan(100)
    expect(preload.shape.groups.length, 'preload 的分组数异常偏少').toBeGreaterThan(20)
    expect(envShape.methods.length, 'env.d.ts 声明的方法数异常偏少').toBeGreaterThan(100)
    expect(contractKeys.length, '契约通道数异常偏少').toBeGreaterThan(50)
    expect(preload.forwards.length, 'preload 的 IPC 转发数异常偏少').toBeGreaterThan(100)
  })
})

describe('IPC 契约：preload 转发 ↔ IpcContract', () => {
  it('preload 引用的 IPC_CHANNELS 常量都真实存在', () => {
    const referenced = [...new Set(preload.forwards.map(forward => forward.channelConst))]
    const missing = sorted(referenced.filter(name => typeof channelConstValue(name) !== 'string'))
    expect(missing, `preload 引用了 IPC_CHANNELS 里不存在的常量：${missing.join('、')}`).toEqual([])
  })

  it('每个方法最多转发一个通道，且除白名单外都至少转发一个', () => {
    const byMethod = new Map<string, Forward[]>()
    for (const forward of preload.forwards) {
      const list = byMethod.get(forward.method) ?? []
      list.push(forward)
      byMethod.set(forward.method, list)
    }
    const problems: string[] = []
    for (const [method, list] of byMethod) {
      if (list.length > 1) problems.push(`${method} 一次转发多个通道：${list.map(item => item.channelConst).join(' + ')}`)
    }
    for (const method of preload.shape.methods) {
      if (!byMethod.has(method) && !NON_IPC_METHODS.includes(method)) problems.push(`${method} 没有任何 IPC 转发（是不是漏接线了？）`)
    }
    for (const method of NON_IPC_METHODS) {
      if (byMethod.has(method)) problems.push(`${method} 已在转发 IPC，白名单该删了`)
      else if (!preload.shape.methods.includes(method)) problems.push(`${method} 已不在 preload 里，白名单该删了`)
    }
    expect(sorted(problems), problems.join('\n')).toEqual([])
  })

  it('类型化 invoke 用到的通道都在契约内', () => {
    const outside = typedForwards.filter(forward => !contractKeySet.has(channelOf(forward)))
    expect(
      outside.map(describeForward),
      `这些方法走了类型化 invoke，但通道不在 IpcContract 里：${outside.map(describeForward).join('、')}`
    ).toEqual([])
  })

  it('契约通道与 preload 类型化转发一一对应（集合先点名，数量兜底）', () => {
    const typedChannels = [...new Set(typedForwards.map(channelOf))]
    const typedChannelSet = new Set(typedChannels)
    const missingInPreload = sorted(contractKeys.filter(key => !typedChannelSet.has(key)))
    const outsideContract = sorted(typedChannels.filter(channel => !contractKeySet.has(channel)))
    // 先报"谁漂了"，最后才比数量：断言失败会中断用例，先失败的那条必须带上通道名
    expect(missingInPreload, `契约里有、preload 没有类型化转发：${missingInPreload.join('、')}`).toEqual([])
    expect(outsideContract, `preload 有类型化转发、契约里没有：${outsideContract.join('、')}`).toEqual([])
    expect(
      typedChannels.length,
      `契约 ${contractKeys.length} 个通道，preload 类型化转发 ${typedChannels.length} 个 —— 数量不一致即为漏改`
    ).toBe(contractKeys.length)
  })

  it('每个契约通道只被一个 preload 方法转发（防复制粘贴时改错通道）', () => {
    const byChannel = new Map<string, Forward[]>()
    for (const forward of typedForwards) {
      const channel = channelOf(forward)
      const list = byChannel.get(channel) ?? []
      list.push(forward)
      byChannel.set(channel, list)
    }
    const shared = [...byChannel]
      .filter(([, list]) => list.length > 1)
      .map(([channel, list]) => `${channel} 被 ${list.map(forward => forward.method).join('、')} 同时转发`)
    expect(sorted(shared), shared.join('\n')).toEqual([])
  })

  it('契约已收录的通道不能再留在旧的 ipcRenderer.invoke 路径', () => {
    const stillRaw = rawForwards.filter(forward => contractKeySet.has(channelOf(forward)))
    expect(
      stillRaw.map(describeForward),
      `这些通道已进契约，但 preload 仍走 ipcRenderer.invoke（应改用类型化 invoke）：${stillRaw.map(describeForward).join('、')}`
    ).toEqual([])
  })

  it('未接入契约的通道只走旧路径（数量关系自洽）', () => {
    const rawChannels = new Set(rawForwards.map(channelOf))
    const overlap = sorted([...rawChannels].filter(channel => contractKeySet.has(channel)))
    expect(overlap, `新旧两条路径同时覆盖：${overlap.join('、')}`).toEqual([])
    expect(
      typedForwards.length + rawForwards.length,
      'preload 转发总数应为类型化 + 旧路径两者之和'
    ).toBe(preload.forwards.length)
  })
})
