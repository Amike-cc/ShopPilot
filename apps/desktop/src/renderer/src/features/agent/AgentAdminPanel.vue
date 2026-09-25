<template>
  <section class="agent-admin" data-test="agent-admin-panel">
    <div class="agent-admin-tabs">
      <button v-for="tab in tabs" :key="tab.key" :class="['admin-tab', { on: activeTab === tab.key }]" @click="activeTab = tab.key">{{ tab.label }}</button>
    </div>

    <div v-if="activeTab === 'team'" class="admin-scroll" data-test="agent-org-panel">
      <div class="admin-head"><div><b>组织树</b><span>root-ceo 是唯一固定主 Agent；HR 使用 root-ceo + mode=hr。主 Agent 使用“设置 → AI 配置”，子 Agent 未绑定模型时自动继承该配置。</span></div><button class="mini-btn" @click="loadAll">刷新</button></div>
      <div class="admin-note">probation 只能接收只读试用 Job。激活、暂停、恢复和退休都需要用户确认；退休 Agent 不会复活。</div>
      <div v-for="item in agents" :key="item.id" class="admin-card" :data-test="`agent-card-${item.id}`">
        <div class="admin-card-head"><strong>{{ item.name }}</strong><span :class="['status-pill', item.status]">{{ item.status }}</span></div>
        <div class="admin-meta">{{ item.id }} · {{ item.role }} · parent={{ item.parentId || '—' }}</div>
        <div class="admin-meta">模型：{{ item.modelProfileId || (item.id === 'root-ceo' ? '主 Agent AI 配置' : '继承主 Agent AI 配置') }} · 店铺：{{ item.storeScope?.storeIds?.length ? item.storeScope.storeIds.join('、') : '全部（由 Main 再校验）' }} · 范围：{{ item.storeScope?.readOnly === false ? '可写' : '只读' }}</div>
        <div class="admin-meta">能力：{{ item.toolPolicy?.tools?.join('、') || '无' }} · 记忆：{{ item.memoryScope?.write ? '可写' : '只读' }}{{ item.memoryScope?.includeShared ? '，含共享' : '' }}</div>
        <div class="admin-form-row"><select v-if="item.id !== 'root-ceo'" :value="item.modelProfileId || ''" @change="bindModel(item.id, eventValue($event) || null)"><option value="">继承主 Agent AI 配置</option><option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}（{{ profile.model }}）</option></select><span v-else class="admin-inherited-model">由“设置 → AI 配置”管理</span><input :value="agentDraft(item).maxConcurrency" type="number" min="1" max="32" @input="agentDraft(item).maxConcurrency = Number(eventValue($event))" /><input v-model="agentDraft(item).budgetAmount" type="number" min="0" placeholder="日预算" /></div>
        <div class="admin-form-row"><input v-model="agentDraft(item).budgetCurrency" maxlength="8" placeholder="预算单位，如 tokens" /><input v-model="agentDraft(item).storeIds" maxlength="600" placeholder="店铺 ID，逗号分隔；留空=全部" /><button class="mini-btn" @click="saveAgentConfig(item)">保存 Agent 配置</button></div>
        <div class="capability-row"><label v-if="item.id !== 'root-ceo'"><input v-model="agentDraft(item).storeReadOnly" type="checkbox" /> 只读范围（关闭后才能接收写操作 Job）</label><label v-for="tool in TOOL_OPTIONS" :key="tool"><input v-model="agentDraft(item).tools" type="checkbox" :value="tool" /> {{ tool }}</label><label><input v-model="agentDraft(item).memoryWrite" type="checkbox" /> memory_write</label><label><input v-model="agentDraft(item).memoryIncludeShared" type="checkbox" /> include_shared</label></div>
        <div class="admin-actions" v-if="item.id !== 'root-ceo'">
          <button v-if="item.status === 'probation'" class="mini-btn primary" @click="changeStatus(item, 'activate')">用户确认激活</button>
          <button v-if="item.status === 'active'" class="mini-btn" @click="changeStatus(item, 'pause')">暂停</button>
          <button v-if="item.status === 'paused'" class="mini-btn" @click="changeStatus(item, 'resume')">恢复</button>
          <button v-if="item.status !== 'retired'" class="mini-btn danger-btn" @click="changeStatus(item, 'retire')">退休</button>
        </div>
      </div>
      <div class="admin-create">
        <b>HR 岗位预览 / 创建 probation</b>
        <div class="admin-form-row"><select v-model="newAgent.role"><option value="operator">商品运营</option><option value="analyst">数据分析</option><option value="reviewer">审核 Agent</option><option value="content">内容文案</option><option value="support">客服质检</option></select><button class="mini-btn" @click="previewRole">预览岗位卡</button></div>
        <div v-if="hrPreview" class="admin-note">{{ hrPreview.name }}：{{ hrPreview.description }}；禁止：{{ (hrPreview.prohibitedTools || []).join('、') }}</div>
        <input v-model="newAgent.name" placeholder="Agent 名称" maxlength="120" />
        <textarea v-model="newAgent.description" placeholder="岗位描述" maxlength="1000" rows="2" />
        <div class="admin-form-row"><select v-model="newAgent.modelProfileId"><option value="">未配置，继承主 Agent AI 配置</option><option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}（{{ profile.model }}）</option></select><input v-model.number="newAgent.maxConcurrency" type="number" min="1" max="32" placeholder="最大并发" /></div>
        <div class="admin-form-row"><input v-model="newAgent.budgetCurrency" maxlength="8" placeholder="预算单位" /><input v-model="newAgent.budgetAmount" type="number" min="0" placeholder="日预算（可选）" /><input v-model="newAgent.storeIds" maxlength="600" placeholder="店铺 ID（可选）" /></div>
        <label class="admin-check"><input v-model="newAgent.storeReadOnly" type="checkbox" /> 只读范围（试用/巡检；激活后可在上方 Agent 卡片里关闭）</label>
        <button class="mini-btn primary" :disabled="!newAgent.name.trim()" @click="createProbation">确认创建 probation</button>
      </div>
    </div>

    <div v-else-if="activeTab === 'models'" class="admin-scroll" data-test="agent-model-panel">
      <div class="admin-head"><div><b>模型 Profile</b><span>Renderer 只收到 hasKey；API Key 由 Main safeStorage 保存。</span></div><button class="mini-btn" @click="loadModels">刷新</button></div>
      <div v-for="profile in profiles" :key="profile.id" class="admin-card">
        <div class="admin-card-head"><strong>{{ profile.name }}</strong><span :class="['status-pill', profile.health]">{{ profile.health }}</span></div>
        <div class="admin-meta">{{ profile.id }} · {{ profile.provider }} · {{ profile.model }}</div>
        <div class="admin-meta">endpoint={{ profile.endpoint }} · Key={{ profile.hasKey ? '已配置' : '未配置' }} · 并发={{ profile.concurrencyLimit }} · enabled={{ profile.enabled }} · 价格={{ profile.pricing ? `${profile.pricing.inputPerMTok}/${profile.pricing.outputPerMTok} ${profile.pricing.currency}/百万 token` : '未配置（未估算）' }}</div>
        <div class="admin-actions"><button class="mini-btn" @click="testModel(profile.id)">真实测试</button><button class="mini-btn" @click="editModel(profile)">编辑</button><button v-if="profile.hasKey" class="mini-btn" @click="clearModelKey(profile)">清除 Key</button><button v-if="profile.id !== 'model_default-main'" class="mini-btn danger-btn" @click="deleteModel(profile.id)">删除</button></div>
      </div>
      <div class="admin-create">
        <b>新增 / 更新 Profile</b>
        <input v-model="modelDraft.name" placeholder="名称" maxlength="120" />
        <div class="admin-form-row"><input v-model="modelDraft.provider" placeholder="服务商" maxlength="80" /><input v-model="modelDraft.model" placeholder="模型名" maxlength="160" /></div>
        <input v-model="modelDraft.endpoint" placeholder="https://.../v1 或 /chat/completions" spellcheck="false" />
        <div class="admin-form-row"><input v-model.number="modelDraft.timeoutMs" type="number" min="1000" max="3600000" /><input v-model.number="modelDraft.concurrencyLimit" type="number" min="1" max="64" placeholder="并发上限" /></div>
        <div class="admin-form-row"><input v-model.number="modelDraft.temperature" type="number" min="0" max="2" step="0.1" placeholder="temperature" /><input v-model.number="modelDraft.maxTokens" type="number" min="16" max="128000" placeholder="max tokens" /><label class="admin-check"><input v-model="modelDraft.enabled" type="checkbox" /> enabled</label></div>
        <div class="admin-form-row"><select v-model="modelDraft.fallbackProfileId"><option value="">不配置备用 Profile</option><option v-for="profile in profiles" :key="profile.id" :value="profile.id">备用：{{ profile.name }}</option></select><input v-model="modelDraft.apiKey" type="password" autocomplete="new-password" placeholder="API Key（只发往 Main）" /></div>
        <div class="admin-form-row"><input v-model="modelDraft.budgetCurrency" maxlength="8" placeholder="预算单位，如 tokens" /><input v-model="modelDraft.budgetAmount" type="number" min="0" placeholder="日预算（可选）" /><input v-model="modelDraft.pricingCurrency" maxlength="8" placeholder="价格币种，如 USD" /></div>
        <div class="admin-form-row"><input v-model="modelDraft.inputPerMTok" type="number" min="0" step="0.01" placeholder="输入价 / 百万 token（可选）" /><input v-model="modelDraft.outputPerMTok" type="number" min="0" step="0.01" placeholder="输出价 / 百万 token（可选）" /><span class="admin-inherited-model">留空 = 未估算成本</span></div>
        <div class="capability-row"><label><input v-model="modelDraft.capabilities.chat" type="checkbox" /> chat</label><label><input v-model="modelDraft.capabilities.json" type="checkbox" /> JSON</label><label><input v-model="modelDraft.capabilities.vision" type="checkbox" /> vision</label><label><input v-model="modelDraft.capabilities.cancellation" type="checkbox" /> cancel</label></div>
        <button class="mini-btn primary" :disabled="!modelDraft.name || !modelDraft.endpoint || !modelDraft.model" @click="saveModel">保存 Profile</button>
      </div>
    </div>

    <div v-else-if="activeTab === 'memory'" class="admin-scroll" data-test="agent-memory-panel">
      <div class="admin-head"><div><b>本地记忆库</b><span>正文不直接推到 Renderer；未审核记忆不能进入长期规则。</span></div><div class="admin-actions"><button class="mini-btn" @click="rebuildMemory">重建索引</button><button class="mini-btn" @click="snapshotMemory">加密快照</button></div></div>
      <div class="admin-form-row"><input v-model="snapshotPath" placeholder="已有加密快照路径（可选）" spellcheck="false" /><button class="mini-btn" :disabled="!snapshotPath" @click="inspectSnapshot">校验</button><button class="mini-btn danger-btn" :disabled="!snapshotPath" @click="restoreSnapshot">确认恢复</button></div>
      <div class="admin-form-row"><input v-model="memoryQuery" placeholder="中文关键词检索" @keyup.enter="searchMemory" /><select v-model="memoryStatus" @change="loadMemories"><option value="">长期可用 / 待审核</option><option value="pending-review">待审核</option><option value="approved">已批准</option><option value="stale">已过期</option><option value="conflict">冲突版本</option><option value="quarantined">隔离</option></select><button class="mini-btn primary" :disabled="!!memoryStatus" @click="searchMemory">搜索</button></div>
      <div v-if="memoryMessage" class="admin-note">{{ memoryMessage }}</div>
      <div v-for="memory in memories" :key="memory.id" class="admin-card">
        <div class="admin-card-head"><strong>{{ memory.title }}</strong><span :class="['status-pill', memory.status]">{{ memory.status }}</span></div>
        <div class="admin-meta">{{ memory.id }} · {{ memory.type }} · agent={{ memory.agentId }} · store={{ memory.storeId || 'shared' }}</div>
        <div class="admin-meta">confidence={{ memory.confidence }} · hash={{ memory.contentHash.slice(0, 12) }} · sourceJob={{ memory.sourceJobId || '—' }}</div>
        <button v-if="memory.status === 'pending-review'" class="mini-btn primary" @click="reviewMemory(memory.id, 'approved')">批准进入长期记忆</button>
        <button v-if="memory.status !== 'stale'" class="mini-btn" @click="reviewMemory(memory.id, 'stale')">标记过期</button>
      </div>
      <div v-if="!memories.length" class="admin-empty">暂无符合范围的记忆摘要</div>
    </div>

    <div v-else-if="activeTab === 'skills'" class="admin-scroll" data-test="agent-skill-panel">
      <div class="admin-head"><div><b>技能与插件</b><span>技能是现有工具的声明式组合，不含脚本、Shell 或新权限；分享包只包含这些定义。</span></div><button class="mini-btn" @click="loadSkillLibrary">刷新</button></div>
      <div v-if="skillMessage" class="admin-note" data-test="agent-skill-message">{{ skillMessage }}</div>
      <div class="admin-create">
        <b>导出 JSON 分享包</b>
        <div class="admin-form-row"><input v-model="exportSkillNames" maxlength="600" placeholder="技能名称，逗号分隔；留空=全部" /><button class="mini-btn primary" data-test="agent-skill-export-btn" @click="exportPack">生成分享包</button><button class="mini-btn" :disabled="!exportJson" @click="copyExport">复制</button></div>
        <textarea v-model="exportJson" data-test="agent-skill-export" rows="4" readonly spellcheck="false" placeholder="点击“生成分享包”后出现 JSON" />
      </div>
      <div class="admin-create">
        <b>导入 JSON 分享包</b>
        <textarea v-model="importJson" data-test="agent-skill-import" rows="4" spellcheck="false" placeholder="把分享包 JSON 粘贴到这里；同名技能/插件会被更新" />
        <button class="mini-btn primary" data-test="agent-skill-import-btn" :disabled="!importJson.trim()" @click="importPack">确认导入</button>
      </div>
      <div v-for="skill in skillLibrary.skills" :key="skill.id" class="admin-card" :data-test="`agent-skill-${skill.name}`">
        <div class="admin-card-head"><strong>{{ skill.name }}</strong><span :class="['status-pill', skill.status]">{{ skill.status }}</span></div>
        <div class="admin-meta">{{ skill.id }} · {{ skill.source }} · {{ skill.steps.length }} 步 · {{ skill.pluginId ? `插件 ${skill.pluginId}` : '独立技能' }}</div>
        <div class="admin-meta">{{ skill.description || skill.intent || '无描述' }} · {{ skill.steps.map(step => step.type).join(' → ') }}</div>
        <div class="admin-actions"><button class="mini-btn" @click="exportSkillNames = skill.name; exportPack()">导出此技能</button><button class="mini-btn" @click="toggleSkill(skill)">{{ skill.status === 'enabled' ? '停用' : '启用' }}</button><button class="mini-btn danger-btn" @click="removeSkill(skill.id)">删除</button></div>
      </div>
      <div v-for="plugin in skillLibrary.plugins" :key="plugin.id" class="admin-card">
        <div class="admin-card-head"><strong>{{ plugin.name }}</strong><span class="status-pill">{{ plugin.skillIds.length }} 技能</span></div>
        <div class="admin-meta">{{ plugin.id }} · {{ plugin.source }} · {{ plugin.description || '无描述' }}</div>
      </div>
      <div v-if="!skillLibrary.skills.length && !skillLibrary.plugins.length" class="admin-empty">还没有技能或插件；可以在对话里说“帮我制作一个巡检技能”。</div>
    </div>

    <div v-else class="admin-scroll" data-test="agent-job-panel">
      <div class="admin-head"><div><b>Job 看板</b><span>状态、租约、TaskRun 和证据均来自 Main 持久化链路。</span></div><div class="admin-actions"><button class="mini-btn" @click="runQualityReview">CEO 复盘</button><button class="mini-btn" @click="loadJobs">刷新</button></div></div>
      <div v-if="qualitySummary" class="admin-note">最近复盘：{{ new Date(Number(qualitySummary.generatedAt)).toLocaleString() }}；7 日模型调用 {{ qualitySummary.usage?.calls || 0 }} 次，Token {{ Number(qualitySummary.usage?.inputTokens || 0) + Number(qualitySummary.usage?.outputTokens || 0) }}；成本 {{ qualitySummary.usage?.costStatus === 'unestimated_without_price' ? '未估算（未配置价格）' : qualitySummary.usage?.estimatedCost }}；待人工复核 {{ qualitySummary.governance?.pendingMemoryReview || 0 }} 项。</div>
      <div class="admin-create">
        <b>CEO 派发真实 Job</b>
        <div class="admin-form-row"><select v-model="newJob.assignedAgentId"><option value="">选择子 Agent</option><option v-for="agent in agents.filter(item => item.id !== 'root-ceo' && item.status !== 'retired')" :key="agent.id" :value="agent.id">{{ agent.name }}（{{ agent.status }}）</option></select><input v-model="newJob.storeId" maxlength="80" placeholder="店铺 ID（浏览器 Job 必填）" /></div>
        <input v-model="newJob.goal" maxlength="2000" placeholder="目标，例如：读取当前商品页标题并形成证据" />
        <textarea v-model="newJob.inputSummary" rows="2" placeholder="输入摘要 JSON，例如 {&quot;source&quot;:&quot;当前页面&quot;}" />
        <textarea v-model="newJob.browserTask" rows="3" placeholder="可选：浏览器 Task JSON，例如 {&quot;name&quot;:&quot;读取标题&quot;,&quot;steps&quot;:[{&quot;type&quot;:&quot;readText&quot;,&quot;input&quot;:{&quot;selector&quot;:&quot;title&quot;}}]}" />
        <label class="admin-check"><input v-model="newJob.requiresConfirmation" type="checkbox" /> 要求人工确认（高风险 Job 由 Main 强制校验）</label>
        <button class="mini-btn primary" :disabled="!newJob.assignedAgentId || !newJob.goal.trim()" @click="createJob">创建并派发 Job</button>
      </div>
      <div v-for="job in jobs" :key="job.id" class="admin-card">
        <div class="admin-card-head"><strong>{{ job.goal }}</strong><span :class="['status-pill', job.status]">{{ job.status }}</span></div>
        <div class="admin-meta">{{ job.id }} · assigned={{ job.assignedAgentId }} · store={{ job.storeId || '—' }} · risk={{ job.risk }}</div>
        <div class="admin-meta">Task={{ job.browserTaskId || 'model-only' }} · TaskRun={{ job.browserRunId || '—' }} · evidence={{ job.results?.length || 0 }}</div>
        <div class="admin-actions"><button v-if="job.status === 'queued'" class="mini-btn primary" @click="runJob(job.id)">运行</button><button v-if="['failed','recovery_required','blocked_budget','blocked_permission'].includes(job.status)" class="mini-btn primary" @click="resumeJob(job.id)">安全恢复</button><button v-if="job.status === 'waiting_confirmation'" class="mini-btn primary" @click="approveJob(job)">用户确认</button><button v-if="!['succeeded','failed','cancelled','expired'].includes(job.status)" class="mini-btn danger-btn" @click="cancelJob(job.id)">取消</button></div>
        <div v-for="result in job.results || []" :key="result.id" class="admin-result"><span>{{ result.kind }} · {{ result.approved ? '已审核' : '待审核' }}</span><button v-if="!result.approved" class="mini-btn" @click="reviewResult(result.id, true)">批准结果</button><button v-if="!result.approved" class="mini-btn danger-btn" @click="reviewResult(result.id, false)">驳回结果</button></div>
        <details v-if="job.events?.length || job.results?.length"><summary>查看状态事件和证据摘要</summary><div class="admin-event" v-for="event in job.events" :key="event.id">{{ event.fromStatus || '—' }} → {{ event.toStatus }} · {{ event.reason }}</div><div class="admin-event" v-for="result in job.results" :key="result.id">evidence {{ result.kind }} · TaskRun={{ result.taskRunId }}</div></details>
      </div>
      <div v-if="!jobs.length" class="admin-empty">暂无 Job</div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref, reactive } from 'vue'

