<script setup lang="ts">
/**
 * 功能设置浮层（2026-11-09）：设置必须和功能在一起。
 *
 * 不跳设置中心，直接在功能页面/商城卡片上覆盖一个设置面板；面板只展示该功能相关的页签
 * （onlyTabs），底层功能页面保持挂载。内置模块的设置仍然写同一批 settings/ai 通道，
 * 不新增第二套配置源。
 */
import UnifiedSettingsPage from './UnifiedSettingsPage.vue'

type SettingsTabKey = 'entry' | 'ai' | 'security' | 'extensions' | 'maintenance' | 'about'

defineProps<{
  title: string
  tab?: SettingsTabKey
  onlyTabs?: SettingsTabKey[]
}>()

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div class="sm-overlay" @click.self="emit('close')">
    <section class="sm-card" role="dialog" aria-modal="true" :aria-label="title">
      <header class="sm-head">
        <div>
          <h2>{{ title }}</h2>
          <p>设置随功能保存在本机；关闭后回到当前页面，不会跳转到设置中心。</p>
        </div>
        <button type="button" class="sm-close" aria-label="关闭设置" @click="emit('close')">×</button>
      </header>
      <div class="sm-body">
        <UnifiedSettingsPage :initial-tab="tab" :only-tabs="onlyTabs" @close="emit('close')" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.sm-overlay{position:fixed;inset:0;z-index:80;display:grid;place-items:center;padding:20px;background:rgba(16,24,40,.45)}
.sm-card{display:flex;flex-direction:column;width:min(1040px,100%);height:min(760px,calc(100vh - 40px));overflow:hidden;border:1px solid var(--ui-border);border-radius:var(--r-lg);background:var(--ui-surface);box-shadow:0 30px 60px -24px rgba(16,24,40,.5)}
.sm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 20px 12px;border-bottom:1px solid var(--ui-border)}
.sm-head h2{margin:0 0 4px;font-size:var(--text-16);font-weight:var(--weight-semibold);color:var(--ui-text)}
.sm-head p{margin:0;color:var(--ui-text-muted);font-size:var(--text-11)}
.sm-close{display:grid;place-items:center;width:28px;height:28px;flex:0 0 auto;padding:0;border:1px solid var(--ui-border);border-radius:var(--r-sm);background:var(--ui-surface);color:var(--ui-text-muted);font-size:17px;line-height:1;cursor:pointer}
.sm-close:hover{color:var(--ui-text);border-color:var(--ui-border-strong)}
.sm-body{flex:1;min-height:0;overflow:hidden}
.sm-body :deep(.unified-page-head){display:none}
.sm-body :deep(.unified-page){height:100%;padding:14px 18px 18px;overflow:auto}
.sm-body :deep(.settings-layout){height:calc(100% - 4px)}
.sm-body :deep(.settings-content){overflow:auto}
</style>
