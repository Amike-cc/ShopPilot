// @vitest-environment happy-dom
// 本文件直接挂载 .vue 组件：需要 DOM 环境，Vitest 才会用 client 变换编译 SFC
//（node 环境走 SSR 变换，SFC 只有 ssrRender，客户端渲染器挂不出任何节点）。
import { createRenderer, h, nextTick, normalizeClass, ref, type VNode } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CustomerServiceWorkspace from '../../apps/desktop/src/renderer/src/features/customer-service/CustomerServiceWorkspace.vue'

const mocks = vi.hoisted(() => ({
  workspace: {
    stores: [] as Array<{ id: string; name: string; platform: string; avatarColor?: string; status?: string }>,
    ready: false,
    appLocked: false
  }
}))

vi.mock('../../apps/desktop/src/renderer/src/stores/workspace', () => ({
  useWorkspaceStore: () => mocks.workspace
}))

vi.mock('../../apps/desktop/src/renderer/src/features/customer-service/customer-message-sound', () => ({
  initCustomerMessageSound: async () => false,
  isCustomerMessageSoundEnabled: () => false,
  setCustomerMessageSoundEnabled: vi.fn()
}))

interface TestNode {
  type: string
  props: Record<string, any>
  children: TestNode[]
  parent: TestNode | null
  text?: string
}

function createHostRenderer() {
  const renderer = createRenderer<TestNode, TestNode>({
    patchProp(node, key, _previous, next) {
      node.props[key] = key === 'class' ? normalizeClass(next) : next
    },
    insert(node, parent, anchor = null) {
      if (node.parent) {
        const previous = node.parent.children.indexOf(node)
        if (previous >= 0) node.parent.children.splice(previous, 1)
      }
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index >= 0) parent.children.splice(index, 0, node)
      else parent.children.push(node)
    },
    remove(node) {
      if (!node.parent) return
      const index = node.parent.children.indexOf(node)
      if (index >= 0) node.parent.children.splice(index, 1)
      node.parent = null
    },
    createElement(type) { return { type, props: {}, children: [], parent: null } },
    createText(text) { return { type: '#text', props: {}, children: [], parent: null, text } },
    createComment(text) { return { type: '#comment', props: {}, children: [], parent: null, text } },
    setText(node, text) { node.text = text },
    setElementText(node, text) {
      node.children = text ? [{ type: '#text', props: {}, children: [], parent: node, text }] : []
    },
    parentNode(node) { return node.parent },
    nextSibling(node) {
      if (!node.parent) return null
      return node.parent.children[node.parent.children.indexOf(node) + 1] || null
    },
    insertStaticContent(content, parent, anchor) {
      const node: TestNode = { type: '#static', props: {}, children: [], parent: null, text: content }
      this.insert(node, parent, anchor)
      return [node, node]
    }
  })
  const root: TestNode = { type: '#root', props: {}, children: [], parent: null }
  return { renderer, root }
}

function find(node: TestNode, predicate: (node: TestNode) => boolean): TestNode | null {
  if (predicate(node)) return node
  for (const child of node.children) {
    const result = find(child, predicate)
    if (result) return result
  }
  return null
}

function byTest(root: TestNode, testId: string): TestNode | null {
  return find(root, node => node.props['data-test'] === testId)
}

function click(node: TestNode | null): void {
  if (!node) throw new Error('Target button not found')
  const handler = node.props.onClick
  if (typeof handler === 'function') handler({ stopPropagation() {}, preventDefault() {} })
  else if (Array.isArray(handler)) handler.forEach(callback => callback({ stopPropagation() {}, preventDefault() {} }))
  else throw new Error('Target button has no click handler')
}