const tabs = [
  { key: 'team', label: '组织 / HR' },
  { key: 'models', label: '模型 Profile' },
  { key: 'memory', label: '本地记忆' },
  { key: 'skills', label: '技能与插件' },
  { key: 'jobs', label: 'Job 看板' }
] as const
type AdminTab = typeof tabs[number]['key']
const TOOL_OPTIONS = ['observe_page', 'read_text', 'read_table', 'model_analyze', 'create_job', 'review_job', 'memory_search']
type AgentDraft = { maxConcurrency: number; budgetCurrency: string; budgetAmount: string; storeIds: string; storeReadOnly: boolean; memoryWrite: boolean; memoryIncludeShared: boolean; tools: string[] }
const activeTab = ref<AdminTab>('team')
const agents = ref<any[]>([])
const profiles = ref<any[]>([])
const memories = ref<any[]>([])
const jobs = ref<any[]>([])
const qualitySummary = ref<any>(null)
const hrPreview = ref<any>(null)
const memoryQuery = ref('库存')
const memoryStatus = ref('')
const memoryMessage = ref('')
const snapshotPath = ref('')
const newAgent = reactive({ role: 'operator', name: '', description: '', modelProfileId: '', maxConcurrency: 1, budgetCurrency: 'tokens', budgetAmount: '', storeIds: '', storeReadOnly: true })
const modelDraft = reactive({ id: '', name: '', provider: '', model: '', endpoint: '', timeoutMs: 30000, maxTokens: 1200, temperature: 0.7, concurrencyLimit: 1, fallbackProfileId: '', budgetCurrency: 'tokens', budgetAmount: '', pricingCurrency: 'USD', inputPerMTok: '', outputPerMTok: '', apiKey: '', enabled: true, capabilities: { chat: true, json: true, vision: false, cancellation: true } })
const agentDrafts = reactive<Record<string, AgentDraft>>({})
const newJob = reactive({ assignedAgentId: '', storeId: '', goal: '', inputSummary: '{"source":"manual"}', browserTask: '', requiresConfirmation: false })
const skillLibrary = ref<{ skills: any[]; plugins: any[] }>({ skills: [], plugins: [] })
const exportSkillNames = ref('')
const exportJson = ref('')
const importJson = ref('')
const skillMessage = ref('')

