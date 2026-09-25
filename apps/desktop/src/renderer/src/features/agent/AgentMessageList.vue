<template>
  <div class="agent-message-list" aria-live="polite">
    <div v-if="!messages.length" class="agent-empty">
      <span class="agent-empty-mark">✦</span>
      <strong>直接对话，不必先打开店铺</strong>
      <p>问软件里的店铺/任务、或描述页面任务都可以。页面任务会先观察当前页面生成计划，再由子 Agent 执行；没有打开店铺时只对话，不会执行任何动作。</p>
    </div>
    <div v-for="message in messages" :key="message.id" class="agent-message" :class="[message.role, { thought: message.thought }]">
      <div class="message-avatar">{{ message.role === 'user' ? '我' : message.thought ? '💭' : '✦' }}</div>
      <div class="message-bubble">
        <div class="message-role">{{ message.role === 'user' ? '你' : message.thought ? '思考' : '智能体' }}</div>
        <div class="message-text">{{ message.text }}</div>
      </div>
    </div>
    <div v-if="busy" class="agent-thinking"><span></span><span></span><span></span> {{ statusLabel }}</div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; at: number; thought?: boolean }>; busy: boolean; statusLabel: string }>()
</script>

<style scoped>
.agent-message-list { display:flex;flex-direction:column;gap:14px;min-height:100%;padding:16px 14px 10px; }
.agent-empty { margin:auto 4px;max-width:270px;text-align:center;color:var(--color-text-secondary); }
.agent-empty-mark { display:grid;place-items:center;margin:0 auto 12px;width:42px;height:42px;border-radius:14px;color:#c9c1ff;background:linear-gradient(145deg,rgba(38,137,245,.2),rgba(154,75,232,.2));font-size:24px; }
.agent-empty strong { color:var(--color-text-primary);font-size:14px; }
.agent-empty p { font-size:12px;line-height:1.65; }
.agent-message { display:flex;align-items:flex-start;gap:8px;max-width:100%; }
.agent-message.user { flex-direction:row-reverse; }
.message-avatar { display:grid;place-items:center;flex:0 0 26px;height:26px;border-radius:9px;background:#3b3f60;color:#e7e8f2;font-size:11px; }
.assistant .message-avatar { background:linear-gradient(145deg,#287de0,#8052d8);color:#fff;font-size:15px; }
.message-bubble { max-width:calc(100% - 34px);padding:9px 11px;border:1px solid var(--color-border);border-radius:4px 12px 12px;background:rgba(255,255,255,.035);overflow-wrap:anywhere; }
.user .message-bubble { border-radius:12px 4px 12px 12px;background:rgba(82,99,205,.16); }
.message-role { margin-bottom:4px;color:var(--color-text-secondary);font-size:10px;font-weight:700; }
.message-text { white-space:pre-wrap;color:var(--color-text-primary);font-size:12px;line-height:1.6; }
.agent-thinking { display:flex;align-items:center;gap:4px;color:var(--color-text-secondary);font-size:11px;padding:6px 36px; }
.agent-thinking span { width:4px;height:4px;border-radius:50%;background:#9688ff;animation:dot 1s infinite alternate; }
.agent-thinking span:nth-child(2) { animation-delay:.2s }.agent-thinking span:nth-child(3) { animation-delay:.4s }
.agent-message.thought .message-bubble { border-style:dashed;opacity:.82;background:transparent; }
.agent-message.thought .message-avatar { background:rgba(255,255,255,.06);color:#c9c1ff;font-size:13px; }
@keyframes dot { to { opacity:.3;transform:translateY(-3px) } }
</style>
