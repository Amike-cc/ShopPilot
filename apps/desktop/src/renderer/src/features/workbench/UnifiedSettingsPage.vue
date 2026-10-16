<template>
  <section class="unified-page unified-settings-page" data-test="unified-settings-page">
    <div class="settings-dialog-shell" data-test="settings-dialog">
    <header class="unified-page-head settings-hero"><div class="settings-title-block"><div class="settings-title-icon"><img :src="settingsIcon" alt="" /></div><div><span class="dashboard-eyebrow">WORKSPACE / SETTINGS</span><h1>设置中心</h1><p>集中管理平台入口、AI 服务、应用锁与数据维护；敏感凭据只在主进程安全存储。</p></div></div><div class="settings-head-actions"><div class="settings-save-state" v-if="savedMessage && !entryDirty" role="status" aria-live="polite"><i></i>{{ savedMessage }}</div><button type="button" class="unified-button ghost btn-ghost" @click="requestClose"><img class="button-icon" :src="settingsCloseIcon" alt="" />关闭</button></div></header>
    <div class="settings-layout"><nav class="settings-nav sub-tabs" aria-label="设置页签"><div class="settings-nav-title"><span>CONTROL PANEL</span><strong>工作台设置</strong></div><button v-for="tab in tabs" :key="tab.key" type="button" :class="{ active: activeTab === tab.key }" :aria-current="activeTab === tab.key ? 'page' : undefined" :data-test="`settings-tab-${tab.key}`" @click="selectTab(tab.key)"><img class="settings-tab-icon" :src="tab.icon" alt="" /><em class="stab">{{ tab.label }}</em><i v-if="tabIssues[tab.key]" class="settings-tab-alert" :data-test="'settings-tab-alert-' + tab.key" title="该页签存在读取失败，点开可重试" aria-hidden="true"></i><b><img :src="forwardIcon" alt="" /></b></button></nav><main class="settings-content modal">
      <section v-if="activeTab === 'entry'" class="settings-section" data-test="settings-entry" data-unified-test="unified-settings-entry">
        <div class="settings-section-head">
          <div><h2>平台入口</h2><p>这里维护平台首页与达人广场的地址覆盖；留空即回退平台默认地址，两项都要求完整的 http:// 或 https:// 链接。</p></div>
          <div class="settings-head-actions-row">
            <span v-if="entryDirty" class="settings-unsaved" data-test="settings-entry-unsaved">有未保存的修改</span>
            <button type="button" class="unified-button ghost" data-test="settings-entry-discard" :disabled="entrySaving || !entryDirty" @click="discardEntry">放弃更改</button>
            <button type="button" class="unified-button primary" data-test="settings-save" :disabled="homeLoading || squareLoading || entrySaving || !homeLoaded || !squareLoaded || !entryDirty" :title="entryDirty || homeLoading || squareLoading || !homeLoaded || !squareLoaded ? undefined : '没有需要保存的修改'" @click="saveEntry"><img class="button-icon" :src="settingsSaveIcon" alt="" />{{ entrySaving ? '保存中…' : '保存配置' }}</button>
          </div>
        </div>
        <div v-if="homeLoadError || squareLoadError" class="settings-note error" role="alert">{{ homeLoadError || squareLoadError }}<button type="button" class="settings-inline-retry" :disabled="homeLoading || squareLoading" @click="reloadEntry">{{ (homeLoading || squareLoading) ? '读取中…' : '重试读取' }}</button></div>
        <div v-else-if="homeLoading || squareLoading || !homeLoaded || !squareLoaded" class="settings-note" role="status">正在读取已保存的平台入口配置…</div>
        <div v-if="entryValidationError" class="settings-note error" role="alert">{{ entryValidationError }}</div>
        <div class="settings-group" data-test="settings-entry-platform">
          <div class="settings-group-head"><h3>平台首页地址</h3><span>地址栏「首页」按钮使用这里的覆盖值；输入框占位符即平台默认地址</span></div>
          <div v-for="platform in platformDefs" :key="platform.name" class="settings-field-row" data-test="platform-home-row"><label><span class="plat-name">{{ platform.name }}</span><input v-model="homeDraft[platform.name]" :data-test="`home-url-${platform.name}`" :placeholder="platform.adminUrl" spellcheck="false" :disabled="homeLoading || !homeLoaded" /></label><button type="button" class="unified-button ghost" :disabled="homeLoading || entrySaving || !homeLoaded || !homeDraft[platform.name]" @click="homeDraft[platform.name] = ''"><img class="button-icon" :src="refreshIcon" alt="" />恢复默认</button></div>
        </div>
        <div class="settings-group" data-test="settings-entry-square">
          <div class="settings-group-head"><h3>达人广场地址</h3><span>仅对已有真实流程档案的平台开放；支持：{{ inviteProfiles.map(item => item.platform).join('、') || '暂无' }}</span></div>
          <div v-for="profile in inviteProfiles" :key="profile.platform" class="settings-field-row" data-test="square-url-row"><label><span class="plat-name">{{ profile.platform }}</span><input v-model="squareDraft[profile.platform]" :placeholder="profile.pageUrl" :data-test="`square-url-${profile.platform}`" spellcheck="false" :disabled="squareLoading || !squareLoaded" /></label><button type="button" class="unified-button ghost" :disabled="squareLoading || entrySaving || !squareLoaded || !squareDraft[profile.platform]" @click="squareDraft[profile.platform] = ''"><img class="button-icon" :src="refreshIcon" alt="" />恢复默认</button></div>
        </div>
        <div class="settings-note">保存会同时写入两组覆盖值；不联网探测可达性，保存前只做格式校验。</div>
      </section>
      <section v-else-if="activeTab === 'ai'" class="settings-section ai-settings-section" data-test="settings-ai" data-unified-test="unified-settings-ai">
        <div class="settings-section-head"><div><h2>AI 配置</h2><p>Agent 文本、商品图生成、商品图文本分析分别保存地址、模型、超时和 API Key；Key 只经主进程 safeStorage 保存，页面不回显。</p></div></div>
        <div v-if="aiLoadError" class="settings-note error ai-load-error" role="alert">{{ aiLoadError }}<button type="button" class="settings-inline-retry" :disabled="aiConfigLoading" @click="loadAi">{{ aiConfigLoading ? '读取中…' : '重试读取' }}</button></div>
        <div v-else-if="aiConfigLoading" class="settings-note ai-load-error" role="status">正在读取 AI 配置…</div>
        <div class="ai-config-summary" data-test="ai-config-summary"><div class="ai-summary-copy"><span class="settings-kicker">CONFIGURATION</span><strong>{{ configuredSummary }}</strong><p>此状态表示配置项完整度；接口可用性请查看各卡片的连接测试结果。</p></div><div class="ai-summary-statuses"><span class="ai-summary-status" :class="{ ready: aiReady }"><i></i><b>Agent 文本</b><em>{{ aiReady ? '已配置' : '待配置' }}</em></span><span class="ai-summary-status" :class="{ ready: imageReady }"><i></i><b>生图接口</b><em>{{ imageReady ? '已配置' : '待配置' }}</em></span><span class="ai-summary-status" :class="{ ready: imageTextReady }"><i></i><b>生图文本</b><em>{{ imageTextReady ? '已配置' : '待配置' }}</em></span></div></div>
        <div class="ai-config-grid">
          <section class="ai-config-card" data-test="text-ai-config">
            <div class="ai-card-head"><div><span class="settings-kicker">TEXT / AGENT</span><h3>文本 API</h3><p>Agent 与通用对话使用这套配置；商品图片页面的分析文本使用下方独立配置。</p></div><span class="ai-status" :class="{ ok: aiReady }">{{ aiReady ? '配置完整' : '待完善' }}</span></div>
            <label class="settings-field"><span>服务商</span><select v-model="aiProvider" :disabled="aiConfigLoading || !aiLoaded" @change="applyPreset"><option v-for="preset in presets" :key="preset.key" :value="preset.key">{{ preset.label }}</option><option value="__custom__">自定义</option></select></label>
            <label class="settings-field"><span>文本接口地址</span><input v-model="aiDraft.endpoint" data-test="ai-endpoint" data-unified-test="text-ai-endpoint" spellcheck="false" placeholder="https://api.example.com/v1" :disabled="aiConfigLoading || !aiLoaded" /></label>
            <div v-if="resolvedEndpoint" class="settings-note">实际请求：<code>{{ resolvedEndpoint }}</code><br><template v-if="modelsUrl">模型列表：<code>{{ modelsUrl }}</code></template></div>
            <label class="settings-field"><span>文本模型名</span><input v-model="aiDraft.model" data-test="ai-model" data-unified-test="text-ai-model" spellcheck="false" :disabled="aiConfigLoading || !aiLoaded" /></label>
            <label class="settings-field"><span>文本超时（毫秒）</span><input v-model.number="aiDraft.timeoutMs" type="number" min="3000" max="120000" :disabled="aiConfigLoading || !aiLoaded" /></label>
            <label class="settings-field"><span>文本 API Key</span><input v-model="aiKey" data-test="ai-key" type="password" autocomplete="new-password" :placeholder="aiHasKey ? '已配置，留空不修改' : '粘贴文本 API Key'" :disabled="aiConfigLoading || !aiLoaded" /></label>
            <div class="settings-actions"><button type="button" class="unified-button primary" data-test="settings-save" :disabled="aiSaving || aiConfigLoading || !aiLoaded" @click="saveAi()"><img class="button-icon" :src="settingsSaveIcon" alt="" />{{ aiSaving ? '保存中…' : '保存文本配置' }}</button><button type="button" class="unified-button ghost" data-test="ai-models-btn" :disabled="aiLoading || aiTesting || aiSaving || aiConfigLoading || !aiLoaded" @click="fetchModels"><img class="button-icon" :src="refreshIcon" alt="" />{{ aiLoading ? '读取中…' : '获取文本模型' }}</button><button type="button" class="unified-button ghost" data-test="ai-test" :disabled="aiTesting || aiLoading || aiSaving || aiConfigLoading || !aiLoaded" @click="testAi"><img class="button-icon" :src="settingsTestIcon" alt="" />{{ aiTesting ? '测试中…' : '测试文本接口' }}</button><button v-if="aiHasKey" type="button" class="unified-button danger" data-test="ai-key-clear" :disabled="aiSaving || aiConfigLoading || !aiLoaded" @click="clearKey"><img class="button-icon" :src="settingsKeyClearIcon" alt="" />清除文本 Key</button></div>
            <div v-if="aiMessage" class="settings-note" data-test="ai-msg" :class="{ ok: aiOk }">{{ aiMessage }}</div>
            <div v-if="aiModels.length" class="settings-field image-model-picker"><span>已读取的文本模型</span><select data-test="ai-model-pick" :value="aiDraft.model" @change="pickAiModel(($event.target as HTMLSelectElement).value)"><option value="">— 选择后填入模型名 —</option><option v-for="model in aiModels" :key="model" :value="model">{{ model }}</option></select></div>
          </section>
          <section class="ai-config-card image-ai-config-card" data-test="image-ai-config">
            <div class="ai-card-head"><div><span class="settings-kicker">IMAGE / GENERATION</span><h3>生图 API</h3><p>商品图生成和图片编辑只使用这套独立配置。</p></div><span class="ai-status" :class="{ ok: imageReady }">{{ imageReady ? '配置完整' : '待完善' }}</span></div>
            <label class="settings-field"><span>生图接口地址</span><input v-model="imageDraft.endpoint" data-test="image-ai-endpoint" spellcheck="false" placeholder="https://api.example.com/v1 或 /images/generations" :disabled="aiConfigLoading || !aiLoaded" /></label>
            <div v-if="imageResolvedEndpoint" class="settings-note">实际生图请求：<code>{{ imageResolvedEndpoint }}</code><br><template v-if="imageModelsUrl">模型列表：<code>{{ imageModelsUrl }}</code></template></div>
            <label class="settings-field"><span>生图模型名</span><input v-model="imageDraft.model" data-test="image-ai-model" spellcheck="false" placeholder="例如 gpt-image-1、flux-1" :disabled="aiConfigLoading || !aiLoaded" /></label>
            <label class="settings-field"><span>生图超时（毫秒）</span><input v-model.number="imageDraft.timeoutMs" type="number" min="3000" max="600000" :disabled="aiConfigLoading || !aiLoaded" /></label>
            <label class="settings-field"><span>生图 API Key</span><input v-model="imageKey" type="password" autocomplete="new-password" :placeholder="imageHasKey ? '已配置，留空不修改' : '粘贴生图 API Key'" :disabled="aiConfigLoading || !aiLoaded" /></label>
            <div class="settings-actions"><button type="button" class="unified-button primary" :disabled="imageSaving || aiConfigLoading || !aiLoaded" @click="saveImageAi()"><img class="button-icon" :src="settingsSaveIcon" alt="" />{{ imageSaving ? '保存中…' : '保存生图配置' }}</button><button type="button" class="unified-button ghost" :disabled="imageLoading || imageTesting || imageSaving || aiConfigLoading || !aiLoaded" @click="fetchImageModels"><img class="button-icon" :src="refreshIcon" alt="" />{{ imageLoading ? '读取中…' : '获取生图模型' }}</button><button type="button" class="unified-button ghost" :disabled="imageTesting || imageLoading || imageSaving || aiConfigLoading || !aiLoaded" @click="testImageAi"><img class="button-icon" :src="settingsTestImageIcon" alt="" />{{ imageTesting ? '测试中…' : '测试生图接口' }}</button><button v-if="imageHasKey" type="button" class="unified-button danger" :disabled="imageSaving || aiConfigLoading || !aiLoaded" @click="clearImageKey"><img class="button-icon" :src="settingsKeyClearIcon" alt="" />清除生图 Key</button></div>
            <div v-if="imageMessage" class="settings-note" :class="{ ok: imageOk }">{{ imageMessage }}</div>
            <div v-if="imageModels.length" class="settings-field image-model-picker"><span>已读取的生图模型</span><select :value="imageDraft.model" @change="pickImageModel(($event.target as HTMLSelectElement).value)"><option value="">— 选择后填入模型名 —</option><option v-for="model in imageModels" :key="model" :value="model">{{ model }}</option></select></div>
            <div class="settings-note">图片生成可能产生第三方费用；“测试生图接口”只读 GET /models，不会发起付费图片生成。没有真实图片返回时，工作台只显示空状态。</div>
          </section>
          <section class="ai-config-card image-text-ai-config-card" data-test="image-text-ai-config">
            <div class="ai-card-head"><div><span class="settings-kicker">IMAGE / TEXT ANALYSIS</span><h3>生图文本 API</h3><p>仅用于 AI 生成商品图片页面的商品分析和提示词整理，不会读取或修改 Agent 配置。</p></div><span class="ai-status" :class="{ ok: imageTextReady }">{{ imageTextReady ? '配置完整' : '待完善' }}</span></div>
            <div v-if="imageTextLoadError" class="settings-note error" role="alert">{{ imageTextLoadError }}<button type="button" class="settings-inline-retry" :disabled="imageTextConfigLoading" @click="loadImageTextAi">{{ imageTextConfigLoading ? '读取中…' : '重试读取' }}</button></div>
            <div v-else-if="imageTextConfigLoading" class="settings-note" role="status">正在读取分析配置…</div>
            <label class="settings-field"><span>分析文本接口地址</span><input v-model="imageTextDraft.endpoint" data-test="image-text-ai-endpoint" spellcheck="false" placeholder="https://api.example.com/v1" :disabled="imageTextConfigLoading || !imageTextLoaded" /></label>
            <div v-if="imageTextResolvedEndpoint" class="settings-note">实际请求：<code>{{ imageTextResolvedEndpoint }}</code><br><template v-if="imageTextModelsUrl">模型列表：<code>{{ imageTextModelsUrl }}</code></template></div>
            <label class="settings-field"><span>分析文本模型名</span><input v-model="imageTextDraft.model" data-test="image-text-ai-model" spellcheck="false" placeholder="例如 deepseek-chat、qwen-plus" :disabled="imageTextConfigLoading || !imageTextLoaded" /></label>
            <label class="settings-field"><span>分析文本超时（毫秒）</span><input v-model.number="imageTextDraft.timeoutMs" type="number" min="3000" max="120000" :disabled="imageTextConfigLoading || !imageTextLoaded" /></label>
            <label class="settings-field"><span>分析文本 API Key</span><input v-model="imageTextKey" type="password" autocomplete="new-password" :placeholder="imageTextHasKey ? '已配置，留空不修改' : '粘贴商品分析文本 API Key'" :disabled="imageTextConfigLoading || !imageTextLoaded" /></label>
            <div class="settings-actions"><button type="button" class="unified-button primary" :disabled="imageTextSaving || imageTextConfigLoading || !imageTextLoaded" @click="saveImageTextAi()"><img class="button-icon" :src="settingsSaveIcon" alt="" />{{ imageTextSaving ? '保存中…' : '保存生图文本配置' }}</button><button type="button" class="unified-button ghost" :disabled="imageTextLoading || imageTextTesting || imageTextSaving || imageTextConfigLoading || !imageTextLoaded" @click="fetchImageTextModels"><img class="button-icon" :src="refreshIcon" alt="" />{{ imageTextLoading ? '读取中…' : '获取分析模型' }}</button><button type="button" class="unified-button ghost" :disabled="imageTextTesting || imageTextLoading || imageTextSaving || imageTextConfigLoading || !imageTextLoaded" @click="testImageTextAi"><img class="button-icon" :src="settingsTestIcon" alt="" />{{ imageTextTesting ? '测试中…' : '测试分析接口' }}</button><button v-if="imageTextHasKey" type="button" class="unified-button danger" :disabled="imageTextSaving || imageTextConfigLoading || !imageTextLoaded" @click="clearImageTextKey"><img class="button-icon" :src="settingsKeyClearIcon" alt="" />清除分析 Key</button></div>
            <div v-if="imageTextMessage" class="settings-note" :class="{ ok: imageTextOk }">{{ imageTextMessage }}</div>
            <div v-if="imageTextModels.length" class="settings-field image-model-picker"><span>已读取的分析模型</span><select :value="imageTextDraft.model" @change="pickImageTextModel(($event.target as HTMLSelectElement).value)"><option value="">— 选择后填入模型名 —</option><option v-for="model in imageTextModels" :key="model" :value="model">{{ model }}</option></select></div>
            <div class="settings-note">此配置只负责整理卖点、场景和图片提示词；真正生成图片仍只使用上面的生图 API。测试只发起最小文本请求，未配置时页面保持明确不可用状态。</div>
          </section>
        </div>
      </section>
      <section v-else-if="activeTab === 'security'" class="settings-section" data-test="settings-security" data-unified-test="unified-settings-security">
        <div class="settings-section-head"><div><h2>应用锁与安全</h2><p>设置主密码后可手动或空闲自动锁定应用；锁定会隐藏店铺视图并拒绝业务操作。主密码经系统安全存储加密，不经过云端、页面不回显。</p></div><button v-if="securityEnabled" type="button" class="unified-button" data-test="security-lock-now" :disabled="securityBusy" @click="lockNow"><img class="button-icon" :src="securityLockIcon" alt="" />立即锁定</button></div>
        <div v-if="securityLoadError" class="settings-note error" role="alert">{{ securityLoadError }}<button type="button" class="settings-inline-retry" :disabled="securityLoading" @click="loadSecurity">{{ securityLoading ? '读取中…' : '重试读取' }}</button></div>
        <div v-else-if="securityLoading && !securityLoaded" class="settings-note" role="status">正在读取应用锁状态…</div>
        <template v-else>
          <div class="security-status" data-test="security-state" :data-enabled="securityEnabled ? '1' : '0'">
            <span class="security-status-dot" :class="{ on: securityEnabled }" aria-hidden="true"></span>
            <div class="security-status-copy"><strong>{{ securityEnabled ? '主密码已启用' : '未设置主密码' }}</strong><p>{{ securityEnabled ? '每次锁定后需主密码解锁；空闲自动锁定可单独配置。' : '建议设置：开启后可一键锁定应用，避免他人直接操作店铺。' }}</p></div>
          </div>
          <div v-if="!securityEnabled" class="settings-group" data-test="security-set-group">
            <div class="settings-group-head"><h3>设置主密码</h3><span>至少 8 位；请妥善保管——忘记后应用内无法找回或更换</span></div>
            <div class="settings-field-row"><label><span>新主密码</span><input v-model="secPw1" type="password" data-test="security-new-pw" autocomplete="new-password" placeholder="至少 8 位" :disabled="securityBusy" /></label></div>
            <div class="settings-field-row"><label><span>再次输入</span><input v-model="secPw2" type="password" data-test="security-confirm-pw" autocomplete="new-password" placeholder="再次输入新主密码" :disabled="securityBusy" /></label><button type="button" class="unified-button primary" data-test="security-set-submit" :disabled="securityBusy || secPw1.length < 8 || secPw1 !== secPw2" @click="submitSetPassword">{{ securityBusy ? '设置中…' : '设置主密码' }}</button></div>
          </div>
          <div v-else class="settings-group" data-test="security-manage-group">
            <div class="settings-group-head"><h3>主密码管理</h3><span>更换或移除主密码都需要先验证当前密码</span></div>
            <div class="settings-actions">
              <button type="button" class="unified-button" data-test="security-change-toggle" :disabled="securityBusy" @click="toggleChangePw">{{ secChangeOpen ? '收起更换面板' : '更换密码' }}</button>
              <button type="button" class="unified-button danger" data-test="security-remove-toggle" :disabled="securityBusy" @click="toggleRemovePw">{{ secRemoveOpen ? '收起移除面板' : '移除主密码' }}</button>
            </div>
            <div v-if="secChangeOpen" class="settings-group-inline" data-test="security-change-panel">
              <label class="settings-field"><span>当前主密码</span><input v-model="secOldPw" type="password" data-test="security-old-pw" autocomplete="off" :disabled="securityBusy" /></label>
              <label class="settings-field"><span>新主密码（≥8 位）</span><input v-model="secNewPw" type="password" data-test="security-change-pw" autocomplete="new-password" :disabled="securityBusy" /></label>
              <label class="settings-field"><span>再次输入新主密码</span><input v-model="secNewPw2" type="password" data-test="security-change-confirm" autocomplete="new-password" :disabled="securityBusy" /></label>
              <div class="settings-actions"><button type="button" class="unified-button primary" data-test="security-change-submit" :disabled="securityBusy || !secOldPw || secNewPw.length < 8 || secNewPw !== secNewPw2" @click="submitChangePassword">{{ securityBusy ? '更新中…' : '更新主密码' }}</button></div>
            </div>
            <div v-if="secRemoveOpen" class="settings-group-inline" data-test="security-remove-panel">
              <label class="settings-field"><span>移除主密码需输入当前主密码确认（移除后应用锁立即解除）</span><input v-model="secRemovePw" type="password" data-test="security-remove-pw" autocomplete="off" :disabled="securityBusy" /></label>
              <div class="settings-actions"><button type="button" class="unified-button danger" data-test="security-remove-submit" :disabled="securityBusy || !secRemovePw" @click="submitRemovePassword">{{ securityBusy ? '移除中…' : '确认移除' }}</button><button type="button" class="unified-button ghost" :disabled="securityBusy" @click="cancelRemovePw">取消</button></div>
            </div>
          </div>
          <div class="settings-group" data-test="security-idle-group">
            <div class="settings-group-head"><h3>空闲自动锁定</h3><span>长时间无操作后自动锁定应用；选「关闭」则只在手动点「立即锁定」时锁定</span></div>
            <div class="settings-field-row"><label><span>空闲时长</span><select v-model.number="securityIdle" data-test="security-idle" :disabled="securityBusy" @change="applyIdleMinutes"><option :value="0">关闭</option><option :value="5">5 分钟</option><option :value="15">15 分钟</option><option :value="30">30 分钟</option><option :value="60">60 分钟</option></select></label></div>
            <p v-if="!securityEnabled" class="settings-hint">当前未设置主密码，空闲自动锁定不会生效。</p>
          </div>
          <div v-if="securityMsg" class="settings-note" :class="{ ok: securityMsgOk }" data-test="security-msg">{{ securityMsg }}</div>
        </template>
      </section>
      <section v-else-if="activeTab === 'maintenance'" class="settings-section" data-test="settings-maintenance" data-unified-test="unified-settings-maintenance">
        <div class="settings-section-head"><div><h2>数据与维护</h2><p>采集总开关、数据库备份与恢复、诊断与审计导出。恢复会覆盖当前数据库，恢复前自动为当前状态创建安全快照。</p></div></div>
        <div v-if="maintenanceLoadError" class="settings-note error" role="alert">{{ maintenanceLoadError }}<button type="button" class="settings-inline-retry" :disabled="maintenanceLoading" @click="loadMaintenance">{{ maintenanceLoading ? '读取中…' : '重试读取' }}</button></div>
        <div class="settings-group" data-test="maintenance-collection">
          <div class="settings-group-head"><h3>采集模式</h3><span>默认关闭（fail-closed）：关闭时所有采集都由你手动触发</span></div>
          <div class="settings-field-row maintenance-toggle-row">
            <label class="settings-check"><input v-model="collectionEnabled" type="checkbox" class="settings-switch" data-test="maintenance-auto-collect" :disabled="collectionSaving || !collectionLoaded" @change="applyCollectionSwitch" /><span>自动采集总开关</span></label>
            <span class="settings-check-state" data-test="maintenance-auto-collect-state">{{ !collectionLoaded ? '读取中…' : (collectionEnabled ? '已开启 · 按任务周期自动采集' : '已关闭 · 只手动采集') }}</span>
          </div>
          <p class="settings-hint">影响发票采集（每 3 小时）与店铺采集计划；关闭时定时任务不自动触发，「立即采集」仍可手动使用。</p>
        </div>
        <div class="settings-group" data-test="maintenance-backup">
          <div class="settings-group-head"><h3>备份与恢复</h3><span>备份含校验和；恢复失败绝不覆盖现有数据</span></div>
          <div class="settings-actions"><button type="button" class="unified-button" data-test="maintenance-backup-create" :disabled="backupBusy" @click="doBackup"><img class="button-icon" :src="backupCreateIcon" alt="" />{{ backupBusy ? '备份中…' : '立即备份数据库' }}</button></div>
          <div v-if="backups.length" class="maintenance-backup-list">
            <div v-for="item in backups" :key="item.id" class="maintenance-backup-row" data-test="maintenance-backup-row">
              <span class="maintenance-backup-meta"><b>{{ formatBackupTime(item.createdAt) }}</b><em>{{ formatBackupSize(item.sizeBytes) }}</em></span>
              <button type="button" class="unified-button ghost" data-test="maintenance-restore" :disabled="backupBusy" @click="doRestore(item.id)"><img class="button-icon" :src="backupRestoreIcon" alt="" />恢复到此备份</button>
            </div>
          </div>
          <div v-else class="settings-hint" data-test="maintenance-backup-empty">{{ backupBusy ? '正在备份…' : '暂无备份记录，点「立即备份数据库」创建第一个。' }}</div>
        </div>
        <div class="settings-group" data-test="maintenance-diagnostics">
          <div class="settings-group-head"><h3>诊断与审计</h3><span>诊断包只含版本、系统、迁移版本、代理体检与脱敏日志，不含会话 Cookie、密码或订单原文</span></div>
          <div class="settings-actions">
            <button type="button" class="unified-button" data-test="maintenance-diagnostics-export" :disabled="diagBusy" @click="doDiagnostics"><img class="button-icon" :src="diagnosticsIcon" alt="" />{{ diagBusy ? '导出中…' : '导出诊断包' }}</button>
            <button type="button" class="unified-button" data-test="maintenance-audit-export" :disabled="auditBusy" @click="doAuditExport"><img class="button-icon" :src="auditLogIcon" alt="" />{{ auditBusy ? '导出中…' : '导出审计日志' }}</button>
            <button type="button" class="unified-button" data-test="maintenance-memory" :disabled="memoryBusy" @click="readMemoryDiagnostics"><img class="button-icon" :src="memorySnapshotIcon" alt="" />{{ memoryBusy ? '读取中…' : '读取内存快照' }}</button>
            <button type="button" class="unified-button" data-test="maintenance-view-check" :disabled="viewCheckBusy" @click="runViewCheck">{{ viewCheckBusy ? '体检中…' : '视图体检' }}</button>
          </div>
          <div v-if="memoryText" class="settings-note" data-test="maintenance-memory-result">{{ memoryText }}</div>
          <div v-if="viewCheckResult" class="maintenance-backup-list" data-test="maintenance-view-result">
            <div v-for="v in viewCheckResult" :key="v.tabId" class="maintenance-backup-row" :data-test="'view-probe-' + v.storeId">
              <span class="maintenance-backup-meta">
                <b>{{ viewStoreName(v.storeId) }}</b>
                <em>{{ viewStateLabel(v) }}<template v-if="v.internal"> · 采集专用页</template> · {{ v.title || '（无标题）' }}</em>
                <em v-if="v.reason" class="view-probe-reason">{{ v.reason }}</em>
              </span>
              <span class="product-title" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ v.url }}</span>
            </div>
          </div>
        </div>
        <div class="settings-group" data-test="maintenance-cache">
          <div class="settings-group-head">
            <h3>缓存清理与软件诊断</h3>
            <span>清理只动缓存文件：不删数据库、登录态、收藏与备份</span>
          </div>
          <div class="settings-actions">
            <button type="button" class="unified-button" data-test="maintenance-clear-app-cache" :disabled="appCacheBusy" @click="clearAppCache">{{ appCacheBusy ? '清理中…' : '清除软件缓存' }}</button>
            <button type="button" class="unified-button" data-test="maintenance-clear-browser-cache" :disabled="browserCacheBusy" @click="clearBrowserCache">{{ browserCacheBusy ? '清理中…' : '清除浏览器缓存' }}</button>
            <button type="button" class="unified-button" data-test="maintenance-software-check" :disabled="softwareCheckBusy" @click="runSoftwareCheck">{{ softwareCheckBusy ? '诊断中…' : '诊断软件' }}</button>
          </div>
          <div class="settings-hint" data-test="maintenance-cache-hint">
            软件缓存 = 应用界面自己的网页缓存（不含任何店铺数据）；浏览器缓存 = 所有店铺的网页缓存（Cookie 与站点存储保留，比下面「店铺分区存储」的整店清理更轻）。
          </div>
          <div v-if="cacheResultText" class="settings-note" :class="{ ok: cacheResultOk }" data-test="maintenance-cache-result">{{ cacheResultText }}</div>
          <div v-if="softwareCheckSummary" class="settings-note" :class="{ ok: softwareCheckSummary.status === 'ok' }" data-test="maintenance-software-summary">
            软件诊断：{{ softwareCheckSummary.headline }}<template v-if="softwareCheckSummary.status !== 'ok'"> · 可在上方「导出诊断包」把现场一并带给技术支持</template>
          </div>
          <div v-if="softwareCheckReport" class="maintenance-backup-list" data-test="maintenance-software-result">
            <div v-for="item in softwareCheckReport.items" :key="item.key" class="maintenance-backup-row" :data-test="'software-check-' + item.key">
              <span class="maintenance-backup-meta">
                <b>{{ item.label }}</b>
                <em :class="'check-' + item.status" :data-test="'software-check-status-' + item.key">{{ SOFTWARE_CHECK_STATUS_LABEL[item.status] }} · {{ item.detail }}</em>
                <em v-if="item.hint" class="view-probe-reason">{{ item.hint }}</em>
              </span>
            </div>
          </div>
        </div>
        <div class="settings-group" data-test="maintenance-partition">
          <div class="settings-actions">
            <button type="button" class="unified-button" data-test="maintenance-partition-usage" :disabled="partitionBusy" @click="readPartitionUsage">{{ partitionBusy ? '统计中…' : '读取店铺分区占用' }}</button>
            <span class="settings-hint" data-test="maintenance-partition-hint">清理只删缓存与站点存储，**登录态（Cookie）保留**。</span>
          </div>
          <div v-if="partitionUsage.length" class="maintenance-backup-list" data-test="maintenance-partition-list">
            <div v-for="item in partitionUsage" :key="item.storeId" class="maintenance-backup-row" data-test="maintenance-partition-row">
              <span class="maintenance-backup-meta"><b>{{ item.storeName }}</b><em>{{ formatBytes(item.bytes) }}</em></span>
              <button type="button" class="unified-button ghost" :data-test="'maintenance-partition-clean-' + item.storeId"
                      :disabled="partitionCleaningId === item.storeId || item.bytes === 0" @click="cleanPartition(item.storeId)">
                {{ partitionCleaningId === item.storeId ? '清理中…' : '清理（保留登录态）' }}</button>
            </div>
          </div>
          <div v-else class="settings-hint" data-test="maintenance-partition-empty">点「读取店铺分区占用」查看各店浏览器数据占用。</div>
        </div>
        <div v-if="maintenanceMsg" class="settings-note" :class="{ ok: maintenanceMsgOk }" data-test="maintenance-msg">{{ maintenanceMsg }}</div>
      </section>
      <section v-else class="settings-section" data-test="settings-about" data-unified-test="unified-settings-about">
        <div class="about-hero"><div class="about-mark"><img :src="brandMark" alt="ShopPilot" /></div><div><h2>ShopPilot</h2><p>电商店铺浏览器工作台</p></div></div>
        <div class="about-grid">
          <div><span>版本</span><strong data-test="about-version">v{{ updateStatus.currentVersion || '—' }}</strong></div>
          <div><span>构建</span><strong title="无代码签名证书时的构建标记（§21.5）；正式签名渠道会显示 RELEASE">INTERNAL_BUILD</strong></div>
          <div><span>更新通道</span><select v-model="updateChannel" data-test="update-channel" :disabled="updateChannelSaving || updateLoading || !updateLoaded" @change="saveUpdateChannel"><option value="stable">稳定版</option><option value="beta">测试版</option></select></div>
          <div class="about-toggle"><span>启动自动检查</span><label class="update-autocheck"><input v-model="updateAutoCheck" type="checkbox" data-test="update-autocheck" :disabled="updateAutoCheckSaving || updateLoading || !updateLoaded" @change="saveUpdateAutoCheck" /><em>{{ updateAutoCheck ? '已开启' : '已关闭' }}</em></label></div>
        </div>
        <div v-if="updateLoadError" class="settings-note error" role="alert">{{ updateLoadError }}<button type="button" class="settings-inline-retry" :disabled="updateLoading" @click="loadUpdate">{{ updateLoading ? '读取中…' : '重试读取' }}</button></div>
        <div v-else-if="updateLoading" class="settings-note" role="status">正在读取更新设置…</div>
        <div class="settings-note" data-test="update-dialog">更新包下载后会校验哈希；安装前请保存正在编辑的内容。当前通道：{{ updateChannel === 'beta' ? '测试版' : '稳定版' }} · 更新源：{{ updateSourceLabel }}。</div>
        <div class="settings-actions">
          <button v-if="!['available','downloaded','downloading'].includes(updateStatus.state)" type="button" class="unified-button primary" data-test="update-check-btn" :disabled="updateBusy || updateLoading || !updateLoaded || updateStatus.state === 'checking'" @click="checkUpdate"><img class="button-icon" :src="refreshIcon" alt="" />{{ updateStatus.state === 'checking' ? '检查中…' : '检查更新' }}</button>
          <button v-if="['available','downloading'].includes(updateStatus.state)" type="button" class="unified-button primary" data-test="update-download-btn" :disabled="updateBusy || updateStatus.state === 'downloading'" @click="downloadUpdate"><img class="button-icon" :src="updateDownloadIcon" alt="" />{{ updateStatus.state === 'downloading' ? `下载中 ${Math.round(updateStatus.percent || 0)}%` : '下载更新' }}</button>
          <button v-if="updateStatus.state === 'downloaded'" type="button" class="unified-button primary" data-test="update-install-btn" :disabled="updateBusy" @click="installUpdate">重启并安装</button>
          <span class="update-message" :class="[updateStatus.state, { error: !!updateStatus.error && ['error','not-available'].includes(updateStatus.state) }]" data-test="update-message" role="status" aria-live="polite">{{ updateMessage }}</span>
        </div>
        <div v-if="updateStatus.releaseNotes" class="settings-note update-release-notes" data-test="update-release-notes"><strong>版本说明</strong><pre>{{ updateStatus.releaseNotes }}</pre></div>
      </section>
    </main></div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import settingsIcon from '../../assets/icons/nav-settings.svg'
