<template>
  <div class="app-shell">
    <!-- 所有业务页面统一挂载到新的深色工作台。旧 WorkbenchView 保留在仓库中作为历史兼容代码，运行时不再作为入口。 -->
    <DashboardView />
    <!-- 应用锁 overlay（§6.5/§189）：WebContentsView 已由主进程摘除，此层覆盖全屏 -->
    <div v-if="ws.appLocked" class="lock-overlay">
      <div class="lock-box">
        <div class="lock-ico"><img :src="lockIcon" alt="" /></div>
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
import DashboardView from '../features/workbench/DashboardView.vue'
import { useWorkspaceStore } from '../stores/workspace'
import lockIcon from '../assets/generated/ui-icons/lock.png'

const ws = useWorkspaceStore()
const cred = ref('')
const unlockErr = ref('')
const unlocking = ref(false)

// §17 顶部融合标题栏：右上角原生窗口按钮（WCO）overlay 是不透明覆盖层，
// 底色必须与它覆盖的那块 UI **完全一致**，否则右上角会显示成一块多余的色块。
// 统一工作台里 WCO（高 38px）落在白色的 .dashboard-toolbar 上（该行已为它右侧留出 148px），
// 所以这里返回的就是工具栏底色 —— 必须与 DashboardView.vue 里 .dashboard-toolbar 的
// background 保持同一个十六进制（改一处要改两处）。
const TOOLBAR_BG = '#ffffff'
function titlebarOverlayColor(): string {
  if (ws.appLocked) return '#101218'
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
/* §17 UI 实现规范 - 浅色主题（2026-09-28 按设计稿重制）
   设计令牌集中在这里：页面/卡片/描边/文字四层 + 品牌色与语义色。
   其它页面（工作台、数据中心、设置…）都引用这些变量，改一处全站一致。 */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

:root {
  --color-bg-primary: #f5f7fb;
  --color-bg-secondary: #ffffff;
  --color-bg-tertiary: #f2f4f8;
  --color-bg-elevated: #ffffff;
  --color-border: #e9edf5;
  --color-border-strong: #dbe2ee;
  --color-text-primary: #0f1729;
  --color-text-secondary: #4a5568;
  --color-text-muted: #98a2b3;
  --color-primary: #7c5cff;
  --color-primary-strong: #5b3df5;
  --color-success: #12b76a;
  --color-warning: #f79009;
  --color-error: #f04438;
  --radius: 16px;
  --radius-sm: 10px;
  /* 品牌渐变（选中导航、主按钮）与卡片阴影 */
  --brand-gradient: linear-gradient(135deg, #8b5cff 0%, #6a3cf0 100%);
  --brand-soft: rgba(124, 92, 255, .1);
  --shadow-card: 0 1px 2px rgba(16, 24, 40, .04), 0 10px 28px rgba(16, 24, 40, .06);
  --shadow-pop: 0 12px 32px rgba(16, 24, 40, .12);
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

/* 应用内容由工作台及各页面自己的滚动容器承载，根文档不能再生成第二条滚动条。 */
html,
body,
#app {
  width: 100%;
  height: 100%;
  overflow: hidden;
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
  width: 100%;
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
.lock-ico { width: 64px; height: 64px; margin: 0 auto 10px; }.lock-ico img { display: block; width: 100%; height: 100%; object-fit: contain; }
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
