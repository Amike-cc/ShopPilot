<template>
  <div ref="host" class="agent-orb-host">
    <button
      ref="button"
      class="agent-orb"
      :class="{ 'needs-confirm': props.needsConfirmation, dragging }"
      :style="{ left: `${position.x}px`, top: `${position.y}px` }"
      type="button"
      :aria-label="props.needsConfirmation ? `智能体，${props.expanded ? '收起对话框' : '打开对话框'}，有任务等待人工确认` : `智能体，${props.expanded ? '收起对话框' : '打开对话框'}`"
      :aria-expanded="props.expanded"
      :title="props.needsConfirmation ? `智能体 · ${props.expanded ? '收起对话框' : '打开对话框'} · 有任务等待人工确认` : `智能体 · ${props.expanded ? '收起对话框' : '打开对话框'}（可拖动）`"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @click="onClick"
    >
      <svg class="orb-sparkle" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2.5 14.6 9.4 21.5 12l-6.9 2.6L12 21.5l-2.6-6.9L2.5 12l6.9-2.6L12 2.5Z" fill="currentColor" />
        <path d="m19 2 .8 2.2L22 5l-2.2.8L19 8l-.8-2.2L16 5l2.2-.8L19 2Z" fill="currentColor" opacity=".8" />
      </svg>
      <span class="orb-ai">AI</span>
      <span v-if="props.needsConfirmation" class="orb-alert" aria-hidden="true">!</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useAgentStore } from '../../stores/agent'
import { clampOrbPoint, isOrbDrag, snapOrbToNearestEdge } from './orb-geometry'

const props = defineProps<{ needsConfirmation?: boolean; expanded?: boolean }>()
const emit = defineEmits<{
  toggle: []
  'drag-start': []
  'drag-end': []
  'position-change': [position: { x: number; y: number }]
}>()
const agent = useAgentStore()
const host = ref<HTMLElement | null>(null)
const button = ref<HTMLButtonElement | null>(null)
const position = reactive({ x: 0, y: 0 })
const dragging = ref(false)
let resizeObserver: ResizeObserver | null = null
let pointerStart: { id: number; x: number; y: number; left: number; top: number } | null = null
let didDrag = false
let suppressClick = false

function bounds() {
  const rect = host.value?.getBoundingClientRect()
  const size = button.value?.offsetWidth || 52
  return { width: Math.max(0, (rect?.width || 0) - size), height: Math.max(0, (rect?.height || 0) - size) }
}
function emitPosition() { emit('position-change', { x: position.x, y: position.y }) }
function applySavedPosition() {
  const max = bounds()
  const saved = clampOrbPoint({ x: agent.ui.orbPosition.x * max.width, y: agent.ui.orbPosition.y * max.height }, { x: max.width, y: max.height })
  position.x = saved.x
  position.y = saved.y
  emitPosition()
  const normalized = { x: max.width ? position.x / max.width : 0.5, y: max.height ? position.y / max.height : 0.5 }
  if (Math.abs(agent.ui.orbPosition.x - normalized.x) > 0.001 || Math.abs(agent.ui.orbPosition.y - normalized.y) > 0.001) {
    agent.setOrbPosition(normalized)
  }
}
function onPointerDown(event: PointerEvent) {
  if (event.button !== 0 || !button.value) return
  pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY, left: position.x, top: position.y }
  didDrag = false
  button.value.setPointerCapture(event.pointerId)
}
function onPointerMove(event: PointerEvent) {
  if (!pointerStart || pointerStart.id !== event.pointerId) return
  const dx = event.clientX - pointerStart.x
  const dy = event.clientY - pointerStart.y
  if (!didDrag && isOrbDrag(dx, dy, 6)) {
    didDrag = true
    dragging.value = true
    emit('drag-start')
  }
  if (!didDrag) return
  event.preventDefault()
  const max = bounds()
  const clamped = clampOrbPoint({ x: pointerStart.left + dx, y: pointerStart.top + dy }, { x: max.width, y: max.height })
  position.x = clamped.x
  position.y = clamped.y
  emitPosition()
}
function finishPointer(event: PointerEvent) {
  if (!pointerStart || pointerStart.id !== event.pointerId) return
  const wasDrag = didDrag
  if (wasDrag) {
    const max = bounds()
    const nearest = snapOrbToNearestEdge({ x: position.x, y: position.y }, { x: max.width, y: max.height })
    position.x = nearest.x; position.y = nearest.y
    agent.setOrbPosition({ x: max.width ? position.x / max.width : 0.5, y: max.height ? position.y / max.height : 0.5 })
    emitPosition()
    suppressClick = true
  }
  pointerStart = null; didDrag = false; dragging.value = false
  if (wasDrag) emit('drag-end')
}
function onPointerUp(event: PointerEvent) { finishPointer(event) }
function onPointerCancel(event: PointerEvent) { finishPointer(event) }
function onClick() {
  if (suppressClick) { suppressClick = false; return }
  emit('toggle')
}
function onWindowResize() { applySavedPosition() }

watch(() => agent.ui.orbPosition, () => applySavedPosition(), { deep: true })
onMounted(async () => {
  await nextTick()
  applySavedPosition()
  if (host.value) { resizeObserver = new ResizeObserver(onWindowResize); resizeObserver.observe(host.value) }
  window.addEventListener('resize', onWindowResize)
})
onBeforeUnmount(() => { resizeObserver?.disconnect(); window.removeEventListener('resize', onWindowResize) })
</script>

<style scoped>
.agent-orb-host { position: absolute; inset: 0; z-index: 1; pointer-events: none; overflow: visible; }
.agent-orb { position: absolute; width: 54px; height: 54px; border: 1px solid rgba(255,255,255,.72); border-radius: 50%; color: #fff; background: linear-gradient(145deg,#2689f5 0%,#6059e9 54%,#9a4be8 100%); box-shadow: 0 5px 20px rgba(79,86,230,.4),0 0 18px rgba(106,99,255,.28); display:flex;align-items:center;justify-content:center;cursor:grab;touch-action:none;pointer-events:auto;-webkit-app-region:no-drag;transition:box-shadow .18s,transform .18s; }
.agent-orb:hover { transform: translateY(-1px); box-shadow: 0 7px 24px rgba(79,86,230,.5),0 0 23px rgba(106,99,255,.4); }
.agent-orb:focus-visible { outline: 2px solid #b6e0ff; outline-offset: 3px; }
.agent-orb.dragging { cursor:grabbing;transition:none; }
.orb-sparkle { width:25px;height:25px;filter:drop-shadow(0 1px 3px rgba(0,0,0,.22)); }
.orb-ai { position:absolute;right:-3px;bottom:-1px;border:1px solid rgba(255,255,255,.9);border-radius:7px;background:#2b2d66;padding:1px 4px;font-size:8px;font-weight:800;line-height:12px;letter-spacing:.3px; }
.orb-alert { position:absolute;right:-3px;top:-4px;width:17px;height:17px;border:2px solid #24253c;border-radius:50%;background:#f5b942;color:#30230a;font-size:11px;font-weight:900;line-height:13px;box-shadow:0 0 10px rgba(245,185,66,.75);animation:agent-pulse 1.4s ease-in-out infinite; }
.needs-confirm { border-color:#ffd476;box-shadow:0 0 0 2px rgba(245,185,66,.55),0 0 22px rgba(245,185,66,.35); }
@keyframes agent-pulse { 50% { transform:scale(1.14);box-shadow:0 0 15px rgba(245,185,66,.9); } }
</style>