import configIcon from '../../assets/icons/settings-config.svg'
import aiIcon from '../../assets/icons/settings-ai.svg'
import aboutIcon from '../../assets/icons/settings-about.svg'
import brandMark from '../../assets/generated/shopilot-logo-generated.png'
// 图标纪律：设置中心是浅色表面，只使用**透明底/浅底**图标（`-gen` 深底霓虹风图标会把白底按钮
// 渲染成黑块——0.4.66 实测修复）。安全锁 / 层叠数据 / 芯片 / 箭头等取自非 -gen 的透明集，
// 保存/关闭/导出类取自 -sheet-gen 浅底集（与发票中心同一套视觉）。
import securityLockIcon from '../../assets/generated/ui-icons/security-lock.png'
import databaseBackupIcon from '../../assets/generated/ui-icons/detail.png'
import backupCreateIcon from '../../assets/generated/ui-icons/product-save-check-gen.png'
import backupRestoreIcon from '../../assets/generated/ui-icons/back.png'
import diagnosticsIcon from '../../assets/generated/ui-icons/observe.png'
import auditLogIcon from '../../assets/generated/ui-icons/date.png'
import memorySnapshotIcon from '../../assets/generated/ui-icons/memory.png'
import { INVITE_PROFILES } from '@shared/constants/invite'
// 视图状态词表：与诊断浮层同一份（2026-10-16 审查 V4），不再各写一套判断
import { BROWSER_VIEW_STATE_LABEL, type BrowserViewState } from '@shared/view-state'
// 缓存清理与软件诊断：文案与汇总口径（失败要说失败、最差的一项决定总体）
import {
  SOFTWARE_CHECK_STATUS_LABEL,
  describeCacheClearResult,
  summarizeSoftwareChecks,
  type CacheClearResult,
  type SoftwareCheckSummary,
  type SoftwareDiagnosticsReport
} from '@shared/software-diagnostics'
import { parseAutoCollectionEnabled, AUTO_COLLECTION_SETTING } from '@shared/constants/collection'
import { AI_IMAGE_TIMEOUT_MAX_MS, AI_PROVIDER_PRESETS, AI_TIMEOUT_MAX_MS, AI_TIMEOUT_MIN_MS, DEFAULT_AI_ENDPOINT, DEFAULT_AI_IMAGE_ENDPOINT, DEFAULT_AI_IMAGE_MODEL, DEFAULT_AI_IMAGE_TEXT_ENDPOINT, DEFAULT_AI_IMAGE_TEXT_MODEL, DEFAULT_AI_IMAGE_TEXT_TIMEOUT_MS, DEFAULT_AI_IMAGE_TIMEOUT_MS, DEFAULT_AI_MODEL, DEFAULT_AI_TIMEOUT_MS, INVITE_SQUARE_URLS_SETTING, normalizeAiEndpoint, normalizeImageEndpoint, modelsUrlFromChat, modelsUrlFromImageEndpoint } from '@shared/constants/ai'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import settingsSaveIcon from '../../assets/generated/ui-icons/data-license-save-sheet-gen.png'
import updateDownloadIcon from '../../assets/generated/ui-icons/data-export-sheet-gen.png'
import settingsCloseIcon from '../../assets/generated/ui-icons/panel-close-sheet-gen.png'
import settingsTestIcon from '../../assets/generated/ui-icons/search.png'
import settingsTestImageIcon from '../../assets/generated/ui-icons/search.png'
import settingsKeyClearIcon from '../../assets/generated/ui-icons/delete.png'
import forwardIcon from '../../assets/generated/ui-icons/forward.png'
import refreshIcon from '../../assets/generated/ui-icons/refresh.png'

