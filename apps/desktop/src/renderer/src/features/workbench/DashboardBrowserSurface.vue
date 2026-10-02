<template>
  <section :class="['dashboard-browser-surface', { 'picker-mode': props.pickerMode }]" data-test="dashboard-browser-surface" aria-label="店铺浏览器">
    <div class="dashboard-browser-tabs" role="tablist" aria-label="店铺标签页">
      <button
        v-for="tab in ws.displayedTabs"
        :key="tab.id"
        type="button"
        :class="['dashboard-browser-tab', { active: ws.activeTab?.id === tab.id }]"
        role="tab"
        :aria-selected="ws.activeTab?.id === tab.id"
        @click="ws.activateTab(tab.id)"
      >
        <span v-if="tab.loading" class="browser-tab-spinner" aria-hidden="true"></span>
        <span class="browser-tab-title" :title="tab.title || tab.url">{{ tab.title || '新标签页' }}</span>
        <span class="browser-tab-close" title="关闭标签页" @click.stop="ws.closeTab(tab.id)"><img :src="closeIcon" alt="" /></span>
      </button>
      <button type="button" class="dashboard-browser-tab-add" title="新标签页" @click="ws.newTab()"><img :src="addIcon" alt="" /></button>
      <!-- 侧栏开关：原先在头部栏里（整条已按用户要求移除），只保留这一个动作挪到标签栏右端。
           用地址栏同一套图标（透明底），展开/收起靠翻转同一个箭头，避免引入第二个资源。 -->
      <button
        type="button"
        class="dashboard-browser-panel-toggle"
        :class="{ collapsed: !panelOpen }"
        data-test="panel-toggle"
        :title="panelOpen ? '收起侧栏（Ctrl+Shift+B）' : '展开侧栏（Ctrl+Shift+B）'"
        :aria-expanded="panelOpen"
        @click="togglePanel"
      ><img :src="panelToggleIcon" alt="" /></button>
    </div>

    <div class="dashboard-browser-address address-bar">
      <button type="button" class="browser-nav-button" title="后退" @click="ws.tabControl('back')"><img :src="backIcon" alt="" /></button>
      <button type="button" class="browser-nav-button" title="前进" @click="ws.tabControl('forward')"><img :src="forwardIcon" alt="" /></button>
      <button type="button" class="browser-nav-button" title="刷新" @click="ws.tabControl('reload')"><img :src="reloadIcon" alt="" /></button>
      <button type="button" class="browser-nav-button home-btn nav-btn" data-test="nav-home" :disabled="!homeUrl" :title="homeUrl ? `店铺首页：${homeUrl}` : '店铺首页'" @click="goHome"><img :src="homeIcon" alt="" /></button>
      <label class="dashboard-browser-url" aria-label="当前页面地址">
        <img :src="searchIcon" alt="" />
        <input v-model="urlDraft" spellcheck="false" @keydown.enter="submitUrl" />
      </label>
      <span class="dashboard-browser-hint">页面内嵌 · 每店独立会话</span>
    </div>

    <div class="dashboard-browser-body">
      <div class="dashboard-browser-main">
        <div class="dashboard-browser-viewport viewport" data-test="dashboard-browser-viewport">
          <webview
            v-for="item in openWebviews"
            :key="item.key"
            :ref="webviewRefCallback(item.key)"
            class="dashboard-browser-webview"
            :class="{ active: item.storeId === ws.displayedStoreId && item.tabId === ws.activeTab?.id }"
            :partition="`persist:store_${item.storeId}`"
            src="about:blank"
            :data-store-id="item.storeId"
            :data-tab-id="item.tabId"
            :aria-label="`${item.storeName} · ${item.tabTitle || '新标签页'}`"
            allowpopups
            @did-attach="handleWebviewAttach(item)"
            @did-fail-load="handleWebviewFailure(item, $event)"
            @did-finish-load="clearWebviewError(item)"
            @destroyed="handleWebviewDestroyed(item)"
          ></webview>
          <div v-if="webviewDiagnostics.length" class="dashboard-browser-webview-diagnostics" data-test="webview-diagnostics" role="status">
            <strong>浏览器视图诊断</strong>
            <span v-for="diagnostic in webviewDiagnostics" :key="diagnostic.key">
              {{ diagnostic.text }}
              <button v-if="diagnostic.failed" type="button" class="mini-btn icon-btn" @click="retryWebview(diagnostic.key)"><img class="button-icon" :src="browserRetryIcon" alt="" />重试</button>
            </span>
          </div>
        </div>
      </div>

      <aside v-if="panelOpen" class="dashboard-browser-panel right-panel" data-test="right-panel" data-dashboard-test="dashboard-browser-panel" aria-label="店铺工作台侧栏">
        <div class="dashboard-browser-panel-tabs panel-tabs" role="tablist" aria-label="店铺工作台面板">
          <button v-for="item in panelItems" :key="item.key" type="button" :class="['ptab', { active: panel === item.key, on: panel === item.key }]" role="tab" :aria-selected="panel === item.key" @click="selectPanel(item.key)">
            <img class="panel-tab-icon" :src="item.icon" alt="" />{{ item.label }}
          </button>
        </div>

        <div v-for="confirmation in confirmations" :key="confirmation.runId" class="confirm-bar" data-test="task-confirm">
          <div class="confirm-copy"><strong>需要人工确认</strong><span>{{ confirmation.message }}<template v-if="confirmation.stepIndex != null">（步骤 {{ confirmation.stepIndex + 1 }}）</template></span></div>
          <div class="confirm-actions"><button type="button" class="confirm-allow" data-test="confirm-allow" @click="confirmRun(confirmation.runId, true)">允许</button><button type="button" class="confirm-deny" data-test="confirm-deny" @click="confirmRun(confirmation.runId, false)">拒绝</button></div>
        </div>

        <div v-if="panel === 'bookmarks'" class="dashboard-browser-panel-body">
          <div class="browser-panel-heading"><strong>收藏</strong><button type="button" @click="ws.refreshBookmarks()"><img class="button-icon" :src="workspaceRefreshIcon" alt="" />刷新</button></div>
          <div v-if="entryRoutes.length" class="env-sec" data-test="entry-routes">
            <div class="env-h"><PlatformIcon :name="displayedPlatformName" :size="14" /><span class="entry-routes-title">{{ displayedPlatformName }} · 平台入口</span></div>
            <button v-for="route in entryRoutes" :key="route.id" type="button" class="browser-panel-row entry-route" data-test="entry-route" @click="ws.navigate(route.url)"><span class="browser-panel-row-copy"><strong class="row-main">{{ route.title }}</strong><small>{{ shortUrl(route.url) }}</small></span><span class="browser-panel-row-action"><img :src="forwardIcon" alt="" /></span></button>
            <div class="env-note">平台入口由内置适配器提供，页面改版可能调整地址；失效可直接在下方自建收藏。</div>
          </div>
          <div v-if="!ws.bookmarks.length" class="browser-panel-empty"><img class="browser-state-art" :src="bookmarksArt" alt="暂无收藏" /><span>暂无收藏</span></div>
          <button v-for="bookmark in ws.bookmarks" :key="bookmark.id" type="button" class="browser-panel-row" @click="ws.navigate(bookmark.url)">
            <span class="browser-panel-row-copy"><strong>{{ bookmark.title || bookmark.url }}</strong><small>{{ shortUrl(bookmark.url) }}</small></span>
            <span class="browser-panel-row-action" title="删除收藏" @click.stop="removeBookmark(bookmark.id)"><img :src="deleteIcon" alt="" /></span>
          </button>
        </div>

        <div v-else-if="panel === 'downloads'" class="dashboard-browser-panel-body">
          <div class="browser-panel-heading"><strong>下载</strong><button type="button" @click="ws.refreshDownloads()"><img class="button-icon" :src="workspaceRefreshIcon" alt="" />刷新</button></div>
          <div v-if="!ws.downloads.length" class="browser-panel-empty"><img class="browser-state-art" :src="downloadsArt" alt="暂无下载" /><span>暂无下载</span></div>
          <button v-for="download in ws.downloads" :key="download.id" type="button" class="browser-panel-row" @click="showInFolder(download.id)">
            <span class="browser-panel-row-copy"><strong :title="download.fileName">{{ download.fileName || '未命名文件' }}</strong><small>{{ downloadState(download.state) }}<template v-if="download.sizeBytes"> · {{ formatSize(download.sizeBytes) }}</template></small></span>
            <span class="browser-panel-row-action"><img :src="openIcon" alt="" /></span>
          </button>
        </div>

        <div v-else-if="panel === 'env'" class="dashboard-browser-panel-body panel-body env-body">
          <div class="browser-panel-heading"><strong>环境与安全</strong><button type="button" @click="refreshEnvironment"><img class="button-icon" :src="workspaceRefreshIcon" alt="" />刷新</button></div>
          <div class="env-sec">
            <div class="env-h">网络出口</div>
            <div class="bind-row"><select v-model="proxyBindId" aria-label="网络出口" @change="applyBind"><option value="">直连（不使用代理）</option><option v-for="p in proxies" :key="p.id" :value="p.id">{{ p.label || `${p.host}:${p.port}` }}</option></select></div>
            <div v-if="envBindingNote" class="env-note">{{ envBindingNote }}</div>
            <div v-if="proxyAuthObserved" class="env-note ok">✔ 最近一次代理认证已由主进程安全处理</div>
          </div>

          <div class="env-sec">
            <div class="env-h">代理列表</div>
            <div v-if="!proxies.length" class="proxy-item proxy-empty-row"><img class="browser-inline-art" :src="networkArt" alt="暂无代理" /><div class="p-info"><div class="row-main">暂无代理</div><div class="row-sub">添加代理后可检测或删除</div></div><button type="button" class="row-del" disabled aria-label="暂无可删除代理"><img :src="deleteIcon" alt="" /></button></div>
            <div v-for="p in proxies" :key="p.id" class="proxy-item">
              <span class="p-dot" :class="`proxy-${p.status}`" :title="`状态：${p.status}`"></span>
              <div class="p-info"><div class="row-main">{{ p.label || p.host }}<span v-if="p.hasCredential" title="含凭据"> 🔑</span></div><div class="row-sub">{{ p.type }}://{{ p.host }}:{{ p.port }} · {{ p.lastLatencyMs != null ? `${p.lastLatencyMs} ms` : '未检测' }}</div></div>
              <button type="button" class="mini-btn" :disabled="testingIds.includes(p.id)" @click="testProxy(p)">{{ testingIds.includes(p.id) ? '…' : '检测' }}</button>
              <button type="button" class="row-del" title="删除" @click="removeProxy(p.id)"><img :src="deleteIcon" alt="" /></button>
            </div>
            <div class="proxy-add">
              <input v-model="np.label" placeholder="名称（可选）" />
              <div class="add-line"><select v-model="np.type" aria-label="代理类型"><option value="http">http</option><option value="https">https</option><option value="socks5">socks5</option></select><input v-model="np.host" class="f-host" placeholder="主机" /><input v-model.number="np.port" class="f-port" type="number" placeholder="端口" /></div>
              <div class="add-line"><input v-model="np.user" placeholder="用户名（可选）" autocomplete="off" /><input v-model="np.pass" type="password" placeholder="密码（可选，本机加密存储）" autocomplete="new-password" /></div>
              <button type="button" class="mini-btn primary" :disabled="!np.host || !np.port" @click="addProxy"><img class="button-icon" :src="settingsSaveIcon" alt="" />保存代理</button>
            </div>
          </div>

          <div class="env-sec">
            <div class="env-h">环境指纹 <button type="button" class="mini-btn env-action" :disabled="verifying" @click="verifyEnv">{{ verifying ? '验证中…' : '打开店铺页面后验证' }}</button></div>
            <div v-if="!verifyItems.length" class="env-note env-empty-note"><img class="browser-inline-art" :src="networkArt" alt="环境尚未验证" /><span>未验证。字段实际值需在店铺浏览器打开后采集，无法验证的字段如实标记“未验证”。</span></div>
            <div v-for="item in verifyItems" :key="item.field" class="verify-item"><img class="verify-status-icon" :src="item.state === 'verified' ? verifiedIcon : unknownIcon" :alt="item.state === 'verified' ? '已验证' : '未验证'" /><div class="v-info"><div class="row-main">{{ item.field }}</div><div class="row-sub" :title="`期望 ${item.expected} / 实际 ${item.actual ?? '—'}`">期望 {{ clip(item.expected) }} → 实际 {{ clip(item.actual) }}</div></div></div>
          </div>

          <div class="env-sec" data-test="session-sec">
            <div class="env-h">会话与 Cookie</div>
            <div class="cf-btns"><button type="button" class="mini-btn" data-test="btn-export-session" :disabled="secBusy" @click="exportSession"><img class="button-icon" :src="sessionExportIcon" alt="" />导出加密会话包…</button><button type="button" class="mini-btn" data-test="btn-import-session" :disabled="secBusy" @click="importSession"><img class="button-icon" :src="sessionImportIcon" alt="" />导入会话包…</button></div>
            <div class="env-note">导出包经口令加密并带有效期；口令由主进程托管窗口采集，不经过界面脚本。</div>
            <input v-model="ckSearch" class="ck-search" placeholder="搜索 Cookie（名称/域）" @input="refreshCookies" />
            <div class="row-sub cookie-count">共 {{ cookiesTotal }} 条<span v-if="ckSearch">（筛选后 {{ cookies.length }}）</span></div>
            <div v-for="cookie in cookies.slice(0, 40)" :key="cookie.domain + cookie.path + cookie.name" class="proxy-item ck-item"><div class="p-info"><div class="row-main" :title="cookie.valuePreview">{{ cookie.name }}<span v-if="cookie.httpOnly" class="ck-flag">HttpOnly</span><span v-if="cookie.secure" class="ck-flag">Secure</span></div><div class="row-sub">{{ cookie.domain }}{{ cookie.path }} · {{ cookie.session ? '会话级' : cookie.expires }} · {{ cookie.valuePreview }}</div></div><button type="button" class="row-del" title="删除该 Cookie" @click="delCookie(cookie)"><img :src="deleteIcon" alt="" /></button></div>
            <button v-if="cookiesTotal > 0" type="button" class="mini-btn danger-btn" @click="clearCookies">清空该店铺全部 Cookie</button>
          </div>

          <div class="env-sec" data-test="lock-sec">
            <div class="env-h">应用锁</div>
            <template v-if="!ws.securityEnabled"><div class="env-note">未设置主密码。设置后可随时锁定应用；锁定会隐藏浏览器视图并拒绝业务操作。</div><input v-model="pw1" type="password" placeholder="新主密码（≥8 位）" autocomplete="new-password" /><input v-model="pw2" type="password" placeholder="再次输入" autocomplete="new-password" /><button type="button" class="mini-btn primary" data-test="btn-set-pw" :disabled="pw1.length < 8 || pw1 !== pw2" @click="setMasterPw">设置主密码</button></template>
            <template v-else><div class="cf-btns"><button type="button" class="mini-btn primary" data-test="btn-lock-now" @click="lockNow"><img class="button-icon" :src="securityLockIcon" alt="" />立即锁定</button><button type="button" class="mini-btn" @click="showChangePw = !showChangePw">{{ showChangePw ? '收起' : '更换密码' }}</button><button type="button" class="mini-btn danger-btn" @click="removePw">移除主密码</button></div><div class="bind-row idle-row"><span class="row-sub">空闲自动锁定</span><select v-model.number="idleMinSel" data-test="sel-idle" @change="applyIdle"><option :value="0">关闭</option><option :value="5">5 分钟</option><option :value="15">15 分钟</option><option :value="30">30 分钟</option><option :value="60">60 分钟</option></select></div><template v-if="showChangePw"><input v-model="oldPw" type="password" placeholder="旧主密码" autocomplete="off" /><input v-model="pw1" type="password" placeholder="新主密码（≥8 位）" autocomplete="new-password" /><input v-model="pw2" type="password" placeholder="再次输入" autocomplete="new-password" /><button type="button" class="mini-btn primary" :disabled="!oldPw || pw1.length < 8 || pw1 !== pw2" @click="setMasterPw">更新</button></template></template>
            <div v-if="secMsg" class="env-note" :class="{ ok: secMsgOk }">{{ secMsg }}</div>
          </div>

          <div class="env-sec" data-test="diag-sec">
            <div class="env-h">备份与诊断</div><div class="cf-btns wrap"><button type="button" class="mini-btn" data-test="btn-backup" :disabled="busyBackup" @click="doBackup"><img class="button-icon" :src="databaseBackupIcon" alt="" />{{ busyBackup ? '备份中…' : '立即备份数据库' }}</button><button type="button" class="mini-btn" data-test="btn-diag" :disabled="busyDiag" @click="doDiagnostics"><img class="button-icon" :src="diagnosticsIcon" alt="" />导出诊断包</button><button type="button" class="mini-btn" data-test="btn-memory-diag" :disabled="busyMemoryDiag" @click="readMemoryDiagnostics"><img class="button-icon" :src="memorySnapshotIcon" alt="" />{{ busyMemoryDiag ? '读取中…' : '读取内存快照' }}</button><button type="button" class="mini-btn" @click="doAuditExport"><img class="button-icon" :src="auditLogIcon" alt="" />导出审计日志</button></div>
            <div v-if="backups.length" class="row-sub backup-row">最近备份：{{ backups[0].createdAt ? new Date(backups[0].createdAt).toLocaleString() : '—' }}（{{ backups[0].sizeBytes ? (backups[0].sizeBytes / 1024).toFixed(0) : '—' }} KB） <button type="button" class="mini-btn" @click="doRestore(backups[0].id)"><img class="button-icon" :src="backupRestoreIcon" alt="" />恢复到此备份</button></div>
            <div v-if="memoryDiag" class="row-sub memory-diag" data-test="memory-diag-result">内存 {{ formatMemory(memoryDiag.main?.rss) }} · 店铺 {{ memoryDiag.totals?.openStores || 0 }} · 标签 {{ memoryDiag.totals?.tabs || 0 }} · guest {{ memoryDiag.totals?.attachedGuests || 0 }} · WebContents {{ memoryDiag.totals?.webContents || 0 }}</div>
            <div class="env-note">诊断包只含版本、系统、迁移版本、代理体检与脱敏日志，不含会话 Cookie、密码或订单原文。</div>
          </div>
        </div>

        <div v-else class="dashboard-browser-panel-body task-panel-body">
          <div class="browser-panel-heading"><strong>任务中心</strong><span class="browser-panel-heading-actions"><button type="button" @click="ws.refreshTasks()"><img class="button-icon" :src="browserRefreshIcon" alt="" />刷新</button><button type="button" data-test="task-new" @click="emit('open-tasks', true)"><img class="button-icon" :src="taskAddIcon" alt="" />新建任务</button></span></div>
          <div class="task-subtabs" data-test="task-subtabs" role="tablist"><button type="button" :class="{ on: taskSubTab === 'tasks' }" data-test="task-tab-tasks" @click="taskSubTab = 'tasks'">任务列表</button><button type="button" :class="{ on: taskSubTab === 'invite' }" data-test="task-tab-invite" @click="taskSubTab = 'invite'">达人邀约</button><button type="button" class="pending" :class="{ on: taskSubTab === 'todo' }" data-test="task-tab-todo" @click="taskSubTab = 'todo'">待开发</button></div>
          <template v-if="taskSubTab === 'tasks'">
            <div v-if="!taskRows.length" class="browser-panel-empty">当前店铺暂无任务</div>
            <article v-for="task in taskRows" :key="task.id" class="browser-task-row task-card" data-test="task-card"><div class="browser-task-copy"><strong :title="task.name">{{ task.name }}</strong><small>{{ taskStatus(task) }}</small><span class="browser-task-progress"><i :style="{ width: `${taskProgress(task)}%` }"></i></span></div><span class="browser-task-percent">{{ taskProgress(task) }}%</span><button type="button" class="mini-btn task-run-button" data-test="task-run" :disabled="taskActive(task)" @click="runTask(task)"><img class="button-icon" :src="taskActive(task) ? browserPauseIcon : browserStartIcon" alt="" />{{ taskActive(task) ? '运行中' : '运行' }}</button><button v-if="taskActive(task)" type="button" class="browser-panel-row-action" title="取消任务" @click="cancelTask(task)"><img :src="deleteIcon" alt="" /></button></article>
            <button type="button" class="browser-panel-link" @click="emit('open-tasks', false)">打开完整任务中心 <span>›</span></button>
          </template>
          <section v-else-if="taskSubTab === 'invite'" class="invite-panel" data-test="invite-panel">
            <div class="env-sec invite-config-sec">
              <div class="env-h">达人邀约 <span v-if="inviteProfile" class="row-sub">· {{ inviteProfile.platform }}</span><span v-else class="row-sub">· 当前平台未接入真实邀约流程</span></div>
              <template v-if="!inviteProfile">
                <div class="env-note">当前平台暂不支持达人邀约；已接入：抖店、微信小店、快手小店。保留入口但不会猜测页面选择器或伪造发送结果。</div>
              </template>
              <template v-else>
                <div class="invite-config-actions"><button type="button" class="mini-btn" data-test="invite-open-page" @click="openInvitePage">打开达人广场</button><button type="button" class="mini-btn" data-test="invite-save-config" :disabled="inviteSaving" @click="saveInviteConfig">{{ inviteSaving ? '保存中…' : '保存配置' }}</button></div>
                <template v-if="isBatchProfile(inviteProfile)">
                  <div class="invite-form-grid">
                    <label class="invite-field"><span>{{ inviteProfile.categoryLabelText || '主推类目' }}</span><select v-model="invite.category" data-test="invite-category"><option value="">不限</option><option v-for="item in inviteCategoryOptions" :key="item" :value="item">{{ item }}</option></select></label>
                    <label class="invite-field"><span>二级类目</span><select v-model="invite.subcategory" data-test="invite-subcategory" :disabled="!invite.category"><option value="">不限</option><option v-for="item in inviteSubcategoryOptions" :key="item" :value="item">{{ item }}</option></select></label>
                    <label v-if="inviteProfile.categoryDepth === 3" class="invite-field"><span>三级类目</span><select v-model="invite.category3" data-test="invite-category3" :disabled="!invite.subcategory || !inviteThirdCategoryOptions.length"><option value="">不限</option><option v-for="item in inviteThirdCategoryOptions" :key="item" :value="item">{{ item }}</option></select></label>
                    <label class="invite-field"><span>每批邀约数量</span><input v-model.number="invite.count" data-test="invite-count" type="number" min="1" :max="inviteProfile.maxBatch" /></label>
                  </div>
                  <div v-if="inviteProfile.levels.length" class="invite-choice-group"><span>达人等级</span><div class="invite-chips"><label v-for="level in inviteProfile.levels" :key="level" class="inv-chip" :class="{ on: invite.levels.includes(level) }"><input v-model="invite.levels" type="checkbox" :value="level" :data-test="`invite-level-${level}`" />{{ level }}</label></div></div>
                  <div v-if="inviteProfile.strengths" class="invite-choice-group"><span>{{ inviteProfile.strengths.label }}</span><div class="invite-chips"><label v-for="strength in inviteProfile.strengths.options" :key="strength" class="inv-chip" :class="{ on: invite.strengths.includes(strength) }"><input v-model="invite.strengths" type="checkbox" :value="strength" :data-test="`invite-strength-${strength}`" />{{ strength }}</label></div></div>
                  <div v-if="inviteProfile.benefits?.length" class="invite-choice-group"><span>{{ inviteProfile.benefitsLabelText || '专属权益' }}<small v-if="inviteProfile.benefitsMax"> · 最多 {{ inviteProfile.benefitsMax }} 项</small></span><div class="invite-chips"><label v-for="benefit in inviteProfile.benefits" :key="benefit" class="inv-chip" :class="{ on: invite.benefits.includes(benefit) }"><input v-model="invite.benefits" type="checkbox" :value="benefit" :data-test="`invite-benefit-${benefit}`" />{{ benefit }}</label></div></div>
                  <div v-if="inviteProfile.drawerForm?.mainCategory" class="invite-form-grid"><label class="invite-field"><span>主营类目</span><select v-model="invite.mainCategory" data-test="invite-main-category"><option value="">不填写</option><option v-for="item in inviteMainCategoryPaths" :key="item" :value="item">{{ item }}</option></select></label></div>
                  <div v-if="inviteProfile.contactSelectors?.phone || inviteProfile.contactSelectors?.wechat || inviteProfile.contactSelectors?.contact" class="invite-form-grid">
                    <label v-if="inviteProfile.contactSelectors?.contact" class="invite-field"><span>联系人</span><input v-model="invite.batchContact" data-test="invite-batch-contact" maxlength="30" placeholder="联系人" /></label>
                    <label v-if="inviteProfile.contactSelectors?.phone" class="invite-field"><span>手机号</span><input v-model="invite.batchPhone" data-test="invite-batch-phone" maxlength="20" placeholder="11 位手机号" /></label>
                    <label v-if="inviteProfile.contactSelectors?.wechat" class="invite-field"><span>微信号</span><input v-model="invite.batchWechat" data-test="invite-batch-wechat" maxlength="40" placeholder="微信号" /></label>
                  </div>
                </template>
                <template v-else>
                  <div class="invite-form-grid"><label class="invite-field"><span>邀约联系人</span><input v-model="invite.contact" data-test="invite-contact" placeholder="联系人" /></label><label class="invite-field"><span>微信号</span><input v-model="invite.wechat" data-test="invite-wechat" placeholder="微信号" /></label><label class="invite-field"><span>手机号</span><input v-model="invite.phone" data-test="invite-phone" placeholder="手机号" /></label></div>
                </template>
                <ul v-if="inviteMissingItems.length" class="invite-missing" data-test="invite-missing"><li v-for="item in inviteMissingItems" :key="item">{{ item }}</li></ul>
                <div class="invite-start-row"><button type="button" class="mini-btn primary" data-test="invite-start" :disabled="!inviteReady || inviteSubmitting" @click="startInvite"><img class="button-icon" :src="browserStartIcon" alt="" />{{ inviteSubmitting ? '正在启动…' : '开始邀约' }}</button><span class="row-sub">{{ inviteReady ? '配置完整，可创建真实任务' : '补齐必填项后可开始' }}</span></div>
              </template>
            </div>
            <div class="env-sec invite-live-sec"><div class="env-h">达人邀约实时日志<span v-if="inviteLatest" class="row-sub"> · {{ inviteStatus(inviteLatest) }}</span></div>
              <div v-if="!inviteLatest" class="browser-panel-empty invite-live-empty" data-test="invite-live-empty">本店铺还没有邀约运行，点“开始邀约”后这里会实时显示进度。</div>
              <template v-else>
                <div class="invite-live-stuck" data-test="invite-live-stuck">{{ inviteStuckText(inviteLatest) }}</div>
                <div class="step-row" v-for="(step, index) in (inviteLatest.steps || [])" :key="`${inviteLatest.id}-${index}`"><span class="s-ico">{{ inviteStepIcon(inviteLatest, index) }}</span><div class="v-info"><div class="row-main">第 {{ index + 1 }} 步 · {{ inviteStepLabel(step) }}</div><div class="row-sub">{{ inviteStepInput(step) }}</div></div></div>
                <div class="tc-btns" v-if="inviteRunId(inviteLatest)"><button v-if="inviteActive(inviteLatest)" type="button" class="mini-btn" data-test="invite-live-stop" @click="stopInvite(inviteLatest)"><img class="button-icon" :src="browserStopIcon" alt="" />停止</button><button type="button" class="mini-btn" @click="ws.refreshTasks()"><img class="button-icon" :src="browserRefreshIcon" alt="" />刷新</button></div>
                <div v-if="inviteLiveMessage(inviteLatest)" class="row-sub invite-message">{{ inviteLiveMessage(inviteLatest) }}</div>
                <div ref="inviteLiveLogEl" class="log-box invite-live-log" data-test="invite-live-log"><div v-if="!inviteLogs(inviteLatest).length" class="log-line">等待运行输出…开始邀约后，这里的日志会实时滚动，卡住时看停在最后几行。</div><div v-for="(log, index) in inviteLogs(inviteLatest)" :key="`${inviteRunId(inviteLatest)}-${index}`" class="log-line">{{ inviteLogText(log) }}</div></div>
              </template>
            </div>
            <div class="env-sec invite-unavailable"><div class="env-note">达人邀约配置与平台页面仍沿用真实任务、店铺配置和人工操作边界；未配置时不会伪造可发送结果。</div><button type="button" class="mini-btn" @click="emit('open-tasks', false)">打开完整任务配置</button></div>
          </section>
          <section v-else class="todo-panel"><div class="browser-panel-empty"><strong>待开发能力</strong><span>该入口保留在统一任务中心，接入真实能力后开放。</span></div></section>
        </div>
      </aside>

      <aside v-else class="dashboard-browser-panel right-panel collapsed panel-rail" data-test="right-panel" data-dashboard-test="dashboard-browser-panel" aria-label="已收起的店铺工作台侧栏">
        <button type="button" class="panel-rail-expand" data-test="panel-expand" title="展开侧栏" @click="setPanelOpen(true)"><img :src="panelExpandIcon" alt="" /></button>
        <button v-for="item in panelItems" :key="item.key" type="button" class="panel-rail-button" :class="{ on: panel === item.key }" :data-test="`rail-${item.key}`" :title="item.label" @click="openPanel(item.key)"><img :src="item.icon" alt="" /></button>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import PlatformIcon from '../../components/PlatformIcon.vue'
