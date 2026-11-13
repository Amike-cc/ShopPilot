<template>
  <section class="assistant-page" data-test="unified-assistant-page">
    <header class="assistant-page-head">
      <div>
        <span class="dashboard-eyebrow">WORKSPACE / AI ASSISTANT</span>
        <h1>AI 电商助手</h1>
        <p>纯文本对话：讨论问题、整理思路、给出手动操作建议；不会读取或操作店铺、网页与任务数据。</p>
      </div>
      <AiToolSettings title="AI 电商助手 · 模型设置" :sections="['text']" />
    </header>
    <div class="assistant-page-panel">
      <AgentDrawer embedded title="AI 电商助手" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import AgentDrawer from '../agent/AgentDrawer.vue'
import AiToolSettings from './AiToolSettings.vue'
import { useAgentStore } from '../../stores/agent'

const agent = useAgentStore()

onMounted(() => {
  // 页面本身就是助手的完整形态；读取失败的真正错误由对话区展示，不在页面上假装在线。
  void agent.initialize().catch(() => undefined)
})
</script>

<style scoped>
.assistant-page{display:flex;min-width:0;min-height:0;flex:1;flex-direction:column;padding:22px 24px 24px;gap:14px;color:var(--dash-text)}
.assistant-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}
.assistant-page-head h1{margin:5px 0 7px;font-size:25px}
.assistant-page-head p{max-width:760px;margin:0;color:var(--dash-text-muted);font-size:12px;line-height:1.6}
.assistant-page-panel{flex:1;min-height:0;overflow:hidden;border:1px solid var(--ui-border);border-radius:var(--r-lg);background:var(--ui-surface);box-shadow:var(--e1)}
@media(max-width:880px){.assistant-page{padding:16px}.assistant-page-head h1{font-size:21px}}
</style>