const props = defineProps<{ initialTab?: TabKey }>()
const emit = defineEmits<{ close: [] }>()
const ws = useWorkspaceStore()
const tabs = [
  { key: 'entry', label: '平台入口', icon: configIcon },
  { key: 'ai', label: 'AI 配置', icon: aiIcon },
  { key: 'security', label: '安全', icon: securityLockIcon },
  { key: 'maintenance', label: '数据与维护', icon: databaseBackupIcon },
  { key: 'about', label: '关于软件', icon: aboutIcon }
] as const
type TabKey = typeof tabs[number]['key']
const activeTab = ref<TabKey>(props.initialTab || 'entry')
const savedMessage = ref('')
let savedMessageTimer: ReturnType<typeof setTimeout> | null = null
/** 保存成功的页头提示：6 秒后自动淡出（再次保存会重置计时；有未保存修改时模板上隐藏） */
function flashSavedMessage(message: string): void {
  savedMessage.value = message
  if (savedMessageTimer) clearTimeout(savedMessageTimer)
  savedMessageTimer = setTimeout(() => { savedMessage.value = '' }, 6000)
}
// P1-7（2026-10-15 审查）：无 preload（纯渲染调试模式）时不再整页 TypeError 白屏
const platformDefs = (window.shopilot?.platforms || []) as Array<{ name: string; adminUrl: string }>
const homeDraft = reactive<Record<string, string>>({})
const squareDraft = reactive<Record<string, string>>({})
const homeLoading = ref(false)
const homeLoaded = ref(false)
const homeLoadError = ref('')
const squareLoading = ref(false)
const squareLoaded = ref(false)
const squareLoadError = ref('')
const entrySaving = ref(false)
const entryValidationError = ref('')
/** 已保存快照：用来判断「平台入口」有没有未保存的修改（离开时确认，不静默丢弃） */
const homeBaseline = ref<Record<string, string>>({})
const squareBaseline = ref<Record<string, string>>({})
const inviteProfiles = computed(() => Object.values(INVITE_PROFILES))
const presets = AI_PROVIDER_PRESETS

// ---------- 应用锁（安全页签）：状态源是主进程 security:* IPC，页面只做展示与副本地 ----------
const securityEnabled = ref(false)
const securityIdle = ref(0)
const securityLoaded = ref(false)
const securityLoading = ref(false)
const securityLoadError = ref('')
const securityBusy = ref(false)
const securityMsg = ref('')
const securityMsgOk = ref(false)
const secPw1 = ref('')
const secPw2 = ref('')
const secChangeOpen = ref(false)
const secOldPw = ref('')
const secNewPw = ref('')
const secNewPw2 = ref('')
const secRemoveOpen = ref(false)
const secRemovePw = ref('')
/** 最近一次已保存的空闲锁定值：保存失败时把下拉还原到它，绝不显示假状态 */
let savedIdleMinutes = 0