const emit = defineEmits<{ toast: [message: string, kind?: 'success' | 'error'] }>()
async function loadAgents() { const res = await window.shopilot.agentDomain.orgList({ limit: 200 }); if (res.ok) agents.value = (res.data as any).items || []; else emit('toast', res.error.message, 'error') }
async function loadModels() { const res = await window.shopilot.agentDomain.modelList({ limit: 200 }); if (res.ok) profiles.value = (res.data as any).items || []; else emit('toast', res.error.message, 'error') }
async function loadJobs() { const res = await window.shopilot.agentDomain.jobList({ limit: 50 }); if (res.ok) jobs.value = res.data.items as any[]; else emit('toast', res.error.message, 'error') }
async function runQualityReview() { const res = await window.shopilot.agentDomain.qualityReview(); if (!res.ok) return emit('toast', res.error.message, 'error'); qualitySummary.value = res.data; emit('toast', `CEO 复盘已生成：${res.data.governance?.pendingMemoryReview || 0} 项需人工复核`, 'success') }
async function loadMemories() { const res = await window.shopilot.agentDomain.memoryList({ agentId: 'root-ceo', status: memoryStatus.value || null, limit: 50 }); if (res.ok) memories.value = res.data.items as any[]; else emit('toast', res.error.message, 'error') }
async function loadAll() { await Promise.all([loadAgents(), loadModels(), loadJobs(), loadMemories(), loadSkillLibrary()]) }
async function loadSkillLibrary() { const res = await window.shopilot.agentDomain.skillList(); if (res.ok) skillLibrary.value = res.data as any; else skillMessage.value = `读取失败（${res.error.code}）：${res.error.message}` }
async function exportPack() { const names = exportSkillNames.value.split(/[,，\s]+/).map(value => value.trim()).filter(Boolean); const res = await window.shopilot.agentDomain.packExport({ skillNames: names }); if (!res.ok) { skillMessage.value = `导出失败（${res.error.code}）：${res.error.message}`; return } exportJson.value = res.data.json; skillMessage.value = `已生成分享包：${res.data.skillCount} 个技能、${res.data.pluginCount} 个插件；可复制到其他电脑导入。` }
async function copyExport() { try { await navigator.clipboard.writeText(exportJson.value); skillMessage.value = '分享包 JSON 已复制到剪贴板。' } catch { skillMessage.value = '剪贴板不可用，请手动全选复制文本框内容。' } }
async function importPack() { const res = await window.shopilot.agentDomain.packImport(importJson.value, true); if (!res.ok) { skillMessage.value = `导入失败（${res.error.code}）：${res.error.message}`; return } skillMessage.value = `导入完成：新增 ${res.data.importedSkills}，更新 ${res.data.updatedSkills}，插件 ${res.data.importedPlugins}${res.data.errors?.length ? `；注意：${res.data.errors.join('；')}` : ''}`; importJson.value = ''; await loadSkillLibrary() }
async function removeSkill(skillId: string) { if (!window.confirm('确认删除该技能？')) return; const res = await window.shopilot.agentDomain.skillDelete(skillId); if (!res.ok) { skillMessage.value = `删除失败（${res.error.code}）：${res.error.message}`; return } skillMessage.value = '技能已删除'; await loadSkillLibrary() }
async function toggleSkill(skill: any) { const next = skill.status === 'enabled' ? 'disabled' : 'enabled'; const res = await window.shopilot.agentDomain.skillUpdate({ skillId: skill.id, status: next }); if (!res.ok) { skillMessage.value = `更新失败（${res.error.code}）：${res.error.message}`; return } skillMessage.value = `技能「${res.data.name}」已${next === 'enabled' ? '启用' : '停用'}`; await loadSkillLibrary() }
function agentDraft(agent: any): AgentDraft {
  return agentDrafts[agent.id] || (agentDrafts[agent.id] = {
    maxConcurrency: Number(agent.maxConcurrency || 1),
    budgetCurrency: String(agent.dailyBudget?.currency || 'tokens'),
    budgetAmount: agent.dailyBudget?.amount == null ? '' : String(agent.dailyBudget.amount),
    storeIds: Array.isArray(agent.storeScope?.storeIds) ? agent.storeScope.storeIds.join(',') : '',
    storeReadOnly: agent.storeScope?.readOnly !== false,
    memoryWrite: !!agent.memoryScope?.write,
    memoryIncludeShared: !!agent.memoryScope?.includeShared,
    tools: Array.isArray(agent.toolPolicy?.tools) ? [...agent.toolPolicy.tools] : []
  })
}
function eventValue(event: Event): string { return String((event.target as HTMLInputElement | HTMLSelectElement | null)?.value || '') }
async function previewRole() { const res = await window.shopilot.agentDomain.hrPreview(newAgent.role); if (res.ok) hrPreview.value = res.data; else emit('toast', res.error.message, 'error') }
async function createProbation() { const amount = newAgent.budgetAmount === '' ? null : { currency: newAgent.budgetCurrency || 'tokens', amount: Number(newAgent.budgetAmount) }; const storeIds = newAgent.storeIds.split(',').map(value => value.trim()).filter(Boolean); const res = await window.shopilot.agentDomain.orgCreate({ actorAgentId: 'root-ceo', confirmed: true, name: newAgent.name, role: newAgent.role, description: newAgent.description, modelProfileId: newAgent.modelProfileId || null, maxConcurrency: Number(newAgent.maxConcurrency), dailyBudget: amount, storeScope: { storeIds, readOnly: newAgent.storeReadOnly }, memoryScope: { write: false } }); if (!res.ok) return emit('toast', res.error.message, 'error'); Object.assign(newAgent, { name: '', description: '', modelProfileId: '', maxConcurrency: 1, budgetAmount: '', storeIds: '', storeReadOnly: true }); await loadAgents(); emit('toast', 'probation Agent 已创建', 'success') }
async function bindModel(agentId: string, modelProfileId: string | null) { const res = await window.shopilot.agentDomain.modelBind(agentId, modelProfileId); if (!res.ok) return emit('toast', res.error.message, 'error'); await loadAgents(); emit('toast', modelProfileId ? 'Agent 模型已绑定' : 'Agent 已恢复继承主 Agent AI 配置', 'success') }
async function saveAgentConfig(agent: any) { const draft = agentDraft(agent); const dailyBudget = draft.budgetAmount === '' ? null : { currency: draft.budgetCurrency || 'tokens', amount: Number(draft.budgetAmount) }; const storeIds = draft.storeIds.split(',').map(value => value.trim()).filter(Boolean); if (!window.confirm(`确认保存 ${agent.name} 的模型能力、店铺范围（${draft.storeReadOnly ? '只读' : '可写'}）和记忆范围？`)) return; const res = await window.shopilot.agentDomain.orgUpdate({ actorAgentId: 'root-ceo', agentId: agent.id, confirmed: true, maxConcurrency: Number(draft.maxConcurrency), dailyBudget, storeScope: { storeIds, readOnly: draft.storeReadOnly }, memoryScope: { agentIds: [agent.id], includeShared: draft.memoryIncludeShared, write: draft.memoryWrite }, toolPolicy: { ...agent.toolPolicy, tools: draft.tools } }); if (!res.ok) return emit('toast', res.error.message, 'error'); await loadAgents(); emit('toast', 'Agent 配置已保存', 'success') }
async function changeStatus(agent: any, action: 'activate' | 'pause' | 'resume' | 'retire') { if (!window.confirm(`确认${action === 'retire' ? '退休' : action === 'pause' ? '暂停' : action === 'resume' ? '恢复' : '激活'} ${agent.name}？`)) return; const fn = action === 'activate' ? window.shopilot.agentDomain.orgActivate : action === 'pause' ? window.shopilot.agentDomain.orgPause : action === 'resume' ? window.shopilot.agentDomain.orgResume : window.shopilot.agentDomain.orgRetire; const res = await fn(agent.id, true); if (!res.ok) return emit('toast', res.error.message, 'error'); await loadAgents() }
function pricingDraft(value: any): { pricingCurrency: string; inputPerMTok: string; outputPerMTok: string } { return { pricingCurrency: value?.currency || 'USD', inputPerMTok: value?.inputPerMTok == null ? '' : String(value.inputPerMTok), outputPerMTok: value?.outputPerMTok == null ? '' : String(value.outputPerMTok) } }
function draftPricing(): { currency: string; inputPerMTok: number; outputPerMTok: number } | null { const inputPerMTok = Number(modelDraft.inputPerMTok); const outputPerMTok = Number(modelDraft.outputPerMTok); const valid = (value: number) => Number.isFinite(value) && value >= 0; if (!valid(inputPerMTok) || !valid(outputPerMTok) || (inputPerMTok <= 0 && outputPerMTok <= 0)) return null; return { currency: modelDraft.pricingCurrency || 'USD', inputPerMTok, outputPerMTok } }
function editModel(profile: any) { Object.assign(modelDraft, { id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, endpoint: profile.endpoint, timeoutMs: profile.timeoutMs, maxTokens: profile.maxTokens, temperature: profile.temperature, concurrencyLimit: profile.concurrencyLimit, fallbackProfileId: profile.fallbackProfileId || '', budgetCurrency: profile.dailyBudget?.currency || 'tokens', budgetAmount: profile.dailyBudget?.amount == null ? '' : String(profile.dailyBudget.amount), ...pricingDraft(profile.pricing), enabled: profile.enabled, apiKey: '', capabilities: { ...profile.capabilities } }) }
async function clearModelKey(profile: any) { if (!window.confirm(`确认清除 ${profile.name} 的 API Key？`)) return; const res = await window.shopilot.agentDomain.modelSet({ id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, endpoint: profile.endpoint, timeoutMs: profile.timeoutMs, maxTokens: profile.maxTokens, temperature: profile.temperature, concurrencyLimit: profile.concurrencyLimit, fallbackProfileId: profile.fallbackProfileId, dailyBudget: profile.dailyBudget, pricing: profile.pricing, enabled: profile.enabled, capabilities: profile.capabilities, clearKey: true }); if (!res.ok) return emit('toast', res.error.message, 'error'); await loadModels(); emit('toast', '模型 API Key 已清除', 'success') }
async function saveModel() { const dailyBudget = modelDraft.budgetAmount === '' ? null : { currency: modelDraft.budgetCurrency || 'tokens', amount: Number(modelDraft.budgetAmount) }; const pricing = draftPricing(); const res = await window.shopilot.agentDomain.modelSet({ id: modelDraft.id || undefined, name: modelDraft.name, provider: modelDraft.provider, model: modelDraft.model, endpoint: modelDraft.endpoint, timeoutMs: Number(modelDraft.timeoutMs), maxTokens: Number(modelDraft.maxTokens), temperature: Number(modelDraft.temperature), concurrencyLimit: Number(modelDraft.concurrencyLimit), fallbackProfileId: modelDraft.fallbackProfileId || null, dailyBudget, pricing, enabled: modelDraft.enabled, capabilities: modelDraft.capabilities, apiKey: modelDraft.apiKey || undefined }); if (!res.ok) return emit('toast', res.error.message, 'error'); Object.assign(modelDraft, { id: '', name: '', provider: '', model: '', endpoint: '', apiKey: '', fallbackProfileId: '', budgetAmount: '', inputPerMTok: '', outputPerMTok: '', maxTokens: 1200, temperature: 0.7, enabled: true }); await loadModels(); emit('toast', '模型 Profile 已保存', 'success') }
async function testModel(id: string) { const res = await window.shopilot.agentDomain.modelTest(id); emit('toast', res.ok ? `测试成功：${res.data.model}，${res.data.elapsedMs}ms` : `测试失败（${res.error.code}）：${res.error.message}`, res.ok ? 'success' : 'error'); await loadModels() }
async function deleteModel(id: string) { if (!window.confirm('确认删除该模型 Profile？')) return; const res = await window.shopilot.agentDomain.modelDelete(id); if (!res.ok) return emit('toast', res.error.message, 'error'); await loadModels() }
async function searchMemory() { const res = await window.shopilot.agentDomain.memorySearch({ agentId: 'root-ceo', query: memoryQuery.value || '库存', limit: 50 }); if (res.ok) memories.value = res.data as any[]; else emit('toast', res.error.message, 'error') }
async function reviewMemory(id: string, status: 'approved' | 'stale') { const res = await window.shopilot.agentDomain.memoryReview({ memoryId: id, status, reviewerAgentId: 'root-ceo' }); if (!res.ok) return emit('toast', res.error.message, 'error'); if (memoryStatus.value) await loadMemories(); else await searchMemory() }
async function rebuildMemory() { const res = await window.shopilot.agentDomain.memoryRebuild(); memoryMessage.value = res.ok ? `索引重建完成：${res.data.indexed} 条，隔离 ${res.data.quarantined} 条` : res.error.message }
async function snapshotMemory() { const res = await window.shopilot.agentDomain.memorySnapshot(); if (res.ok) snapshotPath.value = res.data.path; memoryMessage.value = res.ok ? `加密快照已生成（${res.data.bytes} bytes，SHA-256 ${res.data.sha256.slice(0, 12)}…）` : res.error.message }
async function inspectSnapshot() { const res = await window.shopilot.agentDomain.memorySnapshotInspect(snapshotPath.value); memoryMessage.value = res.ok ? `快照校验通过：${res.data.records} 条记录，SHA-256 ${res.data.sha256.slice(0, 12)}…` : res.error.message }
async function restoreSnapshot() { if (!window.confirm('确认从该加密快照恢复记忆？当前记忆会先生成备份，冲突版本保留为待审核。')) return; const res = await window.shopilot.agentDomain.memorySnapshotRestore(snapshotPath.value, true); memoryMessage.value = res.ok ? `恢复完成：${res.data.restored} 条，冲突 ${res.data.conflicts} 条；备份已生成。` : res.error.message; if (res.ok) await loadMemories() }
async function runJob(id: string) { const res = await window.shopilot.agentDomain.jobRun(id); if (!res.ok) return emit('toast', res.error.message, 'error'); await loadJobs() }
async function resumeJob(id: string) { const res = await window.shopilot.agentDomain.jobResume(id); if (!res.ok) return emit('toast', res.error.message, 'error'); await loadJobs() }
async function cancelJob(id: string) { const res = await window.shopilot.agentDomain.jobCancel(id); if (!res.ok) return emit('toast', res.error.message, 'error'); await loadJobs() }
async function approveJob(job: any) { const res = await window.shopilot.agentDomain.jobApprove(job.id, true, job.confirmationId); if (!res.ok) return emit('toast', res.error.message, 'error'); await loadJobs() }
async function createJob() { let inputSummary: Record<string, unknown>; let browserTask: any = null; try { const parsed = JSON.parse(newJob.inputSummary || '{}'); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('输入摘要必须是对象'); inputSummary = parsed; if (newJob.browserTask.trim()) { browserTask = JSON.parse(newJob.browserTask); } } catch (error: any) { return emit('toast', `Job JSON 无效：${String(error?.message || error)}`, 'error') } const res = await window.shopilot.agentDomain.jobCreate({ createdByAgentId: 'root-ceo', assignedAgentId: newJob.assignedAgentId, storeId: newJob.storeId.trim() || null, goal: newJob.goal.trim(), inputSummary, priority: 50, requiresConfirmation: newJob.requiresConfirmation, idempotencyKey: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, browserTask, dependencies: [] }); if (!res.ok) return emit('toast', res.error.message, 'error'); Object.assign(newJob, { goal: '', inputSummary: '{"source":"manual"}', browserTask: '', requiresConfirmation: false }); await loadJobs(); emit('toast', 'Job 已创建并进入队列', 'success') }
async function reviewResult(resultId: string, approved: boolean) { const res = await window.shopilot.agentDomain.jobResultReview({ resultId, reviewerAgentId: 'root-ceo', approved }); if (!res.ok) return emit('toast', res.error.message, 'error'); await loadJobs(); emit('toast', approved ? 'Job 结果已批准' : 'Job 结果已驳回', approved ? 'success' : 'error') }
onMounted(loadAll)
</script>

