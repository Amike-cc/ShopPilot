<template>
  <section class="agent-drawer" role="dialog" aria-modal="false" aria-label="AI 对话">
    <header class="agent-header">
      <div class="agent-title-mark"><img :src="assistantIcon" alt="" /></div>
      <div class="agent-title">
        <strong>AI 对话</strong>
        <span :class="['agent-presence', { working: agent.busy, failed: agent.status === 'failed' }]">{{ presenceLabel }}</span>
      </div>
      <button class="agent-close" type="button" aria-label="关闭对话面板" title="关闭" @click="emit('close')"><img :src="closeIcon" alt="" /></button>
    </header>

    <div class="agent-mode-note" data-test="agent-chat-only">
      纯对话模式 · 不会读取或操作店铺、网页和任务
    </div>

    <div ref="scrollArea" class="agent-scroll-area" @scroll.passive="onScroll">
      <AgentMessageList :messages="agent.messages" :busy="agent.busy" :status-label="agent.stateLabel" />
      <div v-if="agent.error" class="agent-error" role="alert">
        <strong>{{ agent.error.code }}</strong><span>{{ agent.error.message }}</span>
      </div>
    </div>

    <button v-if="showJumpLatest" type="button" class="agent-jump-latest" data-test="agent-jump-latest" @click="jumpToLatest">有新消息 ↓</button>
    <AgentComposer :disabled="agent.busy" @send="agent.sendMessage" />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAgentStore } from '../../stores/agent'
import AgentComposer from './AgentComposer.vue'
import AgentMessageList from './AgentMessageList.vue'
import assistantIcon from '../../assets/generated/ai-assistant-generated.png'
import closeIcon from '../../assets/generated/ui-icons/close.png'

const emit = defineEmits<{ close: [] }>()
const agent = useAgentStore()
const scrollArea = ref<HTMLElement | null>(null)
const stickToBottom = ref(true)
const hasNewWhileAway = ref(false)
const presenceLabel = computed(() => agent.busy ? '正在回复' : agent.status === 'failed' ? '暂不可用' : agent.aiConfigured === false ? '待配置 AI' : '在线')
const showJumpLatest = computed(() => !stickToBottom.value && hasNewWhileAway.value)
const scrollSignature = computed(() => {
  const last = agent.messages[agent.messages.length - 1]
  return `${agent.messages.length}|${last?.id || ''}|${agent.busy ? 1 : 0}|${agent.error?.code || ''}`
})

function scrollToLatest() {
  void nextTick(() => {
    const area = scrollArea.value
    if (!area) return
    area.scrollTop = area.scrollHeight
    requestAnimationFrame(() => {
      if (scrollArea.value && stickToBottom.value) scrollArea.value.scrollTop = scrollArea.value.scrollHeight
    })
  })
}

function onScroll() {
  const area = scrollArea.value
  if (!area) return
  stickToBottom.value = area.scrollHeight - area.scrollTop - area.clientHeight < 40
  if (stickToBottom.value) hasNewWhileAway.value = false
}

function jumpToLatest() {
  stickToBottom.value = true
  hasNewWhileAway.value = false
  scrollToLatest()
}

function onEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  event.preventDefault()
  emit('close')
}

watch(scrollSignature, () => {
  const last = agent.messages[agent.messages.length - 1]
  if (stickToBottom.value || last?.role === 'user') {
    stickToBottom.value = true
    hasNewWhileAway.value = false
    scrollToLatest()
  } else hasNewWhileAway.value = true
}, { flush: 'post' })

onMounted(() => {
  window.addEventListener('keydown', onEscape)
  stickToBottom.value = true
  scrollToLatest()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onEscape))
</script>

<style scoped>
.agent-drawer { position:relative;display:flex;flex-direction:column;min-width:0;width:100%;height:100%;overflow:hidden;color:var(--color-text-primary);background:var(--color-bg-secondary);--color-text-muted:#5b6472; }
.agent-header { display:flex;align-items:center;gap:9px;flex:0 0 auto;padding:9px 12px;border-bottom:1px solid var(--color-border); }
.agent-title-mark { display:grid;place-items:center;width:30px;height:30px;overflow:hidden;border-radius:10px;background:linear-gradient(145deg,#2e86e9,#8150d9); }
.agent-title-mark img { width:32px;height:32px;object-fit:contain; }
.agent-title { display:flex;flex-direction:column;gap:2px; }.agent-title strong { font-size:13px; }.agent-presence { color:#067647;font-size:9px; }.agent-presence.working { color:#b54708; }.agent-presence.failed { color:#b42318; }
.agent-close { display:grid;place-items:center;margin-left:auto;width:26px;height:26px;border:0;border-radius:7px;background:transparent;color:var(--color-text-secondary);cursor:pointer; }.agent-close img { width:16px;height:16px;object-fit:contain; }
.agent-mode-note { flex:0 0 auto;padding:8px 12px;border-bottom:1px solid var(--color-border);color:var(--color-text-muted);font-size:10px;line-height:1.5; }
.agent-scroll-area { flex:1 1 auto;min-height:80px;overflow:auto;padding-bottom:8px;scroll-behavior:smooth; }
.agent-error { display:flex;flex-direction:column;gap:3px;margin:4px 14px 12px;padding:8px 10px;border:1px solid rgba(224,116,116,.42);border-radius:8px;background:rgba(164,65,65,.08);color:var(--color-text-primary);font-size:10px; }.agent-error strong { color:#b42318; }.agent-error span { line-height:1.45; }
.agent-jump-latest { position:absolute;left:50%;bottom:105px;z-index:6;transform:translateX(-50%);border:1px solid rgba(126,110,226,.65);border-radius:99px;padding:5px 12px;background:rgba(58,48,120,.92);color:#efeaff;font-size:10px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.2); }
</style>