import bookmarksArt from '../../assets/ui/browser/bookmarks.png'
import downloadsArt from '../../assets/ui/browser/downloads.png'
import networkArt from '../../assets/ui/browser/network.png'
import homeIcon from '../../assets/icons/utility-home.svg'
import bookmarksIcon from '../../assets/icons/browser-bookmarks.svg'
import downloadsIcon from '../../assets/icons/browser-downloads.svg'
import envIcon from '../../assets/icons/browser-env.svg'
import tasksIcon from '../../assets/icons/browser-tasks.svg'
import addIcon from '../../assets/generated/ui-icons/add.png'
import closeIcon from '../../assets/generated/ui-icons/close.png'
import deleteIcon from '../../assets/generated/ui-icons/delete-gen.png'
import searchIcon from '../../assets/generated/ui-icons/search.png'
import securityLockIcon from '../../assets/generated/ui-icons/security-lock-gen.png'
import backIcon from '../../assets/generated/ui-icons/back-gen.png'
import forwardIcon from '../../assets/generated/ui-icons/forward-gen.png'
import reloadIcon from '../../assets/generated/ui-icons/reload-gen.png'
import openIcon from '../../assets/generated/ui-icons/open-gen.png'
import browserRetryIcon from '../../assets/generated/ui-icons/browser-retry-gen.png'
import sessionExportIcon from '../../assets/generated/ui-icons/session-export-gen.png'
import sessionImportIcon from '../../assets/generated/ui-icons/session-import-gen.png'
import databaseBackupIcon from '../../assets/generated/ui-icons/database-backup-gen.png'
import diagnosticsIcon from '../../assets/generated/ui-icons/diagnostics-gen.png'
import memorySnapshotIcon from '../../assets/generated/ui-icons/memory-snapshot-gen.png'
import auditLogIcon from '../../assets/generated/ui-icons/audit-log-gen.png'
import backupRestoreIcon from '../../assets/generated/ui-icons/backup-restore-gen.png'
import workspaceRefreshIcon from '../../assets/generated/ui-icons/workspace-refresh-gen.png'
import settingsSaveIcon from '../../assets/generated/ui-icons/settings-save-gen.png'
import panelExpandIcon from '../../assets/generated/ui-icons/panel-expand-gen.png'
import panelToggleIcon from '../../assets/generated/ui-icons/chevron-right-gen.png'
import verifiedIcon from '../../assets/generated/ui-icons/browser-verified-gen.png'
import unknownIcon from '../../assets/generated/ui-icons/browser-unknown-gen.png'
import browserRefreshIcon from '../../assets/generated/ui-icons/browser-refresh-gen.png'
import taskAddIcon from '../../assets/generated/ui-icons/browser-task-add-gen.png'
import browserStartIcon from '../../assets/generated/ui-icons/browser-start-gen.png'
import browserStopIcon from '../../assets/generated/ui-icons/browser-stop-gen.png'
import browserPauseIcon from '../../assets/generated/ui-icons/browser-pause-gen.png'
import { useWorkspaceStore } from '../../stores/workspace'
import { inviteProfileFor, isBatchProfile, type CategoryNode } from '@shared/constants/invite'
import { buildInviteTaskPayload, inviteTaskIssues, normalizeInviteTaskConfig } from '@shared/invite-task'
import { inviteConfigKey, legacyInviteConfigKey } from '@shared/invite-config'
import { isInvoiceCollectTask } from '@shared/constants/invoice'