<style scoped>
.agent-admin{display:flex;flex-direction:column;min-height:0;height:100%;color:var(--color-text-primary)}
.admin-inherited-model{display:flex;align-items:center;flex:1;min-width:0;padding:7px 8px;margin:4px 0;border:1px solid var(--color-border);border-radius:6px;color:var(--color-text-muted);font-size:10px}
.agent-admin-tabs{display:flex;gap:6px;flex-wrap:wrap;padding:4px 0 10px;border-bottom:1px solid var(--color-border)}
.admin-tab{border:1px solid var(--color-border);border-radius:7px;padding:6px 9px;background:rgba(255,255,255,.035);color:var(--color-text-secondary);font-size:10px;cursor:pointer}.admin-tab.on{background:rgba(72,126,221,.24);color:#fff;border-color:rgba(116,164,240,.65)}
.admin-scroll{flex:1;min-height:0;overflow:auto;padding:4px 2px 12px}.admin-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin:5px 0 8px}.admin-head b{display:block;font-size:12px}.admin-head span{display:block;color:var(--color-text-muted);font-size:9px;margin-top:3px}.admin-note{margin:6px 0;padding:7px 8px;border:1px solid rgba(105,150,225,.25);border-radius:7px;background:rgba(70,110,190,.08);color:var(--color-text-secondary);font-size:10px;line-height:1.45}.admin-card,.admin-create{margin:6px 0;padding:9px;border:1px solid var(--color-border);border-radius:8px;background:rgba(255,255,255,.025)}.admin-card-head{display:flex;justify-content:space-between;gap:8px;align-items:center}.admin-card-head strong{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.admin-meta{margin-top:4px;color:var(--color-text-muted);font-size:9px;overflow-wrap:anywhere}.status-pill{border-radius:99px;padding:2px 6px;font-size:9px;background:rgba(255,255,255,.08)}.status-pill.active,.status-pill.healthy,.status-pill.approved{color:#8ce2b4;background:rgba(58,154,103,.2)}.status-pill.probation,.status-pill.pending-review,.status-pill.waiting_confirmation{color:#f4cf78;background:rgba(214,161,41,.15)}.status-pill.paused,.status-pill.degraded,.status-pill.stale{color:#f0bb7e;background:rgba(193,113,33,.15)}.status-pill.retired,.status-pill.failed,.status-pill.cancelled,.status-pill.quarantined{color:#ffaaa4;background:rgba(164,48,48,.17)}.admin-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}.admin-result{display:flex;gap:6px;align-items:center;justify-content:space-between;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);font-size:9px;color:var(--color-text-secondary)}.admin-check{display:block;color:var(--color-text-secondary);font-size:10px;padding:4px 0}.admin-create>b{display:block;font-size:11px;margin-bottom:7px}.admin-create input,.admin-create textarea,.admin-create select,.admin-form-row input,.admin-form-row select{box-sizing:border-box;width:100%;border:1px solid var(--color-border);border-radius:6px;padding:7px 8px;background:rgba(0,0,0,.18);color:var(--color-text-primary);font-size:10px;margin:4px 0}.admin-form-row{display:flex;gap:6px}.admin-form-row>*{flex:1;min-width:0}.admin-empty{padding:20px;text-align:center;color:var(--color-text-muted);font-size:10px}.admin-event{padding:5px 0;border-top:1px solid rgba(255,255,255,.08);font-size:9px;color:var(--color-text-secondary)}details{margin-top:7px}summary{cursor:pointer;color:var(--color-text-secondary);font-size:9px}
.capability-row{display:flex;flex-wrap:wrap;gap:10px;color:var(--color-text-secondary);font-size:10px;padding:4px 0}.capability-row input{width:auto!important;margin:0 4px 0 0!important;padding:0!important}
</style>
