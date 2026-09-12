<template>
  <div class="app-shell">
    <WorkbenchView />
    <!-- 应用锁 overlay（§6.5/§189）：WebContentsView 已由主进程摘除，此层覆盖全屏 -->
    <div v-if="ws.appLocked" class="lock-overlay">
      <div class="lock-box">
        <div class="lock-ico">🔒</div>
        <h2>ShopPilot 已锁定</h2>
        <p>输入主密码解锁继续</p>
        <input
          v-model="cred"
          type="password"
          placeholder="主密码"
          data-test="unlock-input"
          @keydown.enter="doUnlock"
        >
        <div v-if="unlockErr" class="lock-err">{{ unlockErr }}</div>
        <button class="lock-btn" :disabled="!cred || unlocking" data-test="unlock-btn" @click="doUnlock">
          {{ unlocking ? '解锁中…' : '解锁' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// App Shell - §17.1：单工作台屏幕（内嵌 WebContentsView 需固定视口区域）
import { ref, watch } from 'vue'
import WorkbenchView from '../features/workbench/WorkbenchView.vue'
import { useWorkspaceStore } from '../stores/workspace'

const ws = useWorkspaceStore()
const cred = ref('')
const unlockErr = ref('')
const unlocking = ref(false)

// §17 顶部融合标题栏：右上角原生窗口按钮（WCO）overlay 底色跟随 UI 状态，
// 避免窗口顶角与界面"不匹配"。欢迎页=#1a1a1a（browser-col 底色）、
// 工作台=#242424（右栏底色）、应用锁=#101218（lock-overlay 底色）。
function titlebarOverlayColor(): string {
  if (ws.appLocked) return '#101218'
  return ws.displayedStoreId ? '#242424' : '#1a1a1a'
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
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
    e.preventDefault()
    if (!ws.appLocked && ws.securityEnabled) {
      void window.shopilot.security.lock().then(() => ws.refreshSecurity())
    }
  }
})
</script>

<style>
/* §17 UI 实现规范 - 深色主题 */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

:root {
  --color-bg-primary: #1a1a1a;
  --color-bg-secondary: #242424;
  --color-bg-tertiary: #2d2d2d;
  --color-bg-elevated: #333333;
  --color-border: #404040;
  --color-text-primary: #ffffff;
  --color-text-secondary: #a0a0a0;
  --color-text-muted: #6b6b6b;
  --color-primary: #3b82f6;
  --color-success: #10b981;
  --color-warning: #f59e0b;
  --color-error: #ef4444;
  --radius: 10px;
  --radius-sm: 6px;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  user-select: none;
}

button {
  font-family: inherit;
  cursor: pointer;
  border: none;
  background: none;
  color: inherit;
}

input {
  font-family: inherit;
}

.app-shell {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

.lock-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(16, 18, 24, 0.97);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.lock-box {
  width: 320px;
  padding: 28px 26px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  text-align: center;
}
.lock-ico { font-size: 34px; margin-bottom: 10px; }
.lock-box h2 { font-size: 16px; margin-bottom: 4px; }
.lock-box p { font-size: 12px; color: var(--color-text-secondary); margin-bottom: 16px; }
.lock-box input {
  width: 100%;
  padding: 9px 11px;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text-primary);
  font-size: 13px;
  margin-bottom: 8px;
  outline: none;
}
.lock-box input:focus { border-color: var(--color-primary); }
.lock-err { font-size: 12px; color: var(--color-error); margin-bottom: 8px; }
.lock-btn {
  width: 100%;
  padding: 9px 0;
  background: var(--color-primary);
  border-radius: var(--radius-sm);
  color: #fff;
  font-size: 13px;
}
.lock-btn:disabled { opacity: 0.5; cursor: default; }
</style>
