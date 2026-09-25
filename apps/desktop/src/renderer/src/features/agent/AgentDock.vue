<template>
  <div v-if="!props.locked" class="agent-dock" data-test="agent-dock">
    <AgentOrb
      :needs-confirmation="props.needsConfirmation || agent.needsConfirmation"
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
        :store-name="props.storeName"
        :tab-title="props.tabTitle"
        :current-url="props.currentUrl"
        @close="closeDrawer"
        @view-tasks="viewTasks"
        @view-task="viewTask"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useAgentStore } from '../../stores/agent'
import AgentDrawer from './AgentDrawer.vue'
import AgentOrb from './AgentOrb.vue'

const props = defineProps<{
  storeName: string
  tabTitle: string
  currentUrl: string
  needsConfirmation?: boolean
  locked?: boolean
}>()
const emit = defineEmits<{
  'view-tasks': []
  'view-task': [taskId?: string]
  'dragging-change': [dragging: boolean]
}>()
const agent = useAgentStore()
const viewport = reactive({ width: window.innerWidth, height: window.innerHeight })
const orbPosition = ref({ x: 0, y: 0 })

const drawerStyle = computed(() => {
  const margin = 12
  const gap = 12
  const orbSize = 54
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
  // Agent 是软件级的；每次展开都从 Main 重新读取店铺、标签页和任务摘要，
  // 不把上一次打开时的店铺上下文当成会话绑定。
  await agent.refreshSoftwareContext()
  agent.setDrawerOpen(true)
}
function closeDrawer() { agent.setDrawerOpen(false) }
function viewTasks() {
  closeDrawer()
  emit('view-tasks')
}
function viewTask(taskId?: string) {
  closeDrawer()
  emit('view-task', taskId)
}

watch(() => props.locked, locked => { if (locked) emit('dragging-change', false) })
onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  emit('dragging-change', false)
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
