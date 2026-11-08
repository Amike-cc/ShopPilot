<template>
  <div class="app-shell">
    <!-- 经营工作台与电商客服是两个独立工作区，但同店登录状态共用；切换只改变可见工作区，
         客服监控不会改写经营工作台的店铺、标签或网页状态。 -->
    <DashboardView :active="!customerServiceOpen" @open-customer-service="customerServiceOpen = true" />
    <CustomerServiceWorkspace
      :active="customerServiceOpen"
      @back-commerce="customerServiceOpen = false"
    />
    <!-- 应用锁 overlay（§6.5/§189）：WebContentsView 已由主进程摘除，此层覆盖全屏 -->
    <div v-if="ws.appLocked" class="lock-overlay" role="dialog" aria-modal="true" aria-label="应用已锁定">
      <div class="lock-card">
        <div class="lock-mark" aria-hidden="true"><AppIcon name="lock" :size="22" :stroke="1.8" /></div>
        <h1>ShopPilot 已锁定</h1>
        <p>输入主密码解锁继续</p>
        <label class="lock-field">
          <span class="sr-only">主密码</span>
          <input
            v-model="cred"
            type="password"
            placeholder="主密码"
            autocomplete="current-password"
            data-test="unlock-input"
            @keydown.enter="doUnlock"
          >
        </label>
        <div v-if="unlockErr" class="lock-err" role="alert">{{ unlockErr }}</div>
        <button
          class="ui-btn ui-btn--primary ui-btn--lg ui-btn--block"
          :disabled="!cred || unlocking"
          data-test="unlock-btn"
          @click="doUnlock"
        >
          {{ unlocking ? '解锁中…' : '解锁' }}
        </button>
        <p class="lock-foot"><AppIcon name="shield" :size="13" /> 快捷键 Ctrl+Shift+L 可随时重新锁定</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// App Shell - §17.1：单工作台屏幕（内嵌 WebContentsView 需固定视口区域）
import { ref, watch, onBeforeUnmount } from 'vue'
import DashboardView from '../features/workbench/DashboardView.vue'
import CustomerServiceWorkspace from '../features/customer-service/CustomerServiceWorkspace.vue'
import AppIcon from '../components/ui/AppIcon.vue'
import { useWorkspaceStore } from '../stores/workspace'

const ws = useWorkspaceStore()
const cred = ref('')
const unlockErr = ref('')
const unlocking = ref(false)
const customerServiceOpen = ref(false)

// §17 顶部融合标题栏：右上角原生窗口按钮（WCO）overlay 是不透明覆盖层，
// 底色必须与它覆盖的那块 UI **完全一致**，否则右上角会显示成一块多余的色块。
// 统一工作台里 WCO（高 38px）落在白色的 .appbar 上（该行已为它右侧留出 148px），
// 所以这里返回的就是顶栏底色 —— 必须与 DashboardView.vue 里 .appbar 的
// background 保持同一个十六进制（改一处要改两处）。
const TOOLBAR_BG = '#ffffff'
function titlebarOverlayColor(): string {
  if (ws.appLocked) return '#0e1117'
  return TOOLBAR_BG
}
watch(
  () => [ws.appLocked, ws.displayedStoreId] as const,
  () => {
    void window.shopilot?.windowChrome?.setTitlebarOverlay({ color: titlebarOverlayColor() })
  },
  { immediate: true }
)

async function doUnlock() {
  if (!cred.value || unlocking.value) return
  unlocking.value = true
  unlockErr.value = ''
  const ok = await ws.unlockApp(cred.value)
  unlocking.value = false
  if (!ok) {
    unlockErr.value = '主密码不正确'
  }
  cred.value = ''
}

// §818 快捷键：Ctrl+Shift+L 锁定应用
// P1-10（2026-10-15 审查）：此前是匿名监听、永不清理——HMR/重挂载会叠加出多个监听
// （按一次快捷键触发 N 次 lock），且旧闭包持续持有 store。改为具名监听 + 卸载清理。
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.ctrlKey && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
    e.preventDefault()
    if (!ws.appLocked && ws.securityEnabled) {
      void window.shopilot?.security?.lock().then(() => ws.refreshSecurity())
    }
  }
}
window.addEventListener('keydown', onGlobalKeydown)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  // P1-10：连同事件订阅一起卸载，避免 HMR/重挂载后每个事件被处理多遍
  ws.unsubscribeEvents()
})
</script>

<style scoped>
.app-shell {
  width: 100%;
  height: 100vh;
  overflow: hidden;
}

/* 锁定层：把界面压暗并模糊，形成"内容还在、但不可达"的明确语义 */
.lock-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-lock);
  display: grid;
  place-items: center;
  background: rgba(14, 17, 23, 0.72);
  backdrop-filter: blur(14px) saturate(0.6);
  animation: ui-fade-in var(--dur-base) var(--ease);
}
.lock-card {
  display: flex;
  width: 336px;
  flex-direction: column;
  align-items: center;
  padding: 28px 26px 22px;
  border: 1px solid var(--ui-border);
  border-radius: var(--r-xl);
  background: var(--ui-surface);
  box-shadow: var(--e3);
  text-align: center;
  animation: ui-pop-in var(--dur-slow) var(--ease);
}
.lock-mark {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  margin-bottom: 12px;
  border-radius: var(--r-lg);
  background: var(--brand-soft);
  color: var(--brand);
}
.lock-card h1 {
  font-size: var(--text-16);
  font-weight: var(--weight-semibold);
}
.lock-card > p {
  margin: 4px 0 18px;
  color: var(--ui-text-muted);
  font-size: var(--text-12);
}
.lock-field {
  width: 100%;
  margin-bottom: 8px;
}
.lock-field input {
  width: 100%;
  height: 36px;
  padding: 0 11px;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--r-sm);
  background: var(--ui-surface);
  font-size: var(--text-13);
  text-align: center;
  letter-spacing: 0.2em;
  outline: none;
  transition:
    border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}
.lock-field input:focus {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-50);
}
.lock-err {
  width: 100%;
  margin-bottom: 8px;
  color: var(--danger-text);
  font-size: var(--text-12);
}
.lock-foot {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 16px;
  color: var(--ui-text-muted);
  font-size: var(--text-11);
}
</style>