// ---------- 数据与维护：采集总开关（fail-closed）+ 备份/诊断/审计 ----------
const collectionEnabled = ref(false)
const collectionLoaded = ref(false)
const collectionSaving = ref(false)
const maintenanceLoading = ref(false)
const maintenanceLoadError = ref('')
const maintenanceMsg = ref('')
const maintenanceMsgOk = ref(false)
const backups = ref<Array<{ id: string; sizeBytes?: number; createdAt?: number; restoreStatus?: string | null }>>([])
const backupBusy = ref(false)
const diagBusy = ref(false)
const auditBusy = ref(false)
const memoryBusy = ref(false)
const memoryText = ref('')
// ---- 视图体检（浏览器视图诊断：每视图 未挂载/加载中/正常/卡死/崩溃）----
// 状态词表与诊断浮层同源（@shared/view-state）：过去这里自带一套 `responsive` 判断，
// 把"崩溃"显示成"卡死"，而界面为崩溃准备的标签永远不出现（2026-10-16 审查 V1/V4）。
interface ViewProbe {
  storeId: string
  tabId: string
  url: string
  title: string
  loading: boolean
  destroyed: boolean
  attached: boolean
  internal: boolean
  state: BrowserViewState
  reason?: string
}
const viewCheckBusy = ref(false)
const viewCheckResult = ref<ViewProbe[] | null>(null)
function viewStoreName(storeId: string): string {
  // 店铺名从工作区 store 取；设置页可能先于店铺列表加载完成，取不到就退回 id 前缀（不显示空）
  return ws.stores.find(store => store.id === storeId)?.name || storeId.slice(0, 8)
}
function viewStateLabel(v: ViewProbe): string {
  return BROWSER_VIEW_STATE_LABEL[v.state] || v.state
}
async function runViewCheck(): Promise<void> {
  viewCheckBusy.value = true
  viewCheckResult.value = null
  try {
    const result = await window.shopilot.browser.memoryDiagnostics()
    if (!result.ok) throw new Error(responseError(result, '视图体检失败'))
    const data = (result.data || {}) as { views?: ViewProbe[] }
    viewCheckResult.value = data.views ?? []
    // 列表现在含未挂载的视图（主进程侧已改），空列表才是真的"一家店都没打开"
    if (!viewCheckResult.value.length) ws.toast('当前没有打开的店铺视图', 'error')
  } catch (error) {
    const message = '视图体检失败：' + String((error as Error)?.message || error)
    ws.toast(message, 'error')
  } finally {
    viewCheckBusy.value = false
  }
}
// ---- 店铺分区占用与清理（浏览器审查 S-1）----
interface PartitionUsageItem { storeId: string; storeName: string; bytes: number; skipped: number }
const partitionUsage = ref<PartitionUsageItem[]>([])
const partitionBusy = ref(false)
const partitionCleaningId = ref('')
function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
async function readPartitionUsage(): Promise<void> {
  partitionBusy.value = true
  try {
    const result = await window.shopilot.browser.partitionUsage()
    if (!result.ok) { ws.toast('读取失败：' + result.error.message, 'error'); return }
    partitionUsage.value = (result.data as PartitionUsageItem[]) ?? []
  } finally { partitionBusy.value = false }
}
async function cleanPartition(storeId: string): Promise<void> {
  if (!window.confirm('清理该店的浏览器缓存与站点存储？\n登录态（Cookie）保留，不需要重新登录。')) return
  partitionCleaningId.value = storeId
  try {
    const result = await window.shopilot.browser.partitionClean(storeId)
    if (!result.ok) { ws.toast('清理失败：' + result.error.message, 'error'); return }
    ws.toast('已清理（登录态保留）', 'success')
    await readPartitionUsage()
  } finally { partitionCleaningId.value = '' }
}

// ---- 缓存清理与软件诊断（2026-10-16 新增：清除软件缓存 / 清除浏览器缓存 / 诊断软件）----
// 三件事的边界见 shared/software-diagnostics.ts 顶部注释；这里的职责只有"调用 + 如实回显"：
// 文案复用 describeCacheClearResult / summarizeSoftwareChecks，界面不自己编结论。
const appCacheBusy = ref(false)
const browserCacheBusy = ref(false)
const softwareCheckBusy = ref(false)
const cacheResultText = ref('')
const cacheResultOk = ref(true)
const softwareCheckReport = ref<SoftwareDiagnosticsReport | null>(null)
const softwareCheckSummary = computed<SoftwareCheckSummary | null>(() =>
  softwareCheckReport.value ? summarizeSoftwareChecks(softwareCheckReport.value.items) : null
)

async function clearAppCache(): Promise<void> {
  appCacheBusy.value = true
  try {
    const result = await window.shopilot.maintenance.clearAppCache()
    if (!result.ok) { ws.toast('清除软件缓存失败：' + responseError(result, '未知原因'), 'error'); return }
    const described = describeCacheClearResult(result.data as CacheClearResult)
    cacheResultText.value = described.text
    cacheResultOk.value = described.ok
    // performed=false 时不能说"已清理"：什么都没做却弹成功，是这个功能最容易撒的谎
    ws.toast(described.text, described.ok ? (described.performed ? 'success' : 'info') : 'error')
  } finally { appCacheBusy.value = false }
}

async function clearBrowserCache(): Promise<void> {
  if (!window.confirm('清除所有店铺的网页缓存？\n只清缓存：登录态（Cookie）与站点存储保留，不需要重新登录。')) return
  browserCacheBusy.value = true
  try {
    const result = await window.shopilot.maintenance.clearBrowserCache()
    if (!result.ok) { ws.toast('清除浏览器缓存失败：' + responseError(result, '未知原因'), 'error'); return }
    const described = describeCacheClearResult(result.data as CacheClearResult)
    cacheResultText.value = described.text
    cacheResultOk.value = described.ok
    ws.toast(described.text, described.ok ? (described.performed ? 'success' : 'info') : 'error')
  } finally { browserCacheBusy.value = false }
}

async function runSoftwareCheck(): Promise<void> {
  softwareCheckBusy.value = true
  try {
    const result = await window.shopilot.maintenance.softwareDiagnostics()
    if (!result.ok) { ws.toast('软件诊断失败：' + responseError(result, '未知原因'), 'error'); return }
    const report = result.data as SoftwareDiagnosticsReport
    softwareCheckReport.value = report
    const summary = summarizeSoftwareChecks(report.items)
    ws.toast(`软件诊断：${summary.headline}`, summary.status === 'error' ? 'error' : summary.status === 'warn' ? 'info' : 'success')
  } finally { softwareCheckBusy.value = false }
}

const aiProvider = ref('__custom__')
const aiDraft = reactive({ endpoint: DEFAULT_AI_ENDPOINT, model: DEFAULT_AI_MODEL, timeoutMs: DEFAULT_AI_TIMEOUT_MS })
const aiKey = ref('')
const aiHasKey = ref(false)
const aiConfigLoading = ref(false)
const aiLoaded = ref(false)
const aiLoadError = ref('')
const aiSaving = ref(false)
const aiLoading = ref(false)
const aiTesting = ref(false)
const aiMessage = ref('')
const aiOk = ref(false)
const aiModels = ref<string[]>([])

const imageDraft = reactive({ endpoint: DEFAULT_AI_IMAGE_ENDPOINT, model: DEFAULT_AI_IMAGE_MODEL, timeoutMs: DEFAULT_AI_IMAGE_TIMEOUT_MS })
const imageKey = ref('')
const imageHasKey = ref(false)
const imageSaving = ref(false)
const imageLoading = ref(false)
const imageTesting = ref(false)
const imageMessage = ref('')
const imageOk = ref(false)
const imageModels = ref<string[]>([])

const imageTextDraft = reactive({ endpoint: DEFAULT_AI_IMAGE_TEXT_ENDPOINT, model: DEFAULT_AI_IMAGE_TEXT_MODEL, timeoutMs: DEFAULT_AI_IMAGE_TEXT_TIMEOUT_MS })
const imageTextKey = ref('')
const imageTextHasKey = ref(false)
const imageTextConfigLoading = ref(false)
const imageTextLoaded = ref(false)
const imageTextLoadError = ref('')
const imageTextSaving = ref(false)
const imageTextLoading = ref(false)
const imageTextTesting = ref(false)
const imageTextMessage = ref('')
const imageTextOk = ref(false)
const imageTextModels = ref<string[]>([])

const updateChannel = ref('stable')
const updateAutoCheck = ref(false)
const savedUpdateChannel = ref('stable')
const savedUpdateAutoCheck = ref(false)
const updateLoading = ref(false)
const updateLoaded = ref(false)
const updateLoadError = ref('')
const updateChannelSaving = ref(false)
const updateAutoCheckSaving = ref(false)
const updateBusy = ref(false)
const updateStatus = reactive<{ state: string; currentVersion: string; channel?: string; feedSource?: string; version?: string; percent?: number; transferred?: number; total?: number; releaseNotes?: string; error?: string }>({ state: 'idle', currentVersion: '', feedSource: 'dev' })

/** 页签级错误角标：某页签读取失败时在导航常显提示，不用点进去才发现 */
const tabIssues = computed<Record<TabKey, boolean>>(() => ({
  entry: Boolean(homeLoadError.value || squareLoadError.value),
  ai: Boolean(aiLoadError.value || imageTextLoadError.value),
  security: Boolean(securityLoadError.value),
  maintenance: Boolean(maintenanceLoadError.value),
  about: Boolean(updateLoadError.value)
}))

/** 「平台入口」两组地址的规范化快照（空白=未设置，不参与比较） */
function normalizeUrlRecord(draft: Record<string, string>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    const value = String(draft[key] || '').trim()
    if (value) out[key] = value
  }
  return out
}
const homeKeys = platformDefs.map(item => item.name)
/** 有未保存的修改：切页签/关闭前必须确认，绝不静默丢弃 */
const entryDirty = computed(() => {
  if (!homeLoaded.value || !squareLoaded.value) return false
  const home = normalizeUrlRecord(homeDraft, homeKeys)
  const square = normalizeUrlRecord(squareDraft, inviteProfiles.value.map(item => item.platform))
  return JSON.stringify(home) !== JSON.stringify(homeBaseline.value) || JSON.stringify(square) !== JSON.stringify(squareBaseline.value)
})
function snapshotEntryBaseline(): void {
  homeBaseline.value = normalizeUrlRecord(homeDraft, homeKeys)
  squareBaseline.value = normalizeUrlRecord(squareDraft, inviteProfiles.value.map(item => item.platform))
}
function confirmDiscardDrafts(): boolean {
  if (!entryDirty.value) return true
  return window.confirm('「平台入口」有未保存的修改，离开将丢弃这些修改。确定继续？')
}
function requestClose(): void {
  if (!confirmDiscardDrafts()) return
  emit('close')
}

const resolvedEndpoint = computed(() => normalizeAiEndpoint(aiDraft.endpoint))
const modelsUrl = computed(() => modelsUrlFromChat(aiDraft.endpoint) || '')
const imageResolvedEndpoint = computed(() => normalizeImageEndpoint(imageDraft.endpoint))
const imageModelsUrl = computed(() => modelsUrlFromImageEndpoint(imageDraft.endpoint) || '')
const imageTextResolvedEndpoint = computed(() => normalizeAiEndpoint(imageTextDraft.endpoint))
const imageTextModelsUrl = computed(() => modelsUrlFromChat(imageTextDraft.endpoint) || '')
const aiReady = computed(() => Boolean(aiLoaded.value && aiHasKey.value && aiDraft.endpoint.trim() && aiDraft.model.trim() && isUsableAiEndpoint(resolvedEndpoint.value)))
const imageReady = computed(() => Boolean(aiLoaded.value && imageHasKey.value && imageDraft.endpoint.trim() && imageDraft.model.trim() && isUsableAiEndpoint(imageResolvedEndpoint.value)))
const imageTextReady = computed(() => Boolean(imageTextLoaded.value && imageTextHasKey.value && imageTextDraft.endpoint.trim() && imageTextDraft.model.trim() && isUsableAiEndpoint(imageTextResolvedEndpoint.value)))
const configuredSummary = computed(() => {
  if (aiConfigLoading.value || imageTextConfigLoading.value) return '正在读取 AI 配置…'
  if (aiLoadError.value && imageTextLoadError.value) return 'AI 配置读取失败'
  const count = [aiReady.value, imageReady.value, imageTextReady.value].filter(Boolean).length
  return count === 3 ? '三套 AI 配置完整' : '已完成 ' + count + '/3 套 AI 配置'
})
const updateSourceLabel = computed(() => updateStatus.feedSource === 'github' ? 'GitHub Releases' : updateStatus.feedSource === 'env-override' ? '自定义更新源' : '开发环境')
const updateMessage = computed(() => {
  if (updateStatus.state === 'checking') return '正在检查更新…'
  if (updateStatus.state === 'downloading') return '正在下载更新' + (typeof updateStatus.percent === 'number' ? ' · ' + Math.round(updateStatus.percent) + '%' : '')
  if (updateStatus.state === 'available') return '发现新版本 v' + (updateStatus.version || '—')
  if (updateStatus.state === 'downloaded') return '更新 v' + (updateStatus.version || '') + ' 已下载并校验，重启后安装'
  if (updateStatus.state === 'not-available') return updateStatus.error || '当前已是最新版本'
  if (updateStatus.state === 'error') return updateStatus.error || '更新检查失败'
  return updateStatus.feedSource === 'dev' ? '开发环境不支持在线更新检查' : '可以检查更新'
})

function selectTab(tab: TabKey) {
  if (tab !== activeTab.value && !confirmDiscardDrafts()) return
  activeTab.value = tab
  if (tab === 'ai' && !aiLoaded.value && !aiConfigLoading.value) void loadAi()
  if (tab === 'ai' && !imageTextLoaded.value && !imageTextConfigLoading.value) void loadImageTextAi()
  if (tab === 'security' && !securityLoaded.value && !securityLoading.value) void loadSecurity()
  if (tab === 'maintenance' && !collectionLoaded.value && !maintenanceLoading.value) void loadMaintenance()
  if (tab === 'about' && !updateLoaded.value && !updateLoading.value) void loadUpdate()
}