const emit = defineEmits<{
  // 头部栏（含「返回经营总览」）已按用户要求整条移除；回经营总览走左栏导航，这里不再有该事件。
  'open-tasks': [create?: boolean]
}>()
const props = defineProps<{ pickerMode?: boolean; active?: boolean }>()

const ws = useWorkspaceStore()
const urlDraft = ref('')
const store = computed(() => ws.stores.find(item => item.id === ws.displayedStoreId) || null)
const platformHomeUrls = ref<Record<string, string>>({})
const homeUrl = computed(() => store.value ? platformHomeUrls.value[store.value.platform] || store.value.adminUrl || '' : '')
type PanelKey = 'bookmarks' | 'downloads' | 'env' | 'tasks'
const panel = ref<PanelKey>('tasks')
const panelOpen = ref(true)
const panelItems: Array<{ key: PanelKey; label: string; icon: string }> = [
  { key: 'bookmarks', label: '收藏', icon: bookmarksIcon },
  { key: 'downloads', label: '下载', icon: downloadsIcon },
  { key: 'env', label: '环境', icon: envIcon },
  { key: 'tasks', label: '任务', icon: tasksIcon }
]
const sessionState = ref({ kind: 'loading', label: '读取中', detail: '正在读取店铺会话状态' })
interface ProxyLite { id: string; type: string; host: string; port: number; label: string | null; status: string; hasCredential: boolean; lastLatencyMs: number | null }
const proxies = ref<ProxyLite[]>([])
const proxyBindId = ref('')
const envBindingNote = ref('')
const proxyAuthObserved = ref(false)
const testingIds = ref<string[]>([])
const verifyItems = ref<Array<{ field: string; expected: unknown; actual: unknown; state: string }>>([])
const verifying = ref(false)
const np = reactive({ label: '', type: 'http', host: '', port: null as number | null, user: '', pass: '' })
const cookies = ref<any[]>([])
const cookiesTotal = ref(0)
const ckSearch = ref('')
const secBusy = ref(false)
const pw1 = ref('')
const pw2 = ref('')
const oldPw = ref('')
const showChangePw = ref(false)
const secMsg = ref('')
const secMsgOk = ref(false)
const idleMinSel = ref(0)
const backups = ref<any[]>([])
const busyBackup = ref(false)
const busyDiag = ref(false)
const busyMemoryDiag = ref(false)
const memoryDiag = ref<any | null>(null)
const confirmations = computed(() => Object.values(ws.confirmations).filter(Boolean))

/**
 * 店铺页面 = 主窗口 Renderer DOM 里的真实 Electron `<webview>`，每个打开店铺保留当前活动页一个。
 *
 * 生命周期：元素挂载 → `did-attach` → 主进程 `browser:registerWebview` 校验并绑定 guest →
 * 用主进程返回的 `pendingUrl` 做首次导航（此时店铺 Session、代理配置与指纹注入都已就绪）。
 * 主进程只认自己注册过的 guest，Renderer 不能凭 webContentsId 直接拿到页面句柄。
 *
 * 每家打开的店铺只保留当前活动标签页的 guest；切换标签页时旧 guest 随 DOM 卸载，
 * URL/标题/登录态由主进程数据库与持久化 partition 保留，重新切回再按 URL 恢复。
 * 这避免一个店铺的历史标签页数量直接线性放大 Chromium renderer 内存。
 */