function createWindowHarness() {
  const listeners = new Map<string, Set<(event: any) => void>>()
  const windowMock = {
    addEventListener(type: string, listener: (event: any) => void) {
      const set = listeners.get(type) || new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type: string, listener: (event: any) => void) {
      listeners.get(type)?.delete(listener)
    },
    dispatch(type: string, event: any) {
      listeners.get(type)?.forEach(listener => listener(event))
    },
    listenerCount(type: string) { return listeners.get(type)?.size || 0 }
  }
  vi.stubGlobal('window', windowMock)
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn()
  })
  return windowMock
}

function createApp(active: ReturnType<typeof ref<boolean>>) {
  const { renderer, root } = createHostRenderer()
  const parent = {
    setup() {
      return () => h(CustomerServiceWorkspace, { active: active.value }) as VNode
    }
  }
  const app = renderer.createApp(parent)
  app.mount(root)
  return { app, root }
}

describe('客服工作区移动端店铺抽屉', () => {
  beforeEach(() => {
    mocks.workspace.stores.splice(0)
    mocks.workspace.ready = false
    mocks.workspace.appLocked = false
    createWindowHarness()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('菜单打开后真实 Escape 事件关闭抽屉并阻止默认行为', async () => {
    const active = ref(true)
    const { app, root } = createApp(active)
    await nextTick()

    click(byTest(root, 'customer-mobile-nav-toggle'))
    await nextTick()
    expect(byTest(root, 'customer-mobile-sidebar-backdrop')).not.toBeNull()
    expect(byTest(root, 'customer-mobile-nav-toggle')?.props['aria-expanded']).toBe(true)
    expect(find(root, node => node.props.class?.includes('mobile-open'))).not.toBeNull()

    const event = { key: 'Escape', preventDefault: vi.fn() }
    ;(window as unknown as ReturnType<typeof createWindowHarness>).dispatch('keydown', event)
    await nextTick()

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(byTest(root, 'customer-mobile-sidebar-backdrop')).toBeNull()
    expect(byTest(root, 'customer-mobile-nav-toggle')?.props['aria-expanded']).toBe(false)
    app.unmount()
  })

  it('遮罩和菜单按钮仍能关闭抽屉', async () => {
    const active = ref(true)
    const { app, root } = createApp(active)
    await nextTick()

    click(byTest(root, 'customer-mobile-nav-toggle'))
    await nextTick()
    click(byTest(root, 'customer-mobile-sidebar-backdrop'))
    await nextTick()
    expect(byTest(root, 'customer-mobile-sidebar-backdrop')).toBeNull()

    click(byTest(root, 'customer-mobile-nav-toggle'))
    await nextTick()
    click(byTest(root, 'customer-mobile-nav-toggle'))
    await nextTick()
    expect(byTest(root, 'customer-mobile-sidebar-backdrop')).toBeNull()
    app.unmount()
  })

  it('切换店铺或工作区时关闭抽屉，卸载时移除 keydown 监听', async () => {
    mocks.workspace.stores.push(
      { id: 'store-a', name: '店铺 A', platform: '抖店' },
      { id: 'store-b', name: '店铺 B', platform: '快手小店' }
    )
    // 店铺列表只在 ready 后渲染（未就绪时显示「正在读取店铺…」），不置位就点不到店铺按钮
    mocks.workspace.ready = true
    const active = ref(true)
    const { app, root } = createApp(active)
    await nextTick()
    expect((window as unknown as ReturnType<typeof createWindowHarness>).listenerCount('keydown')).toBe(1)

    click(byTest(root, 'customer-mobile-nav-toggle'))
    await nextTick()
    const storeB = find(root, node => node.type === 'button' && node.props['data-store-id'] === 'store-b')
    click(storeB)
    await nextTick()
    expect(byTest(root, 'customer-mobile-sidebar-backdrop')).toBeNull()

    click(byTest(root, 'customer-mobile-nav-toggle'))
    await nextTick()
    active.value = false
    await nextTick()
    expect(byTest(root, 'customer-mobile-sidebar-backdrop')).toBeNull()

    app.unmount()
    expect((window as unknown as ReturnType<typeof createWindowHarness>).listenerCount('keydown')).toBe(0)
  })
})