function responseError(result: unknown, fallback: string): string {
  if (!result || typeof result !== 'object' || !('error' in result)) return fallback
  const detail = result.error
  if (!detail || typeof detail !== 'object') return fallback
  const fields = detail as { message?: unknown; code?: unknown }
  return String(fields.message || fields.code || fallback)
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

/** AI 请求会携带 API Key；与 Main 的安全策略保持一致，公网只允许 HTTPS。 */
function isUsableAiEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    if (!url.hostname) return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

function validateAiEndpoint(value: string, label: string, normalizer: (input: string) => string): boolean {
  const endpoint = normalizer(value.trim())
  if (!value.trim()) return true
  if (endpoint && isUsableAiEndpoint(endpoint)) return true
  const message = label + ' 地址无效：公网服务必须使用 HTTPS，本机服务可使用 HTTP。'
  ws.toast(message, 'error')
  return false
}

async function loadPlatformUrls() {
  homeLoading.value = true
  homeLoaded.value = false
  homeLoadError.value = ''
  try {
    const result = await window.shopilot.settings.get('platform.homeUrls')
    if (!result.ok) throw new Error(responseError(result, '读取平台首页地址失败'))
    Object.keys(homeDraft).forEach(key => delete homeDraft[key])
    Object.assign(homeDraft, asStringRecord(result.data?.value))
    homeLoaded.value = true
    snapshotEntryBaseline()
  } catch (error) {
    homeLoaded.value = false
    homeLoadError.value = '读取平台首页地址失败：' + String((error as Error)?.message || error)
  } finally {
    homeLoading.value = false
  }
}

async function loadSquareUrls() {
  squareLoading.value = true
  squareLoaded.value = false
  squareLoadError.value = ''
  try {
    const result = await window.shopilot.settings.get(INVITE_SQUARE_URLS_SETTING)
    if (!result.ok) throw new Error(responseError(result, '读取达人广场地址失败'))
    Object.keys(squareDraft).forEach(key => delete squareDraft[key])
    Object.assign(squareDraft, asStringRecord(result.data?.value))
    squareLoaded.value = true
    snapshotEntryBaseline()
  } catch (error) {
    squareLoaded.value = false
    squareLoadError.value = '读取达人广场地址失败：' + String((error as Error)?.message || error)
  } finally {
    squareLoading.value = false
  }
}

function reloadEntry(): void {
  void loadPlatformUrls()
  void loadSquareUrls()
}

/**
 * 「平台入口」合并保存：一个按钮写两组覆盖值（platform.homeUrls + invite.squareUrls）。
 *
 * 纪律：先整组校验、再逐个写入；第二组失败时**如实报告部分成功**
 * （"平台首页地址已保存，但达人广场地址保存失败：…"），绝不整体静默。
 * 保存成功后**停留在设置中心**（与 AI / 更新保存同一节奏）——旧实现保存即关闭，
 * 与同页其它保存行为不一致（2026-10-15 审查确认）。
 */
async function saveEntry() {
  entryValidationError.value = ''
  const homeNext: Record<string, string> = {}
  for (const platform of platformDefs) {
    const value = (homeDraft[platform.name] || '').trim()
    if (value && !isValidHttpUrl(value)) {
      entryValidationError.value = platform.name + ' 平台首页地址格式无效，请填写完整的 http:// 或 https:// URL。'
      ws.toast(entryValidationError.value, 'error')
      return
    }
    if (value) homeNext[platform.name] = value
  }
  const squareNext: Record<string, string> = {}
  for (const profile of inviteProfiles.value) {
    const value = (squareDraft[profile.platform] || '').trim()
    if (value && !isValidHttpUrl(value)) {
      entryValidationError.value = profile.platform + ' 达人广场地址格式无效，请填写完整的 http:// 或 https:// URL。'
      ws.toast(entryValidationError.value, 'error')
      return
    }
    if (value) squareNext[profile.platform] = value
  }
  entrySaving.value = true
  try {
    const homeResult = await window.shopilot.settings.set('platform.homeUrls', homeNext)
    if (!homeResult.ok) throw new Error('保存平台首页地址失败：' + responseError(homeResult, '保存失败'))
    homeBaseline.value = homeNext
    const squareResult = await window.shopilot.settings.set(INVITE_SQUARE_URLS_SETTING, squareNext)
    if (!squareResult.ok) throw new Error('平台首页地址已保存，但达人广场地址保存失败：' + responseError(squareResult, '保存失败'))
    squareBaseline.value = squareNext
    flashSavedMessage('平台入口配置已保存')
    ws.toast('平台入口配置已保存', 'success')
  } catch (error) {
    entryValidationError.value = String((error as Error)?.message || error)
    ws.toast(entryValidationError.value, 'error')
  } finally {
    entrySaving.value = false
  }
}

// ---------- 应用锁（安全页签） ----------

/** 放弃未保存的修改：两份草稿恢复到最近一次已保存的快照（已保存数据不受影响，不弹确认） */
function discardEntry(): void {
  for (const platform of platformDefs) homeDraft[platform.name] = homeBaseline.value[platform.name] || ''
  for (const profile of inviteProfiles.value) squareDraft[profile.platform] = squareBaseline.value[profile.platform] || ''
  entryValidationError.value = ''
  savedMessage.value = ''
}

function secSay(message: string, ok = true): void {
  securityMsg.value = message
  securityMsgOk.value = ok
}

function applySecurityStatus(data: { enabled?: unknown; idleMinutes?: unknown } | null | undefined): void {
  securityEnabled.value = !!data?.enabled
  const idle = Number(data?.idleMinutes ?? 0)
  securityIdle.value = Number.isFinite(idle) ? idle : 0
  savedIdleMinutes = securityIdle.value
}

async function loadSecurity(): Promise<void> {
  securityLoading.value = true
  securityLoadError.value = ''
  try {
    const result = await window.shopilot.security.status()
    if (!result.ok) throw new Error(responseError(result, '读取应用锁状态失败'))
    applySecurityStatus(result.data)
    securityLoaded.value = true
  } catch (error) {
    securityLoaded.value = false
    securityLoadError.value = '读取应用锁状态失败：' + String((error as Error)?.message || error)
  } finally {
    securityLoading.value = false
  }
}

/** 操作成功后的统一同步：全局（ws.securityEnabled / ws.idleMinutes，左栏与侧栏读它）+ 本地副本 */
async function syncSecurity(): Promise<void> {
  await ws.refreshSecurity()
  const result = await window.shopilot.security.status()
  if (result.ok) applySecurityStatus(result.data)
}

async function submitSetPassword(): Promise<void> {
  if (secPw1.value.length < 8) { secSay('主密码至少 8 位', false); return }
  if (secPw1.value !== secPw2.value) { secSay('两次输入的新主密码不一致', false); return }
  securityBusy.value = true
  try {
    const result = await window.shopilot.security.setPassword(secPw1.value)
    if (!result.ok) throw new Error(responseError(result, '设置主密码失败'))
    secPw1.value = ''
    secPw2.value = ''
    secSay('主密码已设置，可立即锁定或配置空闲自动锁定', true)
    await syncSecurity()
    ws.toast('主密码已设置', 'success')
  } catch (error) {
    secSay('设置主密码失败：' + String((error as Error)?.message || error), false)
  } finally {
    securityBusy.value = false
  }
}

async function submitChangePassword(): Promise<void> {
  if (!secOldPw.value) { secSay('请先输入当前主密码', false); return }
  if (secNewPw.value.length < 8) { secSay('新主密码至少 8 位', false); return }
  if (secNewPw.value !== secNewPw2.value) { secSay('两次输入的新主密码不一致', false); return }
  if (secNewPw.value === secOldPw.value) { secSay('新主密码不能与当前主密码相同', false); return }
  securityBusy.value = true
  try {
    const result = await window.shopilot.security.setPassword(secNewPw.value, secOldPw.value)
    if (!result.ok) throw new Error(responseError(result, '更换主密码失败'))
    secOldPw.value = ''
    secNewPw.value = ''
    secNewPw2.value = ''
    secChangeOpen.value = false
    secSay('主密码已更新（旧密码已失效）', true)
    await syncSecurity()
    ws.toast('主密码已更新', 'success')
  } catch (error) {
    secSay('更换主密码失败：' + String((error as Error)?.message || error), false)
  } finally {
    securityBusy.value = false
  }
}

async function submitRemovePassword(): Promise<void> {
  if (!secRemovePw.value) { secSay('请输入当前主密码以确认移除', false); return }
  securityBusy.value = true
  try {
    const result = await window.shopilot.security.removePassword(secRemovePw.value)
    if (!result.ok) throw new Error(responseError(result, '移除主密码失败'))
    secRemovePw.value = ''
    secRemoveOpen.value = false
    secChangeOpen.value = false
    secSay('主密码已移除，应用锁已解除', true)
    await syncSecurity()
    ws.toast('主密码已移除', 'success')
  } catch (error) {
    secSay('移除主密码失败：' + String((error as Error)?.message || error), false)
  } finally {
    securityBusy.value = false
  }
}

function toggleChangePw(): void {
  secChangeOpen.value = !secChangeOpen.value
  if (secChangeOpen.value) {
    secRemoveOpen.value = false
    securityMsg.value = ''
  }
}

function toggleRemovePw(): void {
  secRemoveOpen.value = !secRemoveOpen.value
  if (secRemoveOpen.value) {
    secChangeOpen.value = false
    secRemovePw.value = ''
    securityMsg.value = ''
  }
}

function cancelRemovePw(): void {
  secRemoveOpen.value = false
  secRemovePw.value = ''
}

async function applyIdleMinutes(): Promise<void> {
  const next = Number(securityIdle.value) || 0
  securityBusy.value = true
  try {
    const result = await window.shopilot.settings.set('security.idleMinutes', next)
    if (!result.ok) throw new Error(responseError(result, '保存失败'))
    savedIdleMinutes = next
    secSay(next ? `空闲 ${next} 分钟自动锁定已启用` : '空闲自动锁定已关闭', true)
    await syncSecurity()
  } catch (error) {
    securityIdle.value = savedIdleMinutes
    secSay('保存空闲自动锁定失败：' + String((error as Error)?.message || error), false)
  } finally {
    securityBusy.value = false
  }
}

async function lockNow(): Promise<void> {
  const result = await window.shopilot.security.lock()
  if (result.ok) await ws.refreshSecurity()
  else secSay(result.error?.message || '锁定失败', false)
}

// ---------- 数据与维护 ----------

function maintenanceSay(message: string, ok = true): void {
  maintenanceMsg.value = message
  maintenanceMsgOk.value = ok
}

async function loadMaintenance(): Promise<void> {
  maintenanceLoading.value = true
  maintenanceLoadError.value = ''
  const errors: string[] = []
  try {
    const [collection, backupList] = await Promise.all([
      window.shopilot.settings.get(AUTO_COLLECTION_SETTING),
      window.shopilot.backup.list()
    ])
    if (collection.ok) {
      collectionEnabled.value = parseAutoCollectionEnabled(collection.data?.value)
      collectionLoaded.value = true
    } else {
      collectionLoaded.value = false
      errors.push('采集总开关：' + responseError(collection, '读取失败'))
    }
    if (backupList.ok) backups.value = ((backupList.data || []) as typeof backups.value).slice(0, 5)
    else errors.push('备份列表：' + responseError(backupList, '读取失败'))
  } catch (error) {
    errors.push(String((error as Error)?.message || error))
  } finally {
    maintenanceLoading.value = false
  }
  if (errors.length) maintenanceLoadError.value = errors.join('；')
}

async function refreshBackups(): Promise<void> {
  const result = await window.shopilot.backup.list()
  if (result.ok) backups.value = ((result.data || []) as typeof backups.value).slice(0, 5)
}

/**
 * 采集总开关（collection.autoEnabled）。默认关闭、读不到按关处理（与主进程 fail-closed 同口径）；
 * 保存失败必须把勾选框**还原**到真实值——勾着但没保存成功就是假状态。
 */
async function applyCollectionSwitch(): Promise<void> {
  const next = collectionEnabled.value === true
  collectionSaving.value = true
  maintenanceMsg.value = ''
  try {
    const result = await window.shopilot.settings.set(AUTO_COLLECTION_SETTING, next)
    if (!result.ok) throw new Error(responseError(result, '保存失败'))
    maintenanceSay(next ? '自动采集总开关已开启（按任务周期自动采集）' : '自动采集总开关已关闭，采集需手动触发', true)
  } catch (error) {
    collectionEnabled.value = !next
    maintenanceSay('保存自动采集总开关失败：' + String((error as Error)?.message || error), false)
  } finally {
    collectionSaving.value = false
  }
}

function formatBackupTime(value: unknown): string {
  const time = Number(value)
  if (!Number.isFinite(time) || time <= 0) return '—'
  return new Date(time).toLocaleString()
}

function formatBackupSize(bytes: unknown): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '—'
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`
}

function formatMemoryBytes(bytes: unknown): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '—'
  return `${(value / 1024 / 1024).toFixed(0)} MB`
}

async function doBackup(): Promise<void> {
  backupBusy.value = true
  maintenanceMsg.value = ''
  try {
    const result = await window.shopilot.backup.create()
    if (!result.ok) throw new Error(responseError(result, '备份失败'))
    ws.toast('数据库备份完成（含校验和）', 'success')
    maintenanceSay('数据库备份完成（含校验和）', true)
    await refreshBackups()
  } catch (error) {
    const message = '备份失败：' + String((error as Error)?.message || error)
    ws.toast(message, 'error')
    maintenanceSay(message, false)
  } finally {
    backupBusy.value = false
  }
}

async function doRestore(backupId: string): Promise<void> {
  if (!window.confirm('恢复将覆盖当前数据库（恢复前会自动创建安全快照）。继续？')) return
  backupBusy.value = true
  maintenanceMsg.value = ''
  try {
    const result = await window.shopilot.backup.restore(backupId)
    if (!result.ok) throw new Error(responseError(result, '恢复失败'))
    ws.toast('已恢复备份，安全快照已保留', 'success')
    maintenanceSay('已恢复备份，安全快照已保留', true)
    await ws.refreshStores()
    await refreshBackups()
  } catch (error) {
    const message = '恢复失败（现有数据未受影响）：' + String((error as Error)?.message || error)
    ws.toast(message, 'error')
    maintenanceSay(message, false)
  } finally {
    backupBusy.value = false
  }
}

async function doDiagnostics(): Promise<void> {
  diagBusy.value = true
  try {
    const result = await window.shopilot.diagnostics.export()
    if (result.ok) {
      ws.toast(`诊断包已导出：${result.data.path}`, 'success')
      maintenanceSay(`诊断包已导出：${result.data.path}`, true)
    } else if (result.error?.code !== 'SESSION_CANCELLED') {
      ws.toast(`导出失败：${result.error?.message || '未知错误'}`, 'error')
      maintenanceSay(`导出失败：${result.error?.message || '未知错误'}`, false)
    }
  } finally {
    diagBusy.value = false
  }
}

async function doAuditExport(): Promise<void> {
  auditBusy.value = true
  try {
    const result = await window.shopilot.audit.export({ limit: 5000 })
    if (result.ok) {
      ws.toast(`审计日志已导出（${result.data.rows} 条）`, 'success')
      maintenanceSay(`审计日志已导出（${result.data.rows} 条）`, true)
    } else if (result.error?.code !== 'SESSION_CANCELLED') {
      ws.toast(`导出失败：${result.error?.message || '未知错误'}`, 'error')
      maintenanceSay(`导出失败：${result.error?.message || '未知错误'}`, false)
    }
  } finally {
    auditBusy.value = false
  }
}

async function readMemoryDiagnostics(): Promise<void> {
  memoryBusy.value = true
  try {
    const result = await window.shopilot.browser.memoryDiagnostics()
    if (!result.ok) throw new Error(responseError(result, '读取内存快照失败'))
    const data = (result.data || {}) as { main?: { rss?: unknown }; totals?: { openStores?: unknown; tabs?: unknown; attachedGuests?: unknown; webContents?: unknown } }
    memoryText.value = `内存 ${formatMemoryBytes(data.main?.rss)} · 店铺 ${Number(data.totals?.openStores) || 0} · 标签 ${Number(data.totals?.tabs) || 0} · guest ${Number(data.totals?.attachedGuests) || 0} · WebContents ${Number(data.totals?.webContents) || 0}`
  } catch (error) {
    memoryText.value = ''
    const message = '读取内存快照失败：' + String((error as Error)?.message || error)
    ws.toast(message, 'error')
    maintenanceSay(message, false)
  } finally {
    memoryBusy.value = false
  }
}

async function loadAi() {
  if (aiConfigLoading.value) return
  aiConfigLoading.value = true
  aiLoaded.value = false
  aiLoadError.value = ''
  try {
    const result = await window.shopilot.ai.configGet()
    if (!result.ok) throw new Error(responseError(result, '读取文本和生图配置失败'))
    aiDraft.endpoint = result.data.endpoint
    aiDraft.model = result.data.model
    aiDraft.timeoutMs = result.data.timeoutMs
    aiHasKey.value = Boolean(result.data.hasKey)
    imageDraft.endpoint = result.data.imageEndpoint || DEFAULT_AI_IMAGE_ENDPOINT
    imageDraft.model = result.data.imageModel || DEFAULT_AI_IMAGE_MODEL
    imageDraft.timeoutMs = result.data.imageTimeoutMs || DEFAULT_AI_IMAGE_TIMEOUT_MS
    imageHasKey.value = Boolean(result.data.hasImageKey)
    aiProvider.value = presets.find(item => item.baseUrl && normalizeAiEndpoint(item.baseUrl) === normalizeAiEndpoint(aiDraft.endpoint))?.key || '__custom__'
    aiLoaded.value = true
  } catch (error) {
    aiLoaded.value = false
    aiLoadError.value = '读取文本和生图配置失败：' + String((error as Error)?.message || error)
  } finally {
    aiConfigLoading.value = false
  }
}

async function loadImageTextAi() {
  if (imageTextConfigLoading.value) return
  imageTextConfigLoading.value = true
  imageTextLoaded.value = false
  imageTextLoadError.value = ''
  try {
    const result = await window.shopilot.ai.imageTextConfigGet()
    if (!result.ok) throw new Error(responseError(result, '读取生图文本配置失败'))
    imageTextDraft.endpoint = result.data.imageTextEndpoint || DEFAULT_AI_IMAGE_TEXT_ENDPOINT
    imageTextDraft.model = result.data.imageTextModel || DEFAULT_AI_IMAGE_TEXT_MODEL
    imageTextDraft.timeoutMs = result.data.imageTextTimeoutMs || DEFAULT_AI_IMAGE_TEXT_TIMEOUT_MS
    imageTextHasKey.value = Boolean(result.data.hasImageTextKey)
    imageTextLoaded.value = true
  } catch (error) {
    imageTextLoaded.value = false
    imageTextLoadError.value = '读取生图文本配置失败：' + String((error as Error)?.message || error)
  } finally {
    imageTextConfigLoading.value = false
  }
}

function applyPreset() {
  const preset = presets.find(item => item.key === aiProvider.value)
  if (!preset?.baseUrl) return
  aiDraft.endpoint = preset.baseUrl
  if (preset.models.length) aiDraft.model = preset.models[0]
}

function validateTimeout(value: unknown, min: number, max: number, label: string): number | null {
  const timeout = Number(value)
  if (!Number.isFinite(timeout) || timeout < min || timeout > max) {
    ws.toast(label + '必须在 ' + min + ' 至 ' + max + ' 毫秒之间。', 'error')
    return null
  }
  return Math.round(timeout)
}

async function saveAi(notify = true): Promise<boolean> {
  if (!validateAiEndpoint(aiDraft.endpoint, '文本 API', normalizeAiEndpoint)) {
    aiMessage.value = '文本 API 地址无效：公网服务必须使用 HTTPS，本机服务可使用 HTTP。'
    aiOk.value = false
    return false
  }
  const timeoutMs = validateTimeout(aiDraft.timeoutMs, AI_TIMEOUT_MIN_MS, AI_TIMEOUT_MAX_MS, '文本超时')
  if (timeoutMs === null) { aiMessage.value = '文本超时值无效'; aiOk.value = false; return false }
  aiSaving.value = true
  aiMessage.value = ''
  try {
    const result = await window.shopilot.ai.configSet({ endpoint: aiDraft.endpoint.trim(), model: aiDraft.model.trim(), timeoutMs })
    if (!result.ok) throw new Error(responseError(result, '保存文本 AI 配置失败'))
    aiHasKey.value = Boolean(result.data.hasKey)
    if (aiKey.value.trim()) {
      const keyResult = await window.shopilot.ai.setKey(aiKey.value.trim())
      if (!keyResult.ok) throw new Error('文本配置已保存，但 API Key 保存失败：' + responseError(keyResult, '请检查密钥后重试'))
      aiHasKey.value = Boolean(keyResult.data.hasKey)
      aiKey.value = ''
    }
    savedMessage.value = '文本 API 配置已保存'
    aiMessage.value = '文本 API 配置已保存'
    aiOk.value = true
    if (notify) ws.toast(aiMessage.value, 'success')
    return true
  } catch (error) {
    aiMessage.value = String((error as Error)?.message || error)
    aiOk.value = false
    ws.toast(aiMessage.value, 'error')
    return false
  } finally {
    aiSaving.value = false
  }
}

async function saveImageAi(notify = true): Promise<boolean> {
  if (!validateAiEndpoint(imageDraft.endpoint, '生图 API', normalizeImageEndpoint)) {
    imageMessage.value = '生图 API 地址无效：公网服务必须使用 HTTPS，本机服务可使用 HTTP。'
    imageOk.value = false
    return false
  }
  const timeoutMs = validateTimeout(imageDraft.timeoutMs, AI_TIMEOUT_MIN_MS, AI_IMAGE_TIMEOUT_MAX_MS, '生图超时')
  if (timeoutMs === null) { imageMessage.value = '生图超时值无效'; imageOk.value = false; return false }
  imageSaving.value = true
  imageMessage.value = ''
  try {
    const result = await window.shopilot.ai.imageConfigSet({ endpoint: imageDraft.endpoint.trim(), model: imageDraft.model.trim(), timeoutMs })
    if (!result.ok) throw new Error(responseError(result, '保存生图 API 配置失败'))
    imageHasKey.value = Boolean(result.data.hasImageKey)
    if (imageKey.value.trim()) {
      const keyResult = await window.shopilot.ai.setImageKey(imageKey.value.trim())
      if (!keyResult.ok) throw new Error('生图配置已保存，但 API Key 保存失败：' + responseError(keyResult, '请检查密钥后重试'))
      imageHasKey.value = Boolean(keyResult.data.hasImageKey)
      imageKey.value = ''
    }
    savedMessage.value = '生图 API 配置已保存'
    imageMessage.value = '生图 API 配置已保存'
    imageOk.value = true
    if (notify) ws.toast(imageMessage.value, 'success')
    return true
  } catch (error) {
    imageMessage.value = String((error as Error)?.message || error)
    imageOk.value = false
    ws.toast(imageMessage.value, 'error')
    return false
  } finally {
    imageSaving.value = false
  }
}

async function saveImageTextAi(notify = true): Promise<boolean> {
  if (!validateAiEndpoint(imageTextDraft.endpoint, '分析文本 API', normalizeAiEndpoint)) {
    imageTextMessage.value = '分析文本 API 地址无效：公网服务必须使用 HTTPS，本机服务可使用 HTTP。'
    imageTextOk.value = false
    return false
  }
  const timeoutMs = validateTimeout(imageTextDraft.timeoutMs, AI_TIMEOUT_MIN_MS, AI_TIMEOUT_MAX_MS, '分析文本超时')
  if (timeoutMs === null) { imageTextMessage.value = '分析文本超时值无效'; imageTextOk.value = false; return false }
  imageTextSaving.value = true
  imageTextMessage.value = ''
  try {
    const result = await window.shopilot.ai.imageTextConfigSet({ endpoint: imageTextDraft.endpoint.trim(), model: imageTextDraft.model.trim(), timeoutMs })
    if (!result.ok) throw new Error(responseError(result, '保存生图文本 API 配置失败'))
    imageTextHasKey.value = Boolean(result.data.hasImageTextKey)
    if (imageTextKey.value.trim()) {
      const keyResult = await window.shopilot.ai.setImageTextKey(imageTextKey.value.trim())
      if (!keyResult.ok) throw new Error('分析文本配置已保存，但 API Key 保存失败：' + responseError(keyResult, '请检查密钥后重试'))
      imageTextHasKey.value = Boolean(keyResult.data.hasImageTextKey)
      imageTextKey.value = ''
    }
    savedMessage.value = '生图文本 API 配置已保存'
    imageTextMessage.value = '生图文本 API 配置已保存'
    imageTextOk.value = true
    if (notify) ws.toast(imageTextMessage.value, 'success')
    return true
  } catch (error) {
    imageTextMessage.value = String((error as Error)?.message || error)
    imageTextOk.value = false
    ws.toast(imageTextMessage.value, 'error')
    return false
  } finally {
    imageTextSaving.value = false
  }
}

async function fetchModels() {
  aiLoading.value = true
  aiModels.value = []
  try {
    if (!await saveAi(false)) return
    const result = await window.shopilot.ai.listModels()
    if (!result.ok) throw new Error(responseError(result, '获取文本模型失败'))
    aiModels.value = result.data.models
    aiMessage.value = '已获取 ' + result.data.models.length + ' 个文本模型'
    aiOk.value = true
  } catch (error) {
    aiMessage.value = '获取文本模型失败：' + String((error as Error)?.message || error)
    aiOk.value = false
  } finally {
    aiLoading.value = false
  }
}

function pickAiModel(name: string) { if (name) aiDraft.model = name }

async function testAi() {
  aiTesting.value = true
  try {
    if (!await saveAi(false)) return
    const result = await window.shopilot.ai.test()
    if (!result.ok) throw new Error(responseError(result, '连接失败'))
    aiMessage.value = '连接成功：' + result.data.model + ' · ' + result.data.elapsedMs + 'ms'
    aiOk.value = true
  } catch (error) {
    aiMessage.value = '连接失败：' + String((error as Error)?.message || error)
    aiOk.value = false
  } finally {
    aiTesting.value = false
  }
}

async function clearKey() {
  if (!window.confirm('确认清除文本 API Key？')) return
  try {
    const result = await window.shopilot.ai.clearKey()
    if (!result.ok) throw new Error(responseError(result, '清除文本 API Key 失败'))
    aiHasKey.value = false
    aiMessage.value = '文本 API Key 已清除'
    aiOk.value = true
  } catch (error) {
    aiMessage.value = '清除文本 API Key 失败：' + String((error as Error)?.message || error)
    aiOk.value = false
    ws.toast(aiMessage.value, 'error')
  }
}

async function fetchImageModels() {
  imageLoading.value = true
  imageModels.value = []
  try {
    if (!await saveImageAi(false)) return
    const result = await window.shopilot.ai.listImageModels()
    if (!result.ok) throw new Error(responseError(result, '获取生图模型失败'))
    imageModels.value = result.data.models
    imageMessage.value = '已获取 ' + result.data.models.length + ' 个生图模型'
    imageOk.value = true
  } catch (error) {
    imageMessage.value = '获取生图模型失败：' + String((error as Error)?.message || error)
    imageOk.value = false
  } finally {
    imageLoading.value = false
  }
}

async function testImageAi() {
  imageTesting.value = true
  try {
    if (!await saveImageAi(false)) return
    const result = await window.shopilot.ai.testImage()
    if (!result.ok) throw new Error(responseError(result, '生图接口测试失败'))
    imageMessage.value = '生图接口可用：模型 ' + result.data.model + ' · ' + result.data.elapsedMs + 'ms'
    imageOk.value = true
  } catch (error) {
    imageMessage.value = '生图接口失败：' + String((error as Error)?.message || error)
    imageOk.value = false
  } finally {
    imageTesting.value = false
  }
}

async function clearImageKey() {
  if (!window.confirm('确认清除生图 API Key？')) return
  try {
    const result = await window.shopilot.ai.clearImageKey()
    if (!result.ok) throw new Error(responseError(result, '清除生图 API Key 失败'))
    imageHasKey.value = false
    imageMessage.value = '生图 API Key 已清除'
    imageOk.value = true
  } catch (error) {
    imageMessage.value = '清除生图 API Key 失败：' + String((error as Error)?.message || error)
    imageOk.value = false
    ws.toast(imageMessage.value, 'error')
  }
}

function pickImageModel(name: string) { if (name) imageDraft.model = name }

async function fetchImageTextModels() {
  imageTextLoading.value = true
  imageTextModels.value = []
  try {
    if (!await saveImageTextAi(false)) return
    const result = await window.shopilot.ai.listImageTextModels()
    if (!result.ok) throw new Error(responseError(result, '获取分析模型失败'))
    imageTextModels.value = result.data.models
    imageTextMessage.value = '已获取 ' + result.data.models.length + ' 个分析模型'
    imageTextOk.value = true
  } catch (error) {
    imageTextMessage.value = '获取分析模型失败：' + String((error as Error)?.message || error)
    imageTextOk.value = false
  } finally {
    imageTextLoading.value = false
  }
}

async function testImageTextAi() {
  imageTextTesting.value = true
  try {
    if (!await saveImageTextAi(false)) return
    const result = await window.shopilot.ai.testImageText()
    if (!result.ok) throw new Error(responseError(result, '分析接口测试失败'))
    imageTextMessage.value = '分析接口可用：模型 ' + result.data.model + ' · ' + result.data.elapsedMs + 'ms'
    imageTextOk.value = true
  } catch (error) {
    imageTextMessage.value = '分析接口失败：' + String((error as Error)?.message || error)
    imageTextOk.value = false
  } finally {
    imageTextTesting.value = false
  }
}

async function clearImageTextKey() {
  if (!window.confirm('确认清除生图文本 API Key？')) return
  try {
    const result = await window.shopilot.ai.clearImageTextKey()
    if (!result.ok) throw new Error(responseError(result, '清除分析 API Key 失败'))
    imageTextHasKey.value = false
    imageTextMessage.value = '生图文本 API Key 已清除'
    imageTextOk.value = true
  } catch (error) {
    imageTextMessage.value = '清除分析 API Key 失败：' + String((error as Error)?.message || error)
    imageTextOk.value = false
    ws.toast(imageTextMessage.value, 'error')
  }
}

function pickImageTextModel(name: string) { if (name) imageTextDraft.model = name }

async function loadUpdate() {
  if (updateLoading.value) return
  updateLoading.value = true
  updateLoaded.value = false
  updateLoadError.value = ''
  try {
    const [channel, autoCheck, status] = await Promise.all([
      window.shopilot.settings.get('update.channel'),
      window.shopilot.settings.get('update.autoCheck'),
      window.shopilot.update.status()
    ])
    const errors: string[] = []
    if (channel.ok) {
      updateChannel.value = ['stable', 'beta'].includes(channel.data?.value) ? channel.data.value : 'stable'
      savedUpdateChannel.value = updateChannel.value
    } else errors.push('更新通道：' + responseError(channel, '读取失败'))
    if (autoCheck.ok) {
      updateAutoCheck.value = autoCheck.data?.value === true
      savedUpdateAutoCheck.value = updateAutoCheck.value
    } else errors.push('自动检查：' + responseError(autoCheck, '读取失败'))
    if (status.ok) Object.assign(updateStatus, status.data)
    else errors.push('更新状态：' + responseError(status, '读取失败'))
    if (errors.length) throw new Error(errors.join('；'))
    updateLoaded.value = true
  } catch (error) {
    updateLoaded.value = false
    updateLoadError.value = '读取更新设置失败：' + String((error as Error)?.message || error)
  } finally {
    updateLoading.value = false
  }
}

async function saveUpdateChannel() {
  const next = updateChannel.value
  updateChannelSaving.value = true
  try {
    const result = await window.shopilot.settings.set('update.channel', next)
    if (!result.ok) throw new Error(responseError(result, '保存更新通道失败'))
    savedUpdateChannel.value = next
    savedMessage.value = '更新通道已切换为' + (next === 'beta' ? '测试版' : '稳定版')
    ws.toast(savedMessage.value, 'success')
  } catch (error) {
    updateChannel.value = savedUpdateChannel.value
    ws.toast('保存更新通道失败：' + String((error as Error)?.message || error), 'error')
  } finally {
    updateChannelSaving.value = false
  }
}

async function saveUpdateAutoCheck() {
  const next = updateAutoCheck.value
  updateAutoCheckSaving.value = true
  try {
    const result = await window.shopilot.settings.set('update.autoCheck', next)
    if (!result.ok) throw new Error(responseError(result, '保存启动自动检查失败'))
    savedUpdateAutoCheck.value = next
    savedMessage.value = next ? '启动自动检查已开启' : '启动自动检查已关闭'
    ws.toast(savedMessage.value, 'success')
  } catch (error) {
    updateAutoCheck.value = savedUpdateAutoCheck.value
    ws.toast('保存启动自动检查失败：' + String((error as Error)?.message || error), 'error')
  } finally {
    updateAutoCheckSaving.value = false
  }
}

async function checkUpdate() {
  if (updateBusy.value) return
  updateBusy.value = true
  Object.assign(updateStatus, { state: 'checking', error: undefined })
  try {
    const result = await window.shopilot.update.check()
    if (!result.ok) throw new Error(responseError(result, '更新检查失败'))
    Object.assign(updateStatus, result.data)
  } catch (error) {
    Object.assign(updateStatus, { state: 'error', error: String((error as Error)?.message || error) })
  } finally {
    updateBusy.value = false
  }
}

async function downloadUpdate() {
  if (updateBusy.value) return
  updateBusy.value = true
  Object.assign(updateStatus, { state: 'downloading', percent: 0, error: undefined })
  try {
    const result = await window.shopilot.update.download()
    if (!result.ok) throw new Error(responseError(result, '更新下载失败'))
    Object.assign(updateStatus, result.data)
  } catch (error) {
    Object.assign(updateStatus, { state: 'error', error: String((error as Error)?.message || error) })
  } finally {
    updateBusy.value = false
  }
}

async function installUpdate() {
  if (updateBusy.value) return
  updateBusy.value = true
  try {
    const result = await window.shopilot.update.install()
    if (!result.ok) throw new Error(responseError(result, '启动更新安装失败'))
    Object.assign(updateStatus, result.data)
  } catch (error) {
    Object.assign(updateStatus, { state: 'error', error: String((error as Error)?.message || error) })
  } finally {
    updateBusy.value = false
  }
}

function onUpdateStatus(payload: unknown) {
  if (payload && typeof payload === 'object') Object.assign(updateStatus, payload)
}

watch(() => aiDraft.endpoint, () => {
  aiModels.value = []
  aiProvider.value = presets.find(item => item.baseUrl && normalizeAiEndpoint(item.baseUrl) === normalizeAiEndpoint(aiDraft.endpoint))?.key || '__custom__'
})
watch(() => imageDraft.endpoint, () => { imageModels.value = [] })
watch(() => imageTextDraft.endpoint, () => { imageTextModels.value = [] })
watch(homeDraft, () => { entryValidationError.value = '' }, { deep: true })
watch(squareDraft, () => { entryValidationError.value = '' }, { deep: true })
watch(() => props.initialTab, value => { if (value) selectTab(value) })

onMounted(() => {
  window.shopilot.on(EVENT_CHANNELS.UPDATE_STATUS_CHANGED, onUpdateStatus)
  window.shopilot.on(EVENT_CHANNELS.UPDATE_PROGRESS, onUpdateStatus)
  void loadPlatformUrls()
  void loadSquareUrls()
  void loadAi()
  void loadImageTextAi()
  if (activeTab.value === 'about') void loadUpdate()
  if (activeTab.value === 'security') void loadSecurity()
  if (activeTab.value === 'maintenance') void loadMaintenance()
})

onBeforeUnmount(() => {
  if (savedMessageTimer) clearTimeout(savedMessageTimer)
  window.shopilot.off(EVENT_CHANNELS.UPDATE_STATUS_CHANGED, onUpdateStatus)
  window.shopilot.off(EVENT_CHANNELS.UPDATE_PROGRESS, onUpdateStatus)
})
</script>

<style scoped>
.button-icon{width:16px;height:16px;object-fit:contain;vertical-align:-3px;margin-right:4px}.unified-page{min-width:0;min-height:0;height:100%;overflow:auto;padding:22px 24px 32px;color:var(--dash-text)}.unified-page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:16px}.unified-page-head h1{margin:5px 0 7px;font-size:25px}.unified-page-head p{margin:0;color:var(--dash-text-muted);font-size:12px}.settings-save-state{color:#027a48;font-size:11px}.settings-layout{display:grid;grid-template-columns:190px minmax(0,1fr);gap:12px;min-height:0}.settings-nav{display:flex;flex-direction:column;gap:4px;padding:8px;border:1px solid var(--dash-border);border-radius:13px;background:#ecedee;align-self:start}.settings-nav button{display:flex;align-items:center;gap:9px;height:38px;padding:0 10px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dash-text-muted);text-align:left;cursor:pointer}.settings-nav button:hover,.settings-nav button:focus-visible{background:rgba(124,92,255,.12);color:var(--dash-text);outline:none}.settings-nav button.active{border-color:rgba(135,102,246,.42);background:rgba(112,76,232,.18);color:#4c1d95}.settings-nav span{width:18px;color:#5b3df5;text-align:center}.settings-nav .settings-tab-icon{width:17px;height:17px;object-fit:contain}.settings-content{min-width:0}.settings-section{padding:19px;border:1px solid var(--dash-border);border-radius:13px;background:#ffffff}.settings-section-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:18px}.settings-section h2{margin:0 0 6px;font-size:17px}.settings-section p{margin:0;color:var(--dash-text-muted);font-size:11px}.unified-button{min-height:32px;padding:0 13px;border:1px solid var(--dash-border);border-radius:9px;background:#ffffff;color:var(--dash-text-soft);cursor:pointer}.unified-button:hover,.unified-button:focus-visible{border-color:rgba(151,120,255,.7);color:var(--dash-text);outline:none}.unified-button.primary{border-color:#5b3df5;background:#6d4aff;color:#ffffff}.unified-button.danger{border-color:rgba(217,45,32,.35);color:#d92d20}.unified-button:disabled{opacity:.55;cursor:not-allowed}.settings-field-row{display:flex;align-items:end;gap:10px;margin:11px 0}.settings-field-row label,.settings-field{display:flex;flex-direction:column;gap:6px;flex:1;color:var(--dash-text-soft);font-size:11px}.settings-field-row input,.settings-field input,.settings-field select{height:34px;padding:0 10px;border:1px solid var(--dash-border);border-radius:8px;background:#f7f9fd;color:var(--dash-text-soft);outline:none}.settings-field-row input:focus,.settings-field input:focus,.settings-field select:focus{border-color:rgba(145,113,255,.78);box-shadow:0 0 0 2px rgba(145,113,255,.14)}.settings-note{margin-top:14px;padding:10px 12px;border-radius:8px;background:#edeef0;color:var(--dash-text-muted);font-size:11px;line-height:1.6}.settings-note.ok{border:1px solid rgba(32,209,154,.35);color:#027a48}.settings-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:14px}.about-hero{display:flex;align-items:center;gap:12px;padding-bottom:18px;border-bottom:1px solid var(--dash-border)}.about-mark img{width:34px;height:34px;object-fit:contain}.about-mark{display:grid;width:46px;height:46px;place-items:center;border-radius:13px;background:linear-gradient(135deg,#f3f0fc,#a280ff);color:#fff;font-size:24px;box-shadow:0 0 24px rgba(135,102,246,.4)}.about-hero h2{margin:0}.about-hero p{margin:5px 0 0}.about-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:18px}.about-grid>div{display:flex;flex-direction:column;gap:7px;padding:12px;border-radius:9px;background:#f7f9fd}.about-grid span{color:var(--dash-text-muted);font-size:10px}.about-grid strong{font-size:15px}.about-grid select{height:29px;border:1px solid var(--dash-border);border-radius:6px;background:#ffffff;color:var(--dash-text-soft)}.about-toggle{justify-content:space-between}.update-autocheck{display:flex;align-items:center;gap:7px;color:var(--dash-text-soft);font-size:11px;cursor:pointer}.update-autocheck input{accent-color:#8c5cff}.update-autocheck em{font-style:normal;color:var(--dash-text-muted)}.update-message{margin-left:auto;color:var(--dash-text-muted);font-size:11px}.update-message.not-available{color:#027a48}.update-message.error{color:#f04438}
@media(max-width:820px){.settings-layout{grid-template-columns:1fr}.settings-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.about-grid{grid-template-columns:1fr}.settings-field-row{align-items:stretch;flex-direction:column}}
.ai-settings-section{min-height:0}.ai-config-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.ai-config-card{min-width:0;padding:15px;border:1px solid rgba(111,134,183,.22);border-radius:11px;background:rgba(8,16,30,.42)}.image-ai-config-card{border-color:rgba(147,105,255,.32);background:linear-gradient(145deg,rgba(41,29,76,.28),#f7f9fd)}.image-text-ai-config-card{border-color:rgba(74,191,218,.3);background:linear-gradient(145deg,rgba(18,67,84,.2),#f7f9fd)}.ai-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:14px}.ai-card-head h3{margin:4px 0 5px;font-size:15px}.ai-card-head p{margin:0;color:var(--dash-text-muted);font-size:10px;line-height:1.5}.settings-kicker{color:#9b83ef;font-size:9px;letter-spacing:.14em}.ai-status{padding:4px 7px;border:1px solid rgba(229,168,86,.28);border-radius:999px;color:#b54708;font-size:9px}.ai-status.ok{border-color:rgba(34,209,157,.3);color:#027a48}.image-model-picker{margin-top:12px}.ai-config-card .settings-note{word-break:break-word}.ai-config-card code{color:#5b3df5;font-size:10px}@media(max-width:1260px){.ai-config-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:900px){.ai-config-grid{grid-template-columns:1fr}}
/* 页面底与页头（压缩高度、去掉重阴影；三代叠加的装饰性标签已随页面重构移除） */
.unified-settings-page{background:radial-gradient(circle at 86% 0%,rgba(113,82,224,.08),transparent 26%),linear-gradient(145deg,#f2f3f5,#eef0f3)}
.settings-hero{position:relative;align-items:center;padding:14px 18px;border:1px solid #e6e9f0;border-radius:16px;background:linear-gradient(135deg,#ffffff,#fafbfe);box-shadow:0 10px 26px rgba(30,41,74,.06);overflow:hidden}
.settings-hero:after{content:'';position:absolute;right:-40px;bottom:-70px;width:220px;height:180px;border-radius:50%;background:rgba(121,87,238,.09);filter:blur(22px);pointer-events:none}
.settings-title-block{display:flex;align-items:center;gap:12px;position:relative;z-index:1}
.settings-title-icon img{width:22px;height:22px;object-fit:contain}.settings-title-icon{display:grid;width:42px;height:42px;place-items:center;border:1px solid rgba(166,139,255,.32);border-radius:12px;background:linear-gradient(145deg,#f6f3ff,#f0f0f8);box-shadow:0 8px 18px rgba(115,83,240,.12);font-size:20px}
.settings-hero h1{margin:3px 0 5px;font-size:22px;letter-spacing:-.03em}
.settings-hero p{max-width:680px;font-size:11.5px}
.settings-head-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;position:relative;z-index:1}
.settings-save-state{display:inline-flex;align-items:center;gap:7px;padding:6px 11px;border:1px solid #b8e5d1;border-radius:999px;background:#f0fbf5;color:#087443;font-size:11px;animation:settingsFadeIn .18s ease-out}
.settings-save-state i{width:7px;height:7px;border-radius:50%;background:#12b76a;box-shadow:0 0 0 3px rgba(18,183,106,.14)}
@keyframes settingsFadeIn{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:translateY(0)}}
/* 左侧页签导航 */
.settings-nav{position:sticky;top:16px;padding:10px;border:1px solid #e6e9f0;border-radius:14px;background:linear-gradient(170deg,#ffffff,#f4f5f8);box-shadow:0 10px 26px rgba(30,41,74,.06)}
.settings-nav-title{display:flex;flex-direction:column;gap:4px;padding:6px 9px 12px;border-bottom:1px solid #eceff5}
.settings-nav-title span{color:#7f8eac;font-size:8px;letter-spacing:.16em}
.settings-nav-title strong{color:#4a5568;font-size:12px}
.settings-nav button{position:relative;transition:background .18s,border-color .18s,color .18s,transform .18s}
.settings-nav button em{font-style:normal;flex:1}
.settings-nav button b img{width:14px;height:14px;object-fit:contain}.settings-nav button b{opacity:0;margin-left:auto;color:#5b3df5;font-size:18px;font-weight:400;line-height:1;transform:translateX(-3px);transition:opacity .18s,transform .18s}
.settings-nav button:hover b,.settings-nav button:focus-visible b,.settings-nav button.active b{opacity:1;transform:translateX(0)}
.settings-nav button.active{box-shadow:0 7px 18px rgba(95,63,216,.18)}
.settings-nav button.active::before{content:'';position:absolute;left:3px;top:9px;bottom:9px;width:3px;border-radius:3px;background:#7c5cf4}

/* 分区与分区头 */
.settings-section{padding:20px 22px;border:1px solid #e7eaf0;border-radius:16px;background:#ffffff;box-shadow:0 12px 30px rgba(30,41,74,.06)}
.settings-section-head{padding-bottom:15px;margin-bottom:16px;border-bottom:1px solid #eef1f6}
.settings-section-head h2{font-size:16px;letter-spacing:-.01em}
.settings-head-actions-row{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.settings-unsaved{display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border:1px solid #f0d7aa;border-radius:999px;background:#fffaf1;color:#9a5b08;font-size:10px;font-weight:600;white-space:nowrap}
.settings-unsaved::before{width:6px;height:6px;border-radius:50%;background:#eaaa43;content:''}

/* 字段行 / 输入控件 */
.settings-field-row{padding:11px 0;margin:0;border-bottom:1px solid #f1f4f8}
.settings-field-row:last-of-type{border-bottom:0}
.settings-field-row label span{font-weight:600;color:#4a5568}
.settings-field{margin-top:13px}
.settings-field>span{font-weight:600;color:#4a5568}
.settings-field input,.settings-field select{transition:border-color .18s,box-shadow .18s,background .18s}
.settings-field input::placeholder{color:#98a2b3}
.settings-group .settings-field-row input:not([type='checkbox']),.settings-group .settings-field input:not([type='checkbox']),.settings-group .settings-field select{background:#ffffff;border-color:#dfe3ec;border-radius:9px}
.settings-group .settings-field-row input:not([type='checkbox']):hover,.settings-group .settings-field input:not([type='checkbox']):hover,.settings-group .settings-field select:hover{border-color:#c9d2e0}

/* 通用按钮（与 AI 卡片内按钮同高；主色悬浮轻微提亮） */
.settings-section .unified-button{min-height:34px;transition:border-color .16s,color .16s,background .16s,box-shadow .16s,filter .16s}
.settings-section .unified-button.primary{box-shadow:0 5px 12px rgba(105,65,224,.18)}
.settings-section .unified-button.primary:hover:not(:disabled){filter:brightness(1.05)}
.settings-section .unified-button.ghost:hover:not(:disabled){background:#f7f8fb}

/* 说明 / 提示 / 反馈 */
.settings-note{margin-top:12px;padding:10px 12px;border:1px solid #edf0f5;border-radius:10px;background:#f7f8fa;color:#667085}
.settings-hint{margin:8px 0 0;color:#667085;font-size:10.5px;line-height:1.6}
.ai-config-summary{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 14px;padding:14px 16px;border:1px solid rgba(112,135,190,.2);border-radius:13px;background:linear-gradient(120deg,#edeef0,#ecedef)}
.ai-summary-copy{display:flex;min-width:220px;flex-direction:column;gap:5px}
.ai-summary-copy strong{font-size:15px;color:#4a5568}
.ai-summary-copy p{font-size:10px}
.ai-summary-statuses{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.ai-summary-status{display:flex;align-items:center;gap:7px;min-width:118px;padding:8px 9px;border:1px solid rgba(225,168,92,.2);border-radius:9px;background:rgba(8,15,29,.36);color:#4a5568}
.ai-summary-status i{width:7px;height:7px;border-radius:50%;background:#e3ac65}
.ai-summary-status b{font-size:10px}
.ai-summary-status em{margin-left:auto;color:#8c9ab5;font-size:9px;font-style:normal}
.ai-summary-status.ready{border-color:rgba(38,213,166,.25)}
.ai-summary-status.ready i{background:#33d9a7;box-shadow:0 0 9px rgba(51,217,167,.65)}
.ai-summary-status.ready em{color:#027a48}
.ai-config-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.ai-config-card{padding:18px;border-radius:14px;box-shadow:0 12px 26px rgba(0,0,0,.14);transition:transform .18s,border-color .18s,box-shadow .18s}
.ai-config-card:hover{transform:translateY(-2px);box-shadow:0 17px 34px rgba(0,0,0,.22)}
.image-text-ai-config-card{grid-column:1/-1}
.ai-card-head{min-height:64px;padding-bottom:13px;border-bottom:1px solid #eef1f7}
.ai-card-head h3{font-size:16px}
.ai-card-head p{max-width:420px}
.ai-config-card .settings-actions{padding-top:13px;border-top:1px solid rgba(112,135,184,.12)}
.ai-config-card .settings-actions .unified-button.primary{box-shadow:0 7px 16px rgba(105,65,224,.24)}
.ai-config-card .settings-note{border:1px solid #eef1f7;background:#ebeced}
.settings-nav button:focus-visible,.unified-button:focus-visible,.settings-field-row input:focus-visible,.settings-field input:focus-visible,.settings-field select:focus-visible,.settings-switch:focus-visible{box-shadow:0 0 0 3px rgba(145,113,255,.2)}
@media(max-width:1180px){.settings-hero{padding:13px 16px}.ai-config-summary{align-items:flex-start;flex-direction:column}.ai-summary-statuses{justify-content:flex-start;width:100%}}
@media(max-width:820px){.unified-page{padding:16px}.settings-hero{align-items:flex-start;flex-direction:column}.settings-head-actions{justify-content:flex-start}.settings-nav{position:static}.settings-section{padding:16px}.settings-section-head{flex-direction:column}.settings-head-actions-row{justify-content:flex-start}.ai-summary-statuses{display:grid;grid-template-columns:1fr}.ai-summary-status{width:100%}}

/* AI providers are independent services, so keep each setup and its actions in one card. */
.ai-config-summary{border-color:rgba(112,76,232,.16);background:linear-gradient(110deg,#fff 0%,#f7f5ff 62%,#f2f8ff 100%);box-shadow:0 8px 22px rgba(42,50,79,.06)}
.ai-summary-status{border-color:#e7e9f0;background:#fff;color:#475467}
.ai-summary-status em{color:#667085}
.ai-config-card{--ai-accent:#7054e8;position:relative;display:flex;min-width:0;flex-direction:column;overflow:hidden;border:1px solid #e4e7ef;border-radius:16px;background:linear-gradient(180deg,#fff 0%,#fbfbfd 100%);box-shadow:0 8px 22px rgba(36,43,66,.07);transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease}
.ai-config-card::before{position:absolute;inset:0 0 auto;height:3px;background:linear-gradient(90deg,var(--ai-accent),color-mix(in srgb,var(--ai-accent) 24%,#fff));content:''}
.ai-config-card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--ai-accent) 28%,#e4e7ef);box-shadow:0 14px 30px rgba(36,43,66,.11)}
.image-ai-config-card{--ai-accent:#7758e8;border-color:#e7e2f7;background:linear-gradient(180deg,#fff 0%,#fcfbff 100%)}
.image-text-ai-config-card{--ai-accent:#258ca5;border-color:#dcecf0;background:linear-gradient(180deg,#fff 0%,#f9fcfd 100%)}
.ai-card-head{min-height:78px;margin-bottom:2px;border-color:#edf0f5}
.ai-card-head h3{color:#202939;letter-spacing:-.02em}
.ai-card-head p{color:#667085;font-size:11px}
.ai-card-head .settings-kicker{color:var(--ai-accent);font-weight:700}
.ai-status{display:inline-flex;flex:none;align-items:center;gap:6px;border-color:#f0d7aa;background:#fffaf1;color:#9a5b08;font-size:10px;font-weight:600;white-space:nowrap}
.ai-status::before{width:6px;height:6px;border-radius:50%;background:#eaaa43;content:''}
.ai-status.ok{border-color:#b8e5d1;background:#f0fbf5;color:#087443}
.ai-status.ok::before{background:#12a66a;box-shadow:0 0 0 3px rgba(18,166,106,.12)}
.ai-config-card .settings-field{gap:7px;color:#475467}
.ai-config-card .settings-field>span{font-size:11px;font-weight:600;color:#475467}
.ai-config-card .settings-field input,.ai-config-card .settings-field select{height:38px;border-color:#dfe3ec;border-radius:9px;background:#fff;color:#344054}
.ai-config-card .settings-field input:focus,.ai-config-card .settings-field select:focus{border-color:color-mix(in srgb,var(--ai-accent) 62%,#fff);box-shadow:0 0 0 3px color-mix(in srgb,var(--ai-accent) 13%,transparent)}
.ai-config-card .settings-field input::placeholder{color:#98a2b3}
.ai-config-card .settings-note{border:1px solid #edf0f5;background:#f7f8fa;color:#667085;line-height:1.65}
.ai-config-card .settings-note.ok{border-color:#b8e5d1;background:#f0fbf5;color:#087443}
.ai-config-card .settings-actions{gap:7px;margin-top:auto;padding-top:16px;border-top:1px solid #edf0f5}
.ai-config-card .settings-actions .unified-button{min-height:34px;border-radius:9px;font-size:11px}
.ai-config-card .settings-actions .unified-button.primary{border-color:var(--ai-accent);background:var(--ai-accent);box-shadow:0 5px 12px color-mix(in srgb,var(--ai-accent) 20%,transparent)}
.ai-config-card .settings-actions .unified-button.primary:hover{filter:brightness(1.06)}
.ai-config-card .settings-actions .unified-button.danger{border-color:#f3c7c3;background:#fffafa;color:#b42318}
.ai-config-card .image-model-picker{margin-top:14px}
.ai-config-card code{overflow-wrap:anywhere;color:var(--ai-accent)}
@media(min-width:1500px){.ai-config-grid{grid-template-columns:repeat(3,minmax(0,1fr));align-items:stretch}.image-text-ai-config-card{grid-column:auto}}
@media(max-width:1499px) and (min-width:901px){.ai-config-grid{grid-template-columns:repeat(2,minmax(0,1fr));align-items:stretch}.image-text-ai-config-card{grid-column:1/-1}}
@media(max-width:900px){.ai-config-grid{grid-template-columns:minmax(0,1fr);gap:12px}.image-text-ai-config-card{grid-column:auto}.ai-card-head{min-height:0}}
@media(prefers-reduced-motion:reduce){.ai-config-card,.ai-config-card:hover{transition:none;transform:none}}
.settings-note.error{border:1px solid #fecdca;background:#fff4f2;color:#b42318}.settings-inline-retry{margin-left:8px;padding:3px 8px;border:1px solid #fecdca;border-radius:6px;background:#fff;color:#b42318;font:inherit;cursor:pointer}.settings-inline-retry:disabled{opacity:.6;cursor:wait}.ai-load-error{display:flex;align-items:center;justify-content:space-between;gap:10px}.update-release-notes pre{max-height:240px;overflow:auto;white-space:pre-wrap;font:inherit}.settings-nav button[aria-current="page"]{font-weight:700}
/* ---- 分组 / 安全 / 数据与维护（平台入口合并与新页签） ---- */
.settings-group{margin-top:16px;padding:12px 16px;border:1px solid #e9eef5;border-radius:12px;background:#f8fafc}
.settings-group + .settings-group{margin-top:12px}
.settings-group-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:2px;padding-bottom:10px;border-bottom:1px solid #e7ecf3}
.settings-group-head h3{margin:0;font-size:13.5px;color:#202939}
.settings-group-head span{color:#8c9ab5;font-size:10px}
.settings-group-inline{margin-top:12px;padding:12px 13px;border:1px dashed #dfe3ec;border-radius:10px;background:#ffffff}
.settings-group .settings-field-row{border-bottom:1px solid #f0f3f8;padding:9px 0}
.settings-group .settings-field-row:last-of-type{border-bottom:0}
.settings-tab-alert{width:7px;height:7px;flex:none;border-radius:50%;background:#f04438;box-shadow:0 0 0 3px rgba(240,68,56,.14)}
.security-status{display:flex;align-items:center;gap:12px;margin-top:14px;padding:14px 16px;border:1px solid #e9eef5;border-radius:12px;background:linear-gradient(135deg,#ffffff,#fafbfe)}
.security-status[data-enabled='1']{border-color:#cdeeda;background:linear-gradient(135deg,#ffffff,#f6fdf9)}
.security-status-dot{width:9px;height:9px;flex:none;border-radius:50%;background:#98a2b3}
.security-status-dot.on{background:#12b76a;box-shadow:0 0 0 4px rgba(18,183,106,.16)}
.security-status-copy{min-width:0;flex:1}
.security-status-copy strong{color:#202939;font-size:13px}
.security-status-copy p{margin:3px 0 0;color:#667085;font-size:10.5px}
.maintenance-toggle-row{align-items:center}
.settings-field-row .settings-check{display:flex;flex-direction:row;align-items:center;gap:9px;flex:none;color:#344054;font-size:12px;cursor:pointer}
.settings-field-row .settings-switch{appearance:none;position:relative;width:36px;height:20px;padding:0;border:0;border-radius:999px;background:#d0d5dd;cursor:pointer;transition:background .18s}
.settings-field-row .settings-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#ffffff;box-shadow:0 1px 3px rgba(16,24,40,.2);transition:transform .18s}
.settings-field-row .settings-switch:checked{background:#6d4aff}
.settings-field-row .settings-switch:checked::after{transform:translateX(16px)}
.settings-field-row .settings-switch:disabled{opacity:.6;cursor:not-allowed}
.settings-check-state{margin-left:auto;color:#667085;font-size:10.5px}
.maintenance-backup-list{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.maintenance-backup-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid #eef1f7;border-radius:9px;background:#ffffff;font-size:11px;transition:border-color .16s,box-shadow .16s}
.maintenance-backup-row:hover{border-color:#dfe5ef;box-shadow:0 4px 10px rgba(30,41,74,.05)}
.maintenance-backup-meta{display:inline-flex;align-items:baseline;gap:6px}
.maintenance-backup-meta b{color:#344054;font-weight:600}
.maintenance-backup-meta em{color:#98a2b3;font-style:normal}
/* 软件诊断的逐项状态：正常/注意/异常必须一眼分得开（颜色不是唯一线索，前面还有文字标签） */
.maintenance-backup-meta em.check-ok{color:#067647}
.maintenance-backup-meta em.check-warn{color:#b54708}
.maintenance-backup-meta em.check-error{color:#b42318}
/* 失败/异常原因：在标签之后单独一行，读得清是哪一步出的问题（审查 V1） */
.maintenance-backup-meta .view-probe-reason{color:#b54708;font-size:10px;overflow-wrap:anywhere}
.maintenance-backup-row .unified-button{margin-left:auto}
.about-grid>div{border:1px solid #eef1f6;background:#fafbfd}
.about-grid select{height:30px}
@media(max-width:820px){.settings-group-head{flex-direction:column;gap:2px}.maintenance-backup-row{flex-wrap:wrap}.maintenance-backup-row .unified-button{margin-left:0}}
</style>
