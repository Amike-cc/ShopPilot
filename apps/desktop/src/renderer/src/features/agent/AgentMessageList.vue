<template>
  <div class="agent-message-list" aria-live="polite">
    <div v-if="!messages.length" class="agent-empty">
      <span class="agent-empty-mark"><img :src="assistantIcon" alt="" /></span>
      <strong>和 root-ceo 直接对话</strong>
      <p>可以询问店铺、商品、任务和当前页面。执行动作会在时间线中显示状态、证据与人工确认门禁。</p>
    </div>
    <template v-for="(item, index) in timeline" :key="'thoughtGroup' in item ? `thought-${index}` : item.id">
      <section v-if="'thoughtGroup' in item" class="thought-group">
        <button type="button" class="thought-toggle" :aria-expanded="expandedThoughts[index]" @click="toggleThought(index)">
          <span class="timeline-dot"><img :src="timelineIcon" alt="" /></span>
          <span><strong>已分析 {{ item.thoughtGroup.length }} 步</strong><small>{{ expandedThoughts[index] ? '收起分析过程' : '展开查看' }}</small></span>
          <span class="chevron">{{ expandedThoughts[index] ? '⌃' : '⌄' }}</span>
        </button>
        <div v-if="expandedThoughts[index]" class="thought-items"><p v-for="thought in item.thoughtGroup" :key="thought.id || thought.text" class="thought-item">{{ thought.text }}</p></div>
      </section>
      <article v-else class="timeline-item" :class="[item.role, messageTone(item)]">
        <div class="timeline-rail"><span class="timeline-dot"><span v-if="item.role === 'user'">你</span><img v-else :src="assistantIcon" alt="" /></span></div>
        <div class="message-card"><div class="message-head"><strong>{{ messageRoleLabel(item) }}</strong><time>{{ formatTime(item.at || 0) }}</time></div><div class="message-text">{{ item.text }}</div><div v-if="item.meta" class="message-meta">{{ item.meta }}</div></div>
      </article>
    </template>
    <div v-if="busy" class="running-card" role="status"><span class="running-icon"><i></i><i></i><i></i></span><span><strong>{{ statusLabel }}</strong><small>root-ceo 正在处理当前会话</small></span></div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue'
import { groupThoughtMessages, messageRoleLabel, messageTone, type ConversationMessage } from './conversation-state'
import assistantIcon from '../../assets/generated/ai-assistant-generated.png'
import timelineIcon from '../../assets/generated/ui-icons/timeline.png'
type Message = ConversationMessage & { id: string; at: number }
const props = defineProps<{ messages: Message[]; busy: boolean; statusLabel: string }>()
const expandedThoughts = reactive<Record<number, boolean>>({})
const timeline = computed(() => groupThoughtMessages(props.messages))
function toggleThought(index: number) { expandedThoughts[index] = !expandedThoughts[index] }
function formatTime(at: number) { return at ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(at)) : '' }
</script>

<style scoped>
.agent-message-list { display:flex;flex-direction:column;gap:10px;min-height:100%;padding:16px 14px 10px; }
.agent-empty { margin:auto 4px;max-width:280px;text-align:center;color:var(--color-text-secondary); }.agent-empty-mark { display:grid;place-items:center;margin:0 auto 12px;width:46px;height:46px;overflow:hidden;border-radius:15px;background:linear-gradient(145deg,rgba(38,137,245,.28),rgba(154,75,232,.3));box-shadow:0 8px 30px rgba(77,62,172,.2); }.agent-empty-mark img { width:46px;height:46px;object-fit:contain; }.agent-empty strong { color:var(--color-text-primary);font-size:14px; }.agent-empty p { font-size:12px;line-height:1.65; }
.timeline-item { display:flex;align-items:flex-start;gap:9px;max-width:100%; }.timeline-item.user { flex-direction:row-reverse; }.timeline-item.user .message-card { background:rgba(82,99,205,.16);border-color:rgba(113,127,220,.35); }.timeline-rail { flex:0 0 26px;position:relative;display:flex;justify-content:center;padding-top:2px; }.timeline-rail::after { content:'';position:absolute;top:29px;bottom:-12px;width:1px;background:#e9edf5; }.timeline-dot { display:grid;place-items:center;width:25px;height:25px;overflow:hidden;border-radius:9px;background:#3b3f60;color:#e7e8f2;font-size:10px;font-weight:700; }.timeline-dot img { width:25px;height:25px;object-fit:contain; }.assistant .timeline-dot { background:linear-gradient(145deg,#287de0,#8052d8);color:#fff;font-size:14px; }.message-card { min-width:0;max-width:calc(100% - 34px);padding:9px 11px;border:1px solid var(--color-border);border-radius:5px 12px 12px;background:#f7f9fd;overflow-wrap:anywhere; }.user .message-card { border-radius:12px 5px 12px 12px; }.message-head { display:flex;align-items:center;gap:7px;margin-bottom:4px;color:var(--color-text-secondary);font-size:10px; }.message-head time { margin-left:auto;color:var(--color-text-muted);font-size:9px;font-weight:400; }.message-text { white-space:pre-wrap;color:var(--color-text-primary);font-size:12px;line-height:1.6; }.message-meta { margin-top:5px;color:var(--color-text-muted);font-size:9px;letter-spacing:.02em; }
.timeline-item.success .message-card { border-color:rgba(91,195,149,.34); }.timeline-item.danger .message-card { border-color:rgba(224,116,116,.42);background:rgba(164,65,65,.08); }.timeline-item.pending .message-card { border-color:rgba(224,184,88,.42);background:rgba(171,129,40,.08); }
.thought-group { margin:1px 0 2px 35px;border:1px dashed rgba(150,136,255,.3);border-radius:10px;background:rgba(150,136,255,.04); }.thought-toggle { display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:0;background:transparent;color:var(--color-text-secondary);text-align:left;cursor:pointer; }.thought-toggle strong { display:block;color:#5b3df5;font-size:10px; }.thought-toggle small { display:block;margin-top:2px;color:var(--color-text-muted);font-size:9px; }.thought-toggle .chevron { margin-left:auto;color:#5b3df5;font-size:14px; }.thought-group .timeline-dot { background:rgba(150,136,255,.15);color:#4c1d95;font-size:13px; }.thought-items { padding:0 10px 8px 42px; }.thought-item { margin:5px 0;color:var(--color-text-muted);font-size:10px;line-height:1.5; }
.running-card { display:flex;align-items:center;gap:9px;margin:3px 0 0 35px;padding:8px 10px;border:1px solid rgba(126,110,226,.28);border-radius:9px;background:rgba(126,110,226,.07);color:var(--color-text-secondary); }.running-card strong { display:block;color:#5b3df5;font-size:11px; }.running-card small { display:block;margin-top:2px;color:var(--color-text-muted);font-size:9px; }.running-icon { display:flex;align-items:center;gap:3px; }.running-icon i { width:4px;height:4px;border-radius:50%;background:#9688ff;animation:dot 1s infinite alternate; }.running-icon i:nth-child(2) { animation-delay:.2s }.running-icon i:nth-child(3) { animation-delay:.4s } @keyframes dot { to { opacity:.3;transform:translateY(-3px) } }
</style>
