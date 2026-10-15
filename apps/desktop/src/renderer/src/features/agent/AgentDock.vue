<template>
  <div v-if="!props.locked" class="agent-dock" data-test="agent-dock">
    <AgentOrb
      :needs-confirmation="false"
      :expanded="agent.ui.drawerOpen"
      @toggle="toggleDrawer"
      @drag-start="$emit('dragging-change', true)"
      @drag-end="$emit('dragging-change', false)"
      @position-change="orbPosition = $event"
    />
    <div
      v-if="agent.ui.drawerOpen"
      class="agent-flyout"
      data-test="agent-floating-drawer"
      :style="drawerStyle"
    >
      <AgentDrawer
        @close="closeDrawer"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useAgentStore } from '../../stores/agent'
import AgentDrawer from './AgentDrawer.vue'
import AgentOrb from './AgentOrb.vue'

const props = defineProps<{ locked?: boolean }>()
const emit = defineEmits<{ 'dragging-change': [dragging: boolean] }>()
const agent = useAgentStore()
const viewport = reactive({ width: window.innerWidth, height: window.innerHeight })
const orbPosition = ref({ x: 0, y: 0 })

const drawerStyle = computed(() => {
  const margin = 12
  const gap = 12
  const orbSize = 64
  const width = Math.max(280, Math.min(400, viewport.width - margin * 2))
  const height = Math.max(300, Math.min(680, viewport.height - margin * 2))
  const onRight = orbPosition.value.x + orbSize + gap + width <= viewport.width - margin
  const left = onRight
    ? orbPosition.value.x + orbSize + gap
    : Math.max(margin, orbPosition.value.x - gap - width)
  const top = Math.min(
    Math.max(margin, orbPosition.value.y + orbSize / 2 - height / 2),
    Math.max(margin, viewport.height - height - margin)
  )
  return { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` }
})

function onResize() {
  viewport.width = window.innerWidth
  viewport.height = window.innerHeight
}
async function toggleDrawer() {
  if (agent.ui.drawerOpen) {
    closeDrawer()
    return
  }
  try { await agent.initialize() } catch { /* Drawer presents the real agent error state if initialization is unavailable. */ }
  agent.setDrawerOpen(true)
}
function closeDrawer() { agent.setDrawerOpen(false) }

watch(() => props.locked, locked => { if (locked) emit('dragging-change', false) })
// Agent 抽屉是 HTML 浮层，而店铺页是原生 WebContentsView（永远画在 HTML 之上）：
// 抽屉打开期间必须摘除视图挂载，否则与视口重叠的部分被整块盖住。
// `reason:'agent'` 这条通路主进程早就实现好了，但一直没有调用方（活代码里只有死掉的旧工作台），
// 等于实现空转（2026-09-28 审查确认）。
watch(() => agent.ui.drawerOpen, open => {
  if (window.shopilot) void window.shopilot.browser.setViewsObscured(!!open, 'agent')
}, { immediate: true })
onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  emit('dragging-change', false)
  if (window.shopilot) void window.shopilot.browser.setViewsObscured(false, 'agent')
})
</script>

<style scoped>
.agent-dock { position: fixed; inset: 0; z-index: 99; pointer-events: none; }
.agent-flyout {
  position: absolute;
  pointer-events: auto;
  overflow: hidden;
  border: 1px solid rgba(147, 153, 190, .42);
  border-radius: 13px;
  background: var(--color-bg-secondary);
  box-shadow: 0 16px 54px rgba(0, 0, 0, .48), 0 0 0 1px rgba(255, 255, 255, .035);
  -webkit-app-region: no-drag;
}
</style>