interface OpenWebviewEntry {
  key: string
  storeId: string
  tabId: string
  storeName: string
  tabTitle: string
  /** 采集专用页：挂隐藏 webview 给后台采集用，不进标签栏、不参与"未就绪"诊断 */
  internal?: boolean
}

const webviewEls = new Map<string, any>()
const webviewRefCallbacks = new Map<string, (element: unknown) => void>()
/** 注册/加载失败的如实原因（key → 文案），成功即清除；界面据此显示诊断而不是空白页。 */
const webviewFailures = reactive<Record<string, string>>({})
const registeringKeys = new Set<string>()

const openWebviews = computed<OpenWebviewEntry[]>(() => {
  const entries: OpenWebviewEntry[] = []
  for (const storeId of ws.openStoreIds) {
    const store = ws.stores.find(item => item.id === storeId)
    const tabs = ws.tabsByStore[storeId] || []
    const activeId = ws.activeTabIdByStore[storeId] || tabs.slice().sort((a, b) => a.orderIndex - b.orderIndex)[0]?.id
    const activeTab = tabs.find(tab => tab.id === activeId)
    if (activeTab) {
      entries.push({
        key: `${storeId}:${activeTab.id}`,
        storeId,
        tabId: activeTab.id,
        storeName: store?.name || '店铺',
        tabTitle: activeTab.title || ''
      })
    }
    // 采集专用标签页：**隐藏挂载**（class 计算天然不是 active → opacity:0），
    // 后台采集因此有真实页面可读，而用户的标签页一点没动（2026-10-02「采集任务时不要影响浏览器使用」）。
    for (const tab of tabs) {
      if (tab.internal !== true || tab.id === activeTab?.id) continue
      entries.push({
        key: `${storeId}:${tab.id}`,
        storeId,
        tabId: tab.id,
        storeName: store?.name || '店铺',
        tabTitle: tab.title || '',
        internal: true
      })
    }
  }
  return entries
})

function webviewAttached(item: OpenWebviewEntry): boolean {
  const tab = (ws.tabsByStore[item.storeId] || []).find(row => row.id === item.tabId)
  return tab?.guestAttached === true
}

const webviewDiagnostics = computed(() => openWebviews.value
  // 采集专用页不参与诊断：它是后台自己的页面，用户没让它出现，就不该在界面上闪"正在连接店铺页面…"
  .filter(item => !item.internal)
  .filter(item => !webviewAttached(item))
  .map(item => ({
    key: item.key,
    failed: !!webviewFailures[item.key],
    text: webviewFailures[item.key]
      ? `${item.storeName}：页面未就绪——${webviewFailures[item.key]}`
      : `${item.storeName}：正在连接店铺页面…`
  })))

function setWebviewRef(key: string, element: unknown): void {
  if (element) webviewEls.set(key, element)
  else webviewEls.delete(key)
}

function webviewRefCallback(key: string): (element: unknown) => void {
  const existing = webviewRefCallbacks.get(key)
  if (existing) return existing
  const callback = (element: unknown): void => setWebviewRef(key, element)
  webviewRefCallbacks.set(key, callback)
  return callback
}

async function handleWebviewAttach(item: OpenWebviewEntry): Promise<void> {
  const key = item.key
  if (registeringKeys.has(key)) return
  const element = webviewEls.get(key)
  if (!element) return
  let webContentsId = 0
  try { webContentsId = Number(element.getWebContentsId()) } catch { webContentsId = 0 }
  if (!Number.isInteger(webContentsId) || webContentsId <= 0) {
    webviewFailures[key] = '无法读取页面进程标识'
    return
  }
  registeringKeys.add(key)
  try {
    const result = await window.shopilot.browser.registerWebview(item.storeId, item.tabId, webContentsId)
    if (!result.ok) {
      webviewFailures[key] = result.error?.message || '注册失败'
      return
    }
    delete webviewFailures[key]
    const pendingUrl = String((result.data as { pendingUrl?: string } | null)?.pendingUrl || '')
    let current = ''
    try { current = String(element.getURL() || '') } catch { current = '' }
    // 只有真正待导航的地址才加载：about:blank 也调用 loadURL 会把已恢复的页面重新载入一遍
    if (pendingUrl && pendingUrl !== 'about:blank' && (!current || current === 'about:blank')) {
      try { await element.loadURL(pendingUrl) } catch { /* 加载失败由 did-fail-load 如实呈现 */ }
    }
  } finally {
    registeringKeys.delete(key)
  }
}

function retryWebview(key: string): void {
  const item = openWebviews.value.find(entry => entry.key === key)
  if (!item) return
  delete webviewFailures[key]
  void handleWebviewAttach(item)
}

function clearWebviewError(item: OpenWebviewEntry): void {
  delete webviewFailures[item.key]
}

function handleWebviewFailure(item: OpenWebviewEntry, event: any): void {
  const code = Number(event?.errorCode)
  // -3 = ERR_ABORTED：被新导航/重定向打断，不是页面失败
  if (code === -3) return
  webviewFailures[item.key] = `加载失败（${event?.errorDescription || code || '未知原因'}）`
}

function handleWebviewDestroyed(item: OpenWebviewEntry): void {
  delete webviewFailures[item.key]
  webviewEls.delete(item.key)
}

// 右侧「任务中心 → 任务列表」：发票自动采集任务不列（用户口径：发票采集不计入任务）。
// 这里只取 6 条，不排除的话每 3 小时自动建的采集任务会把真正的任务挤出面板。
const taskRows = computed(() => ws.tasks.filter((task: any) => !isInvoiceCollectTask(task) && (!task.storeScope || task.storeScope === ws.displayedStoreId)).slice(0, 6))
const taskSubTab = ref<'tasks' | 'invite' | 'todo'>('tasks')
const inviteLiveLogEl = ref<HTMLElement | null>(null)
const squareUrls = ref<Record<string, string>>({})
const dynamicCategoryTrees = ref<Record<string, CategoryNode[]>>({})
const entryRoutes = ref<any[]>([])
const displayedPlatformName = computed(() => store.value?.platform || '')
const inviteProfile = computed(() => inviteProfileFor(store.value?.platform))
const INVITE_CATEGORY_TREES_SETTING = 'invite.categoryTrees'
const invite = reactive({
  category: '', subcategory: '', category3: '', levels: [] as string[], count: 5,
  script: '', scriptMode: 'manual' as 'manual' | 'ai', benefits: [] as string[], strengths: [] as string[],
  mainCategory: '', extraFilters: {} as Record<string, string[]>, batchContact: '', batchPhone: '', batchWechat: '', batchProductCount: 1,
  contact: '', wechat: '', phone: '', productIds: '', finderType: '全部带货者', finderCategories: [] as string[], finderOtherFilters: [] as string[]
})
const inviteSaving = ref(false)
const inviteSubmitting = ref(false)
const inviteConfigLoaded = ref(false)
let inviteConfigLoadSerial = 0
let inviteConfigLoadedStoreId = ''
let inviteSaveTimer: ReturnType<typeof setTimeout> | null = null
function inviteCategoryTreeFor(profile: { platform: string; categoryTree?: readonly CategoryNode[] }): readonly CategoryNode[] {
  const dynamic = dynamicCategoryTrees.value[profile.platform]
  return Array.isArray(dynamic) && dynamic.length ? dynamic : (profile.categoryTree || [])
}
const inviteCategoryOptions = computed(() => inviteProfile.value && isBatchProfile(inviteProfile.value) ? inviteCategoryTreeFor(inviteProfile.value).map(item => item.name) : [])
const inviteSubcategoryOptions = computed(() => {
  const profile = inviteProfile.value
  if (!profile || !isBatchProfile(profile) || !invite.category) return []
  return inviteCategoryTreeFor(profile).find(item => item.name === invite.category)?.children || []
})
const inviteThirdCategoryOptions = computed(() => {
  const profile = inviteProfile.value
  if (!profile || !isBatchProfile(profile) || !invite.category || !invite.subcategory) return []
  return inviteCategoryTreeFor(profile).find(item => item.name === invite.category)?.grandchildren?.find(item => item.name === invite.subcategory)?.children || []
})
const inviteMainCategoryPaths = computed(() => {
  const profile = inviteProfile.value
  if (!profile || !isBatchProfile(profile) || !profile.drawerForm?.mainCategory) return []
  return inviteCategoryTreeFor(profile).flatMap(item => [item.name, ...item.children.map(child => `${item.name}/${child}`)])
})
const inviteMissingItems = computed(() => {
  const profile = inviteProfile.value
  if (!profile || !ws.displayedStoreId) return ['请先打开一个店铺']
  return inviteTaskIssues({ profile, config: JSON.parse(JSON.stringify(invite)) })
})
const inviteReady = computed(() => Boolean(inviteProfile.value && !inviteMissingItems.value.length && inviteConfigLoaded.value))
const inviteTasks = computed(() => ws.tasks.filter((task: any) => String(task.name || '').startsWith('达人邀约 · ') && (!task.storeScope || task.storeScope === ws.displayedStoreId)))
const inviteLatest = computed(() => {
  const rows = [...inviteTasks.value]
  const active = rows.filter(task => taskActive(task)).sort((a, b) => Number(b.latestRun?.startedAt || b.updatedAt || b.createdAt || 0) - Number(a.latestRun?.startedAt || a.updatedAt || a.createdAt || 0))
  if (active[0]) return active[0]
  return rows.sort((a, b) => Number(b.latestRun?.finishedAt || b.updatedAt || b.createdAt || 0) - Number(a.latestRun?.finishedAt || a.updatedAt || a.createdAt || 0))[0] || null
})

function normalizeUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function submitUrl() {
  const url = normalizeUrl(urlDraft.value)
  if (url) void ws.navigate(url)
}

function goHome() {
  if (homeUrl.value) void ws.navigate(homeUrl.value)
}

async function refreshPlatformHomeUrls() {
  const result = await window.shopilot.settings.get('platform.homeUrls')
  if (result.ok && result.data?.value && typeof result.data.value === 'object') platformHomeUrls.value = result.data.value
}

async function refreshSquareUrls() {
  const result = await window.shopilot.settings.get('invite.squareUrls')
  if (result.ok && result.data?.value && typeof result.data.value === 'object') squareUrls.value = result.data.value
}

async function loadInviteCategoryTrees() {
  const result = await window.shopilot.settings.get(INVITE_CATEGORY_TREES_SETTING)
  const value = result.ok ? result.data?.value : null
  dynamicCategoryTrees.value = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, CategoryNode[]>
    : {}
}

async function saveInviteCategoryTree(platform: string, tree: CategoryNode[]) {
  const next = { ...dynamicCategoryTrees.value, [platform]: tree }
  const result = await window.shopilot.settings.set(INVITE_CATEGORY_TREES_SETTING, next)
  if (result.ok) dynamicCategoryTrees.value = next
}

async function refreshEntryRoutes() {
  const storeId = ws.displayedStoreId
  if (!storeId) { entryRoutes.value = []; return }
  const result = await window.shopilot.bookmark.entryRoutes(storeId)
  if (ws.displayedStoreId !== storeId) return
  entryRoutes.value = result.ok ? (result.data.routes || []) : []
}

function selectPanel(next: PanelKey) {
  panel.value = next
  if (next === 'bookmarks') void ws.refreshBookmarks()
  if (next === 'bookmarks') void refreshEntryRoutes()
  if (next === 'downloads') void ws.refreshDownloads()
  if (next === 'env') void refreshEnvironment()
  if (next === 'tasks') void ws.refreshTasks()
}

