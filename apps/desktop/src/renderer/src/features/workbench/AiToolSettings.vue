<script setup lang="ts">
/**
 * 单个 AI 工具自己的设置入口（2026-11-13）。
 *
 * 两个 AI 工具已经是独立功能：设置必须跟着工具走，且只显示这个工具真正使用的接口，
 * 避免在「对话生图」里改到「助手」的 Key。配置仍写同一批 settings/ai 通道，不建第二套配置源。
 */
import { ref } from 'vue'
import AppIcon from '../../components/ui/AppIcon.vue'
import SettingsModal from './SettingsModal.vue'

type AiConfigSectionKey = 'text' | 'image'

const props = defineProps<{
  title: string
  sections: AiConfigSectionKey[]
  label?: string
}>()

const emit = defineEmits<{ closed: [] }>()
const open = ref(false)
function close(): void {
  open.value = false
  emit('closed')
}
</script>

<template>
  <button type="button" class="ai-tool-settings" data-test="ai-tool-settings" @click="open = true">
    <AppIcon name="settings" :size="15" />{{ props.label || '模型设置' }}
  </button>
  <SettingsModal
    v-if="open"
    :title="props.title"
    tab="ai"
    :only-tabs="['ai']"
    :only-ai-sections="props.sections"
    @close="close"
  />
</template>

<style scoped>
.ai-tool-settings{display:inline-flex;align-items:center;gap:6px;min-height:32px;flex:0 0 auto;padding:0 11px;border:1px solid var(--ui-border);border-radius:var(--r-sm);background:var(--ui-surface);color:var(--ui-text-soft);font-size:var(--text-12);font-weight:var(--weight-medium);cursor:pointer;white-space:nowrap}
.ai-tool-settings:hover{border-color:var(--brand-border);color:var(--brand-text)}
.ai-tool-settings:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
</style>