function togglePanel() {
  if (panelOpen.value && confirmations.value.length) {
    ws.toast('有待人工确认的任务，确认完成前不能收起侧栏', 'info')
    return
  }
  void setPanelOpen(!panelOpen.value)
}
async function setPanelOpen(next: boolean) {
  panelOpen.value = next
  const result = await window.shopilot.settings.set('ui.rightPanelCollapsed', !next)
  if (!result.ok) ws.toast(`侧栏状态保存失败：${result.error.message}`, 'error')
}
function openPanel(next: PanelKey) { panel.value = next; void setPanelOpen(true); selectPanel(next) }
function onBrowserKeydown(event: KeyboardEvent) {
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'b') { event.preventDefault(); togglePanel() }
}

function shortUrl(value: string) {
  try { return new URL(value).host } catch { return value }
}

function formatSize(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1048576).toFixed(1)} MB`
}

function downloadState(value: string) {
  return ({ completed: '已完成', in_progress: '下载中', cancelled: '已取消', interrupted: '中断' } as Record<string, string>)[value] || value || '未知状态'
}

async function refreshEnvironment() {
  const proxyResult = await window.shopilot.proxy.list()
  if (proxyResult.ok) proxies.value = proxyResult.data || []
  const storeId = ws.displayedStoreId
  if (!storeId) return
  proxyAuthObserved.value = false
  sessionState.value = { kind: 'loading', label: '读取中', detail: '正在读取店铺会话状态' }
  const sessionResult = await window.shopilot.session.status(storeId)
  if (ws.displayedStoreId !== storeId) return
  if (!sessionResult.ok) {
    sessionState.value = { kind: 'error', label: '读取失败', detail: sessionResult.error.message }
  } else {
    const status = sessionResult.data?.status || sessionResult.data?.state || sessionResult.data?.binding?.status
    const ready = status === 'READY' || status === 'ready' || status === 'online' || sessionResult.data?.ok === true
    sessionState.value = ready ? { kind: 'ready', label: '可用', detail: '会话状态由主进程返回' } : { kind: 'partial', label: '需检查', detail: String(status || '主进程未提供可用标记') }
    const binding = sessionResult.data?.binding
    proxyBindId.value = binding?.mode === 'bound' ? (binding.proxyId || '') : ''
    envBindingNote.value = binding?.mode === 'bound' ? '当前：绑定代理' : '当前：直连'
    proxyAuthObserved.value = sessionResult.data?.proxyAuthObserved === true
  }
  await Promise.all([refreshCookies(), refreshBackups(), ws.refreshSecurity()])
}

async function applyBind() {
  const storeId = ws.displayedStoreId
  if (!storeId) return
  const result = await window.shopilot.proxy.bind(storeId, proxyBindId.value || null)
  if (result.ok) { ws.toast(proxyBindId.value ? '已绑定代理，对打开中的店铺即时生效' : '已切回直连', 'success'); void refreshEnvironment() }
  else ws.toast(`绑定失败：${result.error.message}`, 'error')
}

async function testProxy(proxy: ProxyLite) {
  testingIds.value = [...testingIds.value, proxy.id]
  const result = await window.shopilot.proxy.test({ type: proxy.type, host: proxy.host, port: proxy.port }, proxy.id)
  testingIds.value = testingIds.value.filter(id => id !== proxy.id)
  if (result.ok && result.data?.ok) ws.toast(`代理可达，延迟 ${result.data.latencyMs} ms`, 'success')
  else ws.toast(`代理不可达：${result.ok ? result.data?.errorCode || '出口异常' : result.error.message}`, 'error')
  void refreshEnvironment()
}

async function addProxy() {
  const result = await window.shopilot.proxy.create({ type: np.type, host: np.host.trim(), port: Number(np.port), label: np.label.trim() || undefined }, np.user || undefined, np.pass || undefined)
  if (!result.ok) { ws.toast(`保存失败：${result.error.message}`, 'error'); return }
  ws.toast('代理已保存（凭据经本机加密存储，不回显）', 'success')
  np.label = ''; np.host = ''; np.port = null; np.user = ''; np.pass = ''
  void refreshEnvironment()
}

async function removeProxy(id: string) {
  if (!window.confirm('删除该代理？绑定它的店铺会回退直连。')) return
  const result = await window.shopilot.proxy.delete(id)
  if (!result.ok) { ws.toast(`删除失败：${result.error.message}`, 'error'); return }
  if (proxyBindId.value === id) proxyBindId.value = ''
  // 回落直连是**用户必须知道**的结果（真实 IP 会暴露给平台），不能只静默删掉
  const unbound = Number((result.data as any)?.unboundStores || 0)
  if (unbound > 0) ws.toast(`已删除代理：${unbound} 家店铺已回退直连（对面看到的是你的真实 IP），请重新绑定或确认可直连`, 'error')
  else ws.toast('已删除代理', 'success')
  void refreshEnvironment()
}

async function verifyEnv() {
  const storeId = ws.displayedStoreId
  if (!storeId) return
  verifying.value = true
  const result = await window.shopilot.profile.verify(storeId)
  verifying.value = false
  if (ws.displayedStoreId !== storeId) return
  if (!result.ok) { ws.toast(`验证失败：${result.error.message}`, 'error'); return }
  verifyItems.value = result.data?.items || []
  const failed = verifyItems.value.filter(item => item.state !== 'verified').length
  ws.toast(failed ? `${failed} 个字段未验证（需浏览器打开该店铺页面）` : '环境指纹全部字段实测一致', failed ? 'info' : 'success')
}

function clip(value: unknown) {
  const text = value == null ? '—' : String(value)
  return text.length > 46 ? `${text.slice(0, 43)}…` : text
}

async function refreshCookies() {
  const storeId = ws.displayedStoreId
  if (!storeId) { cookies.value = []; cookiesTotal.value = 0; return }
  const result = await window.shopilot.session.cookies(storeId, ckSearch.value || undefined)
  if (ws.displayedStoreId !== storeId) return
  if (result.ok) { cookies.value = result.data?.items || []; cookiesTotal.value = result.data?.total || 0 }
}

async function exportSession() {
  const storeId = ws.displayedStoreId
  if (!storeId) return
  secBusy.value = true
  const result = await window.shopilot.session.export(storeId)
  secBusy.value = false
  if (result.ok) ws.toast(`会话包已导出（${result.data.cookieCount} 条 Cookie，有效期至 ${new Date(result.data.expiresAt).toLocaleDateString()}）`, 'success')
  else if (result.error.code !== 'SESSION_CANCELLED') ws.toast(`导出失败：${result.error.message}`, 'error')
  if (result.ok) void refreshCookies()
}

async function importSession() {
  const storeId = ws.displayedStoreId
  if (!storeId) return
  secBusy.value = true
  const result = await window.shopilot.session.import(storeId, '', true)
  secBusy.value = false
  if (result.ok) ws.toast(`会话已导入：${result.data.imported} 条 Cookie 生效${result.data.failed ? `（${result.data.failed} 条失败）` : ''}`, 'success')
  else if (result.error.code !== 'SESSION_CANCELLED') ws.toast(`导入失败：${result.error.message}`, 'error')
  void refreshCookies()
}

async function delCookie(cookie: any) {
  const storeId = ws.displayedStoreId
  if (!storeId) return
  await window.shopilot.session.deleteCookie(storeId, cookie.name, cookie.domain, cookie.path, cookie.secure)
  void refreshCookies()
}

async function clearCookies() {
  const storeId = ws.displayedStoreId
  if (!storeId || !window.confirm(`清空「${store.value?.name || storeId}」的全部 Cookie？该店铺的登录态将失效。`)) return
  const result = await window.shopilot.session.clearCookies(storeId)
  if (result.ok) ws.toast('Cookie 已清空', 'success')
  else ws.toast(`清空失败：${result.error.message}`, 'error')
  void refreshCookies()
}

function say(message: string, ok = true) { secMsg.value = message; secMsgOk.value = ok }
async function setMasterPw() {
  const result = await window.shopilot.security.setPassword(pw1.value, ws.securityEnabled ? oldPw.value : undefined)
  if (result.ok) { say(ws.securityEnabled ? '主密码已更新' : '主密码已设置，可立即锁定或等待空闲自动锁定'); pw1.value = ''; pw2.value = ''; oldPw.value = ''; showChangePw.value = false; await ws.refreshSecurity() }
  else say(result.error.message, false)
}
async function removePw() {
  const credential = window.prompt('移除主密码需输入当前密码')
  if (!credential) return
  const result = await window.shopilot.security.removePassword(credential)
  if (result.ok) { say('主密码已移除'); await ws.refreshSecurity() } else say(result.error.message, false)
}
async function lockNow() {
  const result = await window.shopilot.security.lock()
  if (result.ok) await ws.refreshSecurity(); else say(result.error.message, false)
}
async function applyIdle() {
  const result = await window.shopilot.settings.set('security.idleMinutes', idleMinSel.value)
  if (result.ok) { say(idleMinSel.value ? `空闲 ${idleMinSel.value} 分钟自动锁定已启用` : '空闲自动锁定已关闭'); await ws.refreshSecurity() } else say(result.error.message, false)
}

async function refreshBackups() {
  const result = await window.shopilot.backup.list()
  if (result.ok) backups.value = (result.data || []).slice(0, 3)
}
async function doBackup() {
  busyBackup.value = true
  const result = await window.shopilot.backup.create()
  busyBackup.value = false
  if (result.ok) { ws.toast('数据库备份完成（含校验和）', 'success'); void refreshBackups() } else ws.toast(`备份失败：${result.error.message}`, 'error')
}
async function doRestore(id: string) {
  if (!window.confirm('恢复将覆盖当前数据库（恢复前会自动创建安全快照）。继续？')) return
  busyBackup.value = true
  const result = await window.shopilot.backup.restore(id)
  busyBackup.value = false
  if (result.ok) { ws.toast('已恢复备份，安全快照已保留', 'success'); await ws.refreshStores() } else ws.toast(`恢复失败（现有数据未受影响）：${result.error.message}`, 'error')
}
async function doDiagnostics() {
  busyDiag.value = true
  const result = await window.shopilot.diagnostics.export()
  busyDiag.value = false
  if (result.ok) ws.toast(`诊断包已导出：${result.data.path}`, 'success')
  else if (result.error.code !== 'SESSION_CANCELLED') ws.toast(`导出失败：${result.error.message}`, 'error')
}
function formatMemory(bytes: unknown): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '—'
  return `${(value / 1024 / 1024).toFixed(0)} MB`
}
async function readMemoryDiagnostics() {
  busyMemoryDiag.value = true
  try {
    const result = await window.shopilot.browser.memoryDiagnostics()
    if (result.ok) memoryDiag.value = result.data
    else ws.toast(`读取内存快照失败：${result.error.message}`, 'error')
  } finally {
    busyMemoryDiag.value = false
  }
}
async function doAuditExport() {
  const result = await window.shopilot.audit.export({ limit: 5000 })
  if (result.ok) ws.toast(`审计日志已导出（${result.data.rows} 条）`, 'success')
  else if (result.error.code !== 'SESSION_CANCELLED') ws.toast(`导出失败：${result.error.message}`, 'error')
}

function resetInviteDefaults() {
  const profile = inviteProfile.value
  invite.category = profile && isBatchProfile(profile) ? profile.categoryTree[2]?.name || profile.categoryTree[0]?.name || profile.categories[0] || '' : ''
  invite.subcategory = ''; invite.category3 = ''
  invite.levels = profile && isBatchProfile(profile) ? [...profile.levelsWithQuotaHint] : []
  invite.count = profile && isBatchProfile(profile) ? Math.max(1, Math.min(5, profile.maxBatch)) : 1
  invite.script = ''; invite.scriptMode = 'manual'; invite.benefits = []; invite.strengths = []; invite.mainCategory = ''
  invite.extraFilters = {}; invite.batchContact = ''; invite.batchPhone = ''; invite.batchWechat = ''; invite.batchProductCount = 1
  invite.contact = ''; invite.wechat = ''; invite.phone = ''; invite.productIds = ''; invite.finderType = '全部带货者'; invite.finderCategories = []; invite.finderOtherFilters = []
}

async function readInviteSetting(key: string) {
  const result = await window.shopilot.settings.get(key)
  const value = result.ok ? result.data?.value : null
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

async function loadInviteConfig() {
  const serial = ++inviteConfigLoadSerial
  const profile = inviteProfile.value
  const storeId = ws.displayedStoreId
  inviteConfigLoaded.value = false
  inviteConfigLoadedStoreId = ''
  resetInviteDefaults()
  if (!profile || !storeId) return
  let saved = await readInviteSetting(inviteConfigKey(storeId))
  if (serial !== inviteConfigLoadSerial || ws.displayedStoreId !== storeId) return
  let fromLegacy = false
  if (!saved) {
    saved = await readInviteSetting(legacyInviteConfigKey(profile.platform))
    fromLegacy = !!saved
  }
  if (serial !== inviteConfigLoadSerial || ws.displayedStoreId !== storeId) return
  if (saved) Object.assign(invite, normalizeInviteTaskConfig(profile.flow, saved))
  if (serial !== inviteConfigLoadSerial || ws.displayedStoreId !== storeId) return
  inviteConfigLoaded.value = true
  inviteConfigLoadedStoreId = storeId
  if (fromLegacy) {
    // 旧版按平台配置只作为首次打开的初始值，随后固化为本店铺键，避免同平台店铺互相覆盖。
    await window.shopilot.settings.set(inviteConfigKey(storeId), inviteSnapshot())
  }
}

function inviteSnapshot() {
  return JSON.parse(JSON.stringify({
    category: invite.category, subcategory: invite.subcategory, category3: invite.category3, levels: invite.levels,
    count: invite.count, script: invite.script, scriptMode: invite.scriptMode, benefits: invite.benefits, strengths: invite.strengths,
    mainCategory: invite.mainCategory, extraFilters: invite.extraFilters, batchContact: invite.batchContact, batchPhone: invite.batchPhone,
    batchWechat: invite.batchWechat, batchProductCount: invite.batchProductCount, contact: invite.contact, wechat: invite.wechat,
    phone: invite.phone, productIds: invite.productIds, finderType: invite.finderType, finderCategories: invite.finderCategories,
    finderOtherFilters: invite.finderOtherFilters
  }))
}

async function saveInviteConfig() {
  const storeId = ws.displayedStoreId
  if (!storeId || !inviteProfile.value) return
  inviteSaving.value = true
  const result = await window.shopilot.settings.set(inviteConfigKey(storeId), inviteSnapshot())
  inviteSaving.value = false
  if (result.ok) ws.toast('达人邀约配置已保存到当前店铺', 'success')
  else ws.toast(`保存邀约配置失败：${result.error.message}`, 'error')
}

watch(invite, () => {
  const storeId = ws.displayedStoreId
  if (!storeId || !inviteConfigLoaded.value || inviteConfigLoadedStoreId !== storeId) return
  if (inviteSaveTimer) clearTimeout(inviteSaveTimer)
  inviteSaveTimer = setTimeout(() => {
    if (ws.displayedStoreId !== storeId || !inviteConfigLoaded.value || inviteConfigLoadedStoreId !== storeId) return
    void window.shopilot.settings.set(inviteConfigKey(storeId), inviteSnapshot())
  }, 500)
}, { deep: true })

function inviteSquareUrl() {
  const profile = inviteProfile.value
  return profile ? squareUrls.value[profile.platform] || profile.pageUrl : ''
}

async function openInvitePage() {
  const url = inviteSquareUrl()
  const profile = inviteProfile.value
  if (!url || !profile) return
  if (profile.platform === '抖店' && isBatchProfile(profile) && profile.categoryDepth === 3 && ws.displayedStoreId) {
    try {
      const result = await window.shopilot.browser.prepareInviteSquare(ws.displayedStoreId, { url, loadCategoryTree: true })
      if (!result.ok) {
        ws.toast(`打开达人广场/读取三级类目失败：${result.error.message}`, 'error')
        return
      }
      const tree = (result.data as { categoryTree?: CategoryNode[] })?.categoryTree
      if (tree?.length) {
        await saveInviteCategoryTree(profile.platform, tree)
        await loadInviteConfig()
        ws.toast(`达人广场已打开，已读取 ${tree.length} 个一级类目的完整三级结构`, 'success')
      } else {
        ws.toast('达人广场已打开，但平台未返回三级类目', 'info')
      }
    } catch (error: any) {
      ws.toast(`打开达人广场/读取三级类目失败：${String(error?.message || error)}`, 'error')
    }
    return
  }
  void ws.navigate(url)
}

async function startInvite() {
  if (inviteSubmitting.value || !inviteProfile.value || !ws.displayedStoreId || !inviteReady.value) return
  inviteSubmitting.value = true
  try {
    const payload = buildInviteTaskPayload({ profile: inviteProfile.value, storeId: ws.displayedStoreId, squareUrl: inviteSquareUrl(), config: inviteSnapshot() })
    if (!payload) { ws.toast('邀约配置不完整，无法创建任务', 'error'); return }
    const created = await window.shopilot.task.create(payload)
    if (!created.ok) { ws.toast(`创建邀约任务失败：${created.error.message}`, 'error'); return }
    const started = await window.shopilot.task.run(created.data.id)
    if (!started.ok) { await ws.refreshTasks(); ws.toast(`邀约任务已创建但启动失败：${started.error.message}`, 'error'); return }
    ws.toast('邀约任务已启动，进度和日志会实时显示在当前面板', 'success')
    await ws.refreshTasks()
  } finally {
    inviteSubmitting.value = false
  }
}

function taskRun(task: any) {
  return task.latestRun
}

function taskStatus(task: any) {
  const run = taskRun(task)
  const status = run?.id ? ws.runLive[run.id]?.status || run.status : run?.status
  return ({ running: '正在运行', queued: '排队中', waiting_confirmation: '等待确认', paused: '已暂停', succeeded: '已完成', failed: '执行失败', cancelled: '已取消' } as Record<string, string>)[status || ''] || '尚未运行'
}

function taskActive(task: any) {
  const run = taskRun(task)
  const status = run?.id ? ws.runLive[run.id]?.status || run.status : run?.status
  return ['queued', 'running', 'waiting_confirmation', 'paused'].includes(status)
}

function taskProgress(task: any) {
  const run = taskRun(task)
  if (!run) return 0
  const live = run.id ? ws.runLive[run.id] : null
  const status = live?.status || run.status
  if (status === 'succeeded') return 100
  const step = live?.stepIndex ?? run.currentStep
  if (!task.steps?.length || step == null) return 0
  return Math.min(99, Math.max(0, Math.round(((step + 1) / task.steps.length) * 100)))
}

function inviteRun(task: any) { return task?.latestRun }
function inviteRunId(task: any) { return inviteRun(task)?.id || '' }
function inviteStatus(task: any) {
  const status = inviteRunId(task) ? ws.runLive[inviteRunId(task)]?.status || inviteRun(task)?.status : inviteRun(task)?.status
  return ({ running: '正在运行', queued: '排队中', waiting_confirmation: '等待确认', paused: '已暂停', succeeded: '已完成', failed: '执行失败', cancelled: '已取消' } as Record<string, string>)[status || ''] || '尚未运行'
}
function inviteActive(task: any) {
  const run = inviteRun(task)
  const status = run?.id ? ws.runLive[run.id]?.status || run.status : run?.status
  return ['queued', 'running', 'waiting_confirmation', 'paused'].includes(status)
}
function inviteStepIndex(task: any) {
  const run = inviteRun(task)
  return run?.id ? (ws.runLive[run.id]?.stepIndex ?? run.currentStep ?? null) : (run?.currentStep ?? null)
}
function inviteStuckText(task: any) {
  const steps = task?.steps || []
  const index = inviteStepIndex(task)
  if (!inviteActive(task)) return `${inviteStatus(task)} · 共 ${steps.length} 步`
  if (index == null) return `正在准备邀约 · 共 ${steps.length} 步`
  const safeIndex = Math.min(Math.max(index, 0), Math.max(steps.length - 1, 0))
  const message = inviteLiveMessage(task)
  return `卡在第 ${safeIndex + 1}/${steps.length} 步${message ? `：${message}` : ''}`
}
function inviteStepIcon(task: any, index: number) {
  const status = inviteRunId(task) ? ws.runLive[inviteRunId(task)]?.status || inviteRun(task)?.status : inviteRun(task)?.status
  const current = inviteStepIndex(task)
  if (status === 'succeeded') return '✅'
  if (status === 'failed' && current === index) return '❌'
  if (current != null && index < current) return '✅'
  if (current == null && index === 0 && inviteActive(task)) return '⏳'
  if (current === index && inviteActive(task)) return '⏳'
  return '○'
}
function inviteStepLabel(step: any) { return ({ waitMs: '等待页面状态', navigate: '打开平台页面', click: '点击页面元素', input: '填写页面内容', screenshot: '保存页面截图', readText: '读取页面信息' } as Record<string, string>)[step?.type] || step?.type || '任务步骤' }
function inviteStepInput(step: any) {
  const value = step?.input
  if (!value) return '等待真实运行结果'
  try { const text = JSON.stringify(value); return text.length > 90 ? `${text.slice(0, 87)}…` : text } catch { return '等待真实运行结果' }
}
function inviteLiveMessage(task: any) { const runId = inviteRunId(task); return runId ? String(ws.runLive[runId]?.message || '') : '' }
function inviteLogs(task: any) { const runId = inviteRunId(task); return runId ? (ws.taskLogs[runId] || []) : [] }
function inviteLogText(log: any) { return `[${new Date(log.at || Date.now()).toLocaleTimeString()}] ${log.message || log.phase || log.status || '任务状态已更新'}` }
async function stopInvite(task: any) { const runId = inviteRunId(task); if (!runId) return; const result = await window.shopilot.task.cancel(runId); if (!result.ok) ws.toast(`停止邀约失败：${result.error.message}`, 'error'); await ws.refreshTasks() }

async function removeBookmark(id: string) {
  const result = await window.shopilot.bookmark.delete(id)
  if (result.ok) await ws.refreshBookmarks()
}

function showInFolder(id: string) {
  void window.shopilot.download.showInFolder(id)
}

async function cancelTask(task: any) {
  const runId = taskRun(task)?.id
  if (!runId) return
  const result = await window.shopilot.task.cancel(runId)
  if (result.ok) await ws.refreshTasks()
}

async function runTask(task: any) {
  if (taskActive(task)) return
  const result = await window.shopilot.task.run(task.id, task.storeScope || undefined)
  if (!result.ok) ws.toast(`运行任务失败：${result.error.message}`, 'error')
  else await ws.refreshTasks()
}

async function confirmRun(runId: string, approved: boolean) {
  const result = await window.shopilot.task.confirm(runId, approved)
  if (!result.ok) {
    ws.toast(`确认失败：${result.error.message}`, 'error')
    return
  }
  ws.clearConfirmation(runId)
  await ws.refreshTasks()
}

watch(() => ws.activeTab?.url, value => { urlDraft.value = value || '' }, { immediate: true })
watch(() => confirmations.value.length, count => { if (count > 0) panelOpen.value = true })
watch(() => `${inviteRunId(inviteLatest.value)}:${inviteLogs(inviteLatest.value).length}`, () => { void nextTick(() => { if (inviteLiveLogEl.value) inviteLiveLogEl.value.scrollTop = inviteLiveLogEl.value.scrollHeight }) })
watch(() => ws.idleMinutes, value => { idleMinSel.value = value }, { immediate: true })
// 宿主不再随切页销毁（页面状态要留住），因此"回到浏览器页时重读设置"必须显式做：
// 平台首页地址、达人广场地址、类目树都可能刚在设置中心被改过，靠旧的"重新挂载"刷新已经不成立。
watch(() => props.active, active => {
  if (!active) return
  void refreshPlatformHomeUrls()
  void refreshSquareUrls()
  void loadInviteCategoryTrees()
  void refreshEntryRoutes()
  if (panel.value === 'env') void refreshEnvironment()
})
watch(() => ws.proxyEpoch, () => { if (panel.value === 'env') void refreshEnvironment() })
watch(() => ws.displayedStoreId, () => { verifyItems.value = []; void loadInviteConfig(); if (panel.value === 'env') void refreshEnvironment(); if (panel.value === 'bookmarks') void refreshEntryRoutes() })
watch(() => panel.value, value => { if (value === 'env') void refreshEnvironment() })
watch(() => invite.category, () => { if (invite.subcategory && !inviteSubcategoryOptions.value.includes(invite.subcategory)) invite.subcategory = ''; if (invite.category3 && !inviteThirdCategoryOptions.value.includes(invite.category3)) invite.category3 = '' })
watch(() => invite.subcategory, () => { if (invite.category3 && !inviteThirdCategoryOptions.value.includes(invite.category3)) invite.category3 = '' })
function clampInvitePicks(list: string[], max: number | undefined, label: string): string[] | null {
  if (!max || list.length <= max) return null
  ws.toast(`${label}最多选 ${max} 项：${list.slice(max).join('、')} 没选上`, 'info')
  return list.slice(0, max)
}
watch(() => invite.benefits, value => {
  const profile = inviteProfile.value
  const clipped = clampInvitePicks(value, profile && isBatchProfile(profile) ? profile.benefitsMax : undefined, '权益')
  if (clipped) invite.benefits = clipped
}, { deep: true })
watch(() => invite.strengths, value => {
  const profile = inviteProfile.value
  const clipped = clampInvitePicks(value, profile && isBatchProfile(profile) ? profile.strengths?.maxSelect : undefined, '核心优势')
  if (clipped) invite.strengths = clipped
}, { deep: true })

onMounted(async () => {
  const saved = await window.shopilot.settings.get('ui.rightPanelCollapsed')
  if (saved.ok && saved.data?.value === true) panelOpen.value = false
  window.addEventListener('keydown', onBrowserKeydown)
  void ws.refreshTasks()
  void ws.refreshSecurity()
  void refreshPlatformHomeUrls()
  void refreshSquareUrls()
  void loadInviteCategoryTrees()
  void refreshEntryRoutes()
  void loadInviteConfig()
})

onBeforeUnmount(() => {
  if (inviteSaveTimer) clearTimeout(inviteSaveTimer)
  inviteSaveTimer = null
  webviewEls.clear()
  window.removeEventListener('keydown', onBrowserKeydown)
})
</script>

<style scoped>
.dashboard-browser-surface {
  /* 这块是**浅色**表面：面板里不少文字沿用深色主题的浅色 token，在白底上对比度只有 1~2.6:1
     （用户实报「字体颜色看不清楚」，2026-10-02）。这里就地换掉 muted 灰，面板内所有 muted 文字
     （页签、空状态、进度百分比、字段标签、行副标题）一起回到 WCAG AA 之上；其余浅色字逐个改。 */
  --dash-text-muted: #5b6472;
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 20px 20px;
  overflow: hidden;
  background: radial-gradient(circle at 60% 0%, rgba(55, 76, 130, .14), transparent 40%);
}
.dashboard-browser-address {
  display: flex;
  align-items: center;
}
.browser-nav-button,
.dashboard-browser-tab-add,
.dashboard-browser-panel-toggle {
  border: 1px solid var(--dash-border);
  border-radius: 8px;
  background: #ffffff;
  color: var(--dash-text-soft);
  cursor: pointer;
}
.browser-nav-button:hover,
.browser-nav-button:focus-visible,
.dashboard-browser-tab-add:hover,
.dashboard-browser-tab-add:focus-visible,
.dashboard-browser-panel-toggle:hover,
.dashboard-browser-panel-toggle:focus-visible { border-color: rgba(145, 116, 255, .7); color: var(--dash-text); outline: none; }
.dashboard-browser-tabs { display: flex; min-width: 0; align-items: stretch; gap: 5px; min-height: 34px; overflow-x: auto; }
.dashboard-browser-tab { display: flex; min-width: 130px; max-width: 240px; align-items: center; gap: 7px; padding: 0 9px; border: 1px solid transparent; border-radius: 8px 8px 0 0; background: #f4f6fb; color: var(--dash-text-muted); cursor: pointer; }
.dashboard-browser-tab.active { border-color: var(--dash-border); border-bottom-color: rgba(139, 92, 246, .75); background: #ffffff; color: var(--dash-text); }
.dashboard-browser-tab:hover { color: var(--dash-text); }
.browser-tab-title { overflow: hidden; flex: 1; text-overflow: ellipsis; white-space: nowrap; text-align: left; font-size: 11px; }
.browser-tab-close { display:grid;place-items:center;flex: 0 0 auto; color: var(--dash-text-muted); line-height: 1; }.browser-tab-close img { width:13px;height:13px;object-fit:contain; }
.browser-tab-close:hover { color: #d92d20; }
.browser-tab-spinner { width: 9px; height: 9px; flex: 0 0 auto; border: 1px solid rgba(150, 137, 255, .28); border-top-color: #b99aff; border-radius: 50%; animation: dashboard-browser-spin .8s linear infinite; }
.dashboard-browser-tab-add { display:grid;place-items:center;width: 34px; min-width: 34px; height: 30px; align-self: center; }.dashboard-browser-tab-add img { width:16px;height:16px;object-fit:contain; }
/* 侧栏开关：原先在头部栏，头部整条移除后挪到标签栏右端（margin-left:auto 保证永远贴在右端）。
   收起时把箭头翻转成"指向左"，语义与面板从右侧收/放一致 */
.dashboard-browser-panel-toggle { display:grid;place-items:center; width: 30px; min-width: 30px; height: 30px; margin-left: auto; align-self: center; }.dashboard-browser-panel-toggle img { width:16px;height:16px;object-fit:contain; }
.dashboard-browser-panel-toggle.collapsed img { transform: scaleX(-1); }
.dashboard-browser-address { gap: 6px; min-height: 38px; padding: 0 8px; border: 1px solid var(--dash-border); border-radius: 10px; background: #f7f9fd; }
.browser-nav-button { display:grid;place-items:center; width: 28px; height: 28px; padding: 0; line-height: 1; }.browser-nav-button img { width:16px;height:16px;object-fit:contain; }
.browser-nav-button:disabled { cursor: default; opacity: .4; }
.dashboard-browser-url img { width:15px;height:15px;object-fit:contain;flex:0 0 auto; }.dashboard-browser-url { min-width: 0; flex: 1; display: flex; align-items: center; gap: 7px; height: 28px; padding: 0 9px; border: 1px solid rgba(111, 137, 177, .16); border-radius: 7px; background: #ffffff; color: var(--dash-text-muted); }
.dashboard-browser-url:focus-within { border-color: rgba(135, 102, 246, .7); box-shadow: 0 0 0 2px rgba(135, 102, 246, .12); }
.dashboard-browser-url input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--dash-text-soft); font-size: 11px; }
.dashboard-browser-hint { flex: 0 0 auto; color: var(--dash-text-muted); font-size: 10px; }
.dashboard-browser-body { min-width: 0; min-height: 0; flex: 1; display: flex; gap: 12px; overflow: hidden; }
.dashboard-browser-surface.picker-mode .dashboard-browser-body { flex: 0 0 clamp(320px, calc(100vh - 190px), 1000px); width: calc(100% - min(980px, 70vw)); max-width: calc(100% - min(980px, 70vw)); height: clamp(320px, calc(100vh - 190px), 1000px); align-self: flex-start; }
.dashboard-browser-surface.picker-mode .dashboard-browser-panel { display: none; }
.dashboard-browser-main { min-width: 0; min-height: 0; flex: 1; display: flex; }
.dashboard-browser-viewport { position: relative; min-width: 0; min-height: 0; flex: 1; overflow: hidden; border: 1px solid var(--dash-border); border-radius: 12px; background: #ffffff; box-shadow: 0 12px 28px rgba(0, 0, 0, .2); }
/* 真实店铺页面（DOM <webview>）：撑满视口容器。未激活的店铺/标签页用 opacity + pointer-events
   隐藏而**不**用 display/visibility —— 后者会让 guest 自认不可见，平台页面会停止渲染；
   opacity 保持"页面可见"语义，同时用户看不到也点不到。 */
.dashboard-browser-webview { position: absolute; inset: 0; display: flex; width: 100%; height: 100%; border: 0; opacity: 0; pointer-events: none; z-index: 0; }
.dashboard-browser-webview.active { opacity: 1; pointer-events: auto; z-index: 1; }
.dashboard-browser-webview-diagnostics { position: absolute; left: 10px; bottom: 10px; z-index: 3; display: flex; max-width: calc(100% - 20px); flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid rgba(242, 165, 87, .36); border-radius: 8px; background: #fff8ec; color: #92400e; font-size: 10px; line-height: 1.5; }
.dashboard-browser-webview-diagnostics strong { color: #7a3d0a; font-size: 10px; }
.dashboard-browser-webview-diagnostics span { display: flex; align-items: center; gap: 6px; overflow-wrap: anywhere; }
.dashboard-browser-panel { width: 320px; min-width: 320px; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--dash-border); border-radius: 12px; background: #ffffff; }
.dashboard-browser-panel.collapsed { width: 44px; min-width: 44px; align-items: center; }
.panel-rail-expand, .panel-rail-button { width: 30px; height: 30px; margin: 7px 0 0; border: 0; border-radius: 7px; background: transparent; color: var(--dash-text-muted); cursor: pointer; }
.panel-rail-expand:hover, .panel-rail-expand:focus-visible, .panel-rail-button:hover, .panel-rail-button:focus-visible, .panel-rail-button.on { background: rgba(124, 92, 255, .14); color: #4c1d95; outline: none; }.panel-rail-button img { width: 17px; height: 17px; object-fit: contain; }
.panel-rail-expand { display:grid;place-items:center; border-bottom: 1px solid var(--dash-border); border-radius: 0; }.panel-rail-expand img { width:16px;height:16px;object-fit:contain; }
.dashboard-browser-panel-tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; padding: 7px; border-bottom: 1px solid var(--dash-border); background: #f7f9fd; }
.dashboard-browser-panel-tabs button { min-width: 0; height: 30px; padding: 0 3px; border: 0; border-radius: 6px; background: transparent; color: var(--dash-text-muted); font-size: 10px; cursor: pointer; }
.dashboard-browser-panel-tabs button:hover, .dashboard-browser-panel-tabs button:focus-visible { background: rgba(124, 92, 255, .12); color: var(--dash-text); outline: none; }
.dashboard-browser-panel-tabs button.active { background: var(--brand-soft); color: #4c1d95; }.panel-tab-icon { width: 14px; height: 14px; margin-right: 4px; object-fit: contain; vertical-align: -2px; }
.confirm-bar { display: flex; align-items: flex-start; gap: 9px; padding: 9px 10px; border-bottom: 1px solid rgba(242, 165, 87, .26); background: rgba(245, 158, 11, .12); }
.env-confirm-bar { position: fixed; top: 108px; right: 24px; z-index: 300; width: min(296px, calc(100vw - 48px)); box-sizing: border-box; border: 1px solid rgba(242,165,87,.38); border-radius: 9px; box-shadow: 0 14px 32px rgba(0,0,0,.3); }
.confirm-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; color: #92400e; font-size: 10px; line-height: 1.45; }
.confirm-copy span { overflow-wrap: anywhere; color: var(--dash-text-soft); }
.confirm-actions { display: flex; flex: 0 0 auto; gap: 4px; }
.confirm-actions button { height: 25px; padding: 0 7px; border: 1px solid var(--dash-border); border-radius: 6px; background: #ffffff; color: var(--dash-text-soft); cursor: pointer; font-size: 10px; }
.confirm-actions button:hover, .confirm-actions button:focus-visible { outline: none; border-color: rgba(124, 92, 255, .55); color: var(--dash-text); }
.confirm-actions .confirm-allow { border-color: rgba(6, 118, 71, .35); color: #067647; }
.dashboard-browser-panel-body { min-height: 0; flex: 1; overflow-y: auto; padding: 12px; scrollbar-width: thin; scrollbar-color: rgba(137,153,189,.32) transparent; }
.browser-panel-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; color: var(--dash-text-soft); font-size: 12px; }
.browser-panel-heading-actions { display: inline-flex; align-items: center; gap: 7px; }
.browser-panel-heading button { border: 0; background: transparent; color: #5b3df5; font-size: 10px; cursor: pointer; }
.browser-panel-heading button:hover { color: #4326d9; text-decoration: underline; }
.browser-panel-empty { display: grid; min-height: 150px; place-items: center; color: var(--dash-text-muted); font-size: 11px; text-align: center; gap: 4px; }
.browser-state-art { display: block; width: min(132px, 72%); height: auto; border-radius: 14px; opacity: .92; }
.browser-inline-art { display: block; width: 44px; height: 44px; object-fit: contain; border-radius: 9px; opacity: .9; }
.env-empty-note { display: flex; align-items: center; gap: 8px; }
.browser-panel-empty.compact { min-height: 44px; }
.browser-panel-row { display: flex; width: 100%; min-height: 48px; align-items: center; gap: 8px; padding: 7px 5px; border: 0; border-bottom: 1px solid rgba(111,137,177,.1); background: transparent; color: var(--dash-text-soft); text-align: left; cursor: pointer; }
.browser-panel-row:hover, .browser-panel-row:focus-visible { background: #f7f9fd; color: var(--dash-text); outline: none; }
.browser-panel-row-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
.browser-panel-row-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 600; }
.browser-panel-row-copy small { overflow: hidden; color: var(--dash-text-muted); text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
.browser-panel-row-action { display:grid;place-items:center; flex: 0 0 auto; border: 0; background: transparent; color: var(--dash-text-muted); cursor: pointer; }.browser-panel-row-action img { width:15px;height:15px;object-fit:contain; }
.browser-panel-row-action:hover { color: var(--dash-text); }
.browser-env-card { display: flex; min-height: 42px; flex-direction: column; justify-content: center; gap: 4px; margin-bottom: 7px; padding: 8px 9px; border: 1px solid rgba(111,137,177,.13); border-radius: 8px; background: #f7f9fd; }
.browser-env-card span, .browser-env-card small { color: var(--dash-text-muted); font-size: 10px; }
.browser-env-card strong { color: var(--dash-text-soft); font-size: 11px; }
.browser-env-card strong.state-online, .browser-env-card strong.state-ready { color: var(--dash-green); }
.browser-env-card strong.state-needs_login, .browser-env-card strong.state-partial { color: var(--dash-orange); }
.browser-env-card strong.state-error, .browser-env-card strong.state-offline { color: #ef6a7b; }
.browser-panel-note { margin-top: 12px; color: var(--dash-text-muted); font-size: 10px; line-height: 1.55; }
.env-body { padding: 0; }
.env-sec { padding: 12px 14px; border-bottom: 1px solid var(--dash-border); }
.env-h { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; color: var(--dash-text-soft); font-size: 11px; font-weight: 600; letter-spacing: .3px; }
.env-action { margin-left: auto; }
.bind-row { display: flex; align-items: center; gap: 8px; }
.bind-row select, .proxy-add input, .add-line select, .add-line input, [data-test="session-sec"] input, [data-test="lock-sec"] input, [data-test="diag-sec"] input { box-sizing: border-box; border: 1px solid var(--dash-border); border-radius: 7px; background: #ffffff; color: var(--dash-text-soft); font: inherit; }
.bind-row select { width: 100%; min-height: 30px; padding: 0 8px; font-size: 10px; }
.env-note { margin-top: 7px; color: var(--dash-text-muted); font-size: 10px; line-height: 1.5; }
.env-note.ok { color: #067647; }
.proxy-item { display: flex; min-width: 0; align-items: center; gap: 7px; padding: 7px 0; border-top: 1px solid rgba(111,137,177,.08); }
.p-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: #78849b; }.p-dot.proxy-ok { background: #20d19a; }.p-dot.proxy-error { background: #ef6a7b; }
.p-info, .v-info { min-width: 0; flex: 1; }
.row-main { overflow: hidden; color: var(--dash-text-soft); text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }.row-sub { overflow: hidden; color: var(--dash-text-muted); text-overflow: ellipsis; white-space: nowrap; font-size: 9px; }
.button-icon { width:14px;height:14px;object-fit:contain;vertical-align:middle;margin-right:4px; }.mini-btn { min-height: 25px; padding: 0 8px; border: 1px solid var(--dash-border); border-radius: 6px; background: #ffffff; color: var(--dash-text-soft); cursor: pointer; font-size: 9px; white-space: nowrap; }.mini-btn:hover:not(:disabled), .mini-btn:focus-visible { border-color: rgba(145,116,255,.7); color: var(--dash-text); outline: none; }.mini-btn:disabled { cursor: not-allowed; opacity: .48; }.mini-btn.primary { border-color: #5b3df5; background: #6d4aff; color: #ffffff; }
.row-del { display:grid;place-items:center; width: 21px; height: 23px; flex: 0 0 21px; border: 0; border-radius: 5px; background: transparent; color: #78849b; cursor: pointer; font-size: 15px; }.row-del img { width:14px;height:14px;object-fit:contain; }.row-del:hover, .row-del:focus-visible { background: rgba(217,45,32,.14); color: #d92d20; outline: none; }.row-del:disabled { cursor: default; opacity: .56; }
.proxy-add { display: flex; flex-direction: column; gap: 6px; margin-top: 9px; }.proxy-add > input, .add-line input, .add-line select { min-height: 28px; padding: 0 7px; font-size: 9px; }.add-line { display: flex; gap: 6px; }.add-line select { width: 74px; min-width: 74px; flex: 0 0 74px; }.add-line .f-host { min-width: 60px; flex: 1 1 auto; }.add-line .f-port { width: 72px; min-width: 72px; flex: 0 0 72px; }.proxy-add > .mini-btn { align-self: flex-start; margin-top: 1px; }
.verify-item { display: flex; align-items: center; gap: 7px; padding: 6px 0; }.verify-status-icon { width: 17px; height: 17px; flex: 0 0 17px; object-fit: contain; }.cf-btns { display: flex; flex-wrap: wrap; gap: 6px; }.cf-btns.wrap { gap: 6px; }.cf-btns .mini-btn { margin-top: 0; }.ck-search { width: 100%; min-height: 28px; margin-top: 7px; padding: 0 7px; font-size: 9px; }.cookie-count { margin: 5px 0; }.ck-item { padding: 5px 0; }.ck-flag { margin-left: 4px; padding: 1px 3px; border: 1px solid var(--dash-border); border-radius: 4px; color: var(--dash-text-muted); font-size: 8px; }.danger-btn { border-color: rgba(217,45,32,.35); color: #d92d20; }.idle-row { margin-top: 7px; justify-content: space-between; }.idle-row select { width: auto; min-width: 94px; }.backup-row { display: flex; align-items: center; gap: 5px; margin-top: 7px; white-space: normal; }.backup-row .mini-btn { margin-left: auto; }
.browser-task-row { display: flex; align-items: center; gap: 7px; min-height: 54px; padding: 7px 3px; border-bottom: 1px solid rgba(111,137,177,.1); }
.browser-task-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
.browser-task-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dash-text-soft); font-size: 11px; }
.browser-task-copy small { color: var(--dash-text-muted); font-size: 10px; }
.browser-task-progress { height: 4px; overflow: hidden; border-radius: 4px; background: rgba(116, 132, 166, .2); }
.browser-task-progress i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #6563ff, #25baf1); }
.browser-task-percent { flex: 0 0 31px; color: var(--dash-text-muted); font-size: 10px; text-align: right; }
.browser-panel-link { width: 100%; margin-top: 12px; padding: 8px 0; border: 0; border-radius: 6px; background: rgba(124, 92, 255, .1); color: #5b3df5; font-size: 10px; cursor: pointer; }
.browser-panel-link:hover, .browser-panel-link:focus-visible { background: rgba(124, 92, 255, .18); color: #4326d9; outline: none; }
.task-subtabs { display: flex; gap: 4px; margin: 0 -2px 10px; padding: 3px; border-radius: 7px; background: #f2f4f8; }.task-subtabs button { flex: 1; min-height: 26px; border: 0; border-radius: 5px; background: transparent; color: var(--dash-text-muted); cursor: pointer; font-size: 9px; }.task-subtabs button:hover, .task-subtabs button:focus-visible { color: var(--dash-text); outline: none; }.task-subtabs button.on { background: rgba(117,83,235,.34); color: #4c1d95; }.task-subtabs button.pending { color: #8a5a12; }
.invite-panel { min-width: 0; }.invite-config-sec { padding-bottom: 12px; }.invite-config-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 7px 0 9px; }.invite-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin-top: 8px; }.invite-field { display: flex; min-width: 0; flex-direction: column; gap: 4px; color: var(--dash-text-muted); font-size: 10px; }.invite-field input,.invite-field select { min-width: 0; height: 29px; padding: 0 7px; border: 1px solid var(--dash-border); border-radius: 6px; background: #ffffff; color: var(--dash-text-soft); font-size: 10px; }.invite-field input:focus,.invite-field select:focus { border-color: rgba(145,113,255,.78); outline: none; box-shadow: 0 0 0 2px rgba(145,113,255,.14); }.invite-choice-group { margin-top: 9px; color: var(--dash-text-muted); font-size: 10px; }.invite-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }.inv-chip { display: inline-flex; align-items: center; gap: 4px; min-height: 24px; padding: 0 6px; border: 1px solid rgba(111,137,177,.22); border-radius: 999px; background: #f7f9fd; color: var(--dash-text-muted); cursor: pointer; font-size: 9px; }.inv-chip input { position: absolute; opacity: 0; pointer-events: none; }.inv-chip.on { border-color: rgba(135,102,246,.72); background: rgba(111,77,225,.18); color: #4c1d95; }.invite-missing { margin: 8px 0 0; padding: 7px 8px 7px 21px; border: 1px solid rgba(242,165,87,.2); border-radius: 7px; background: rgba(245,158,11,.12); color: #92400e; font-size: 9px; line-height: 1.5; }.invite-start-row { display: flex; align-items: center; gap: 8px; margin-top: 9px; }.entry-routes-title { margin-left: 6px; }.entry-route { min-height: 42px; padding-left: 4px; }.invite-live-sec { padding: 3px 2px 12px; border-bottom: 0; }.invite-live-empty { min-height: 150px; padding: 12px; line-height: 1.6; }.invite-live-stuck { padding: 8px 9px; border: 1px solid rgba(242,165,87,.24); border-radius: 7px; background: rgba(245,158,11,.12); color: #92400e; font-size: 10px; line-height: 1.45; }.step-row { display: flex; align-items: flex-start; gap: 7px; padding: 7px 0 0 3px; }.s-ico { width: 17px; flex: 0 0 17px; text-align: center; font-size: 11px; }.tc-btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }.invite-message { padding: 5px 0 2px; line-height: 1.5; white-space: normal; }.log-box { max-height: 210px; margin-top: 8px; padding: 7px 8px; overflow-y: auto; border: 1px solid var(--dash-border); border-radius: 7px; background: #f7f9fd; }.log-line { color: #4a5568; font-family: Consolas, monospace; font-size: 9px; line-height: 1.6; overflow-wrap: anywhere; }.invite-unavailable { padding: 10px 2px; border-bottom: 0; }.invite-unavailable .mini-btn { margin-top: 8px; }
@keyframes dashboard-browser-spin { to { transform: rotate(360deg); } }
@media (max-width: 820px) {
  .dashboard-browser-surface { padding: 12px 14px 16px; }
  .dashboard-browser-hint { display: none; }
  .dashboard-browser-panel { width: 244px; min-width: 244px; }
}
@media (max-width: 680px) {
  .dashboard-browser-body { flex-direction: column; overflow-y: auto; }
  .dashboard-browser-main { min-height: 420px; flex: 1 1 420px; }
  .dashboard-browser-panel { width: auto; min-width: 0; min-height: 230px; flex: 0 0 230px; }
}</style>
