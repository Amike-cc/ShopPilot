<template>
  <div class="workbench">
    <!-- 左栏：店铺侧边栏 - §8.2 StoreSidebar（可收起为窄轨：新建/回收站/设置仍可达） -->
    <aside class="sidebar" :class="{ collapsed: leftSidebarCollapsed }" data-test="sidebar">
      <div class="sidebar-rail" v-if="leftSidebarCollapsed">
        <button class="rail-btn" data-test="sidebar-expand" title="展开左侧栏（Ctrl+Shift+E）" @click="expandSidebar()">›</button>
        <button class="rail-btn" data-test="rail-new" title="新建店铺" @click="openCreateDialog()">+</button>
        <button class="rail-btn" data-test="rail-trash" title="回收站" @click="openTrash">
          🗑
          <span v-if="ws.trashStores.length" class="rail-badge" data-test="rail-trash-badge"></span>
        </button>
        <button class="rail-btn" data-test="rail-settings" title="设置（含软件更新）" @click="openSettings()">⚙</button>
        <button class="rail-btn dc-rail-btn" data-test="rail-invoice-center" title="发票中心（全部店铺）" @click="openInvoiceCenter()">🧾</button>
      </div>

      <template v-else>
      <div class="brand">
        <div class="brand-logo">商</div>
        <div class="brand-name">ShopPilot</div>
        <button class="sidebar-collapse" data-test="sidebar-collapse" title="收起左侧栏（Ctrl+Shift+E）" @click="collapseSidebar()">‹</button>
      </div>

      <div class="sidebar-tools">
        <div class="search-box">
          <span class="search-ico">🔍</span>
          <input v-model="ws.search" placeholder="搜索店铺 / 平台 / 标签 / 营业执照" />
        </div>
        <button class="btn-new" @click="openCreateDialog()" title="新建店铺">+</button>
      </div>

<div class="filter-platform" v-if="ws.platformCounts && Object.keys(ws.platformCounts).length > 0">
        <div class="fp-header">
          <span class="fp-label">平台</span>
          <button v-if="ws.filterPlatform" class="fp-clear" @click="ws.filterPlatform = ''" title="清除平台筛选">✕</button>
        </div>
        <button
          :class="['fp-chip', { on: !ws.filterPlatform }]"
          @click="ws.filterPlatform = ''"
          title="显示全部平台"
        >
          全部
          <span class="fp-count">{{ totalFilteredCount }}</span>
        </button>
        <template v-for="p in availablePlatforms" :key="p.name">
          <button
            :class="['fp-chip', { on: ws.filterPlatform === p.name }]"
            :style="chipStyle(ws.filterPlatform === p.name, p.color)"
            @click="ws.filterPlatform = p.name"
            :title="p.name + '（' + p.count + ' 家店铺）'"
          >
            <template v-if="p.platform">
              <PlatformIcon :name="p.platform" :size="12" />
            </template>
            <template v-else>
              <span class="fp-other-icon">📦</span>
            </template>
            <span>{{ p.shortName }}</span>
            <span class="fp-count">{{ p.count }}</span>
          </button>
        </template>
      </div>

      <div class="store-list">
        <div v-if="ws.filteredStores.length === 0" class="empty-hint">
          <template v-if="ws.search || ws.filterPlatform">
            没有匹配的店铺
            <br />
            <button class="link" @click="clearFilters">清除全部筛选条件</button>
          </template>
          <template v-else>
            没有店铺<br /><button class="link" @click="openCreateDialog()">新建第一个</button>
          </template>
        </div>
        <div v-for="grp in ws.groupedStores" :key="grp.group" class="store-group">
          <div class="group-title">{{ grp.group }}</div>
          <div
            v-for="s in grp.items"
            :key="s.id"
            :class="[
              'store-card',
              {
                active: ws.selectedStoreId === s.id,
                displayed: ws.displayedStoreId === s.id,
                dragging: storeDrag.draggingId === s.id,
                'drag-over-before': storeDrag.overId === s.id && storeDrag.position === 'before',
                'drag-over-after': storeDrag.overId === s.id && storeDrag.position === 'after'
              }
            ]"
            draggable="true"
            data-test="store-card"
            @click="ws.selectStore(s.id)"
            @contextmenu.prevent="onStoreContext(s, $event)"
            @dragstart="onStoreDragStart(s, $event)"
            @dragover="onStoreDragOver(s, $event)"
            @dragleave="onStoreDragLeave(s, $event)"
            @drop="onStoreDrop(s, $event)"
            @dragend="onStoreDragEnd"
          >
            <PlatformIcon :name="s.platform" :size="32" />
            <div class="store-meta">
              <div class="store-name">{{ s.name }}</div>
              <div class="store-sub">
                <span class="dot" :style="{ background: statusColor(s.status) }"></span>
                <PlatformIcon :name="s.platform" :size="12" />
                <span>{{ s.platform }}</span>
              </div>
            </div>
            <button
              class="store-action"
              :title="isOpen(s.id) ? '关闭浏览器' : '打开浏览器'"
              draggable="false"
              @dragstart.stop.prevent
              @click.stop="toggleStore(s.id)"
            >{{ isOpen(s.id) ? '⏻' : '▶' }}</button>
          </div>
        </div>
      </div>

      <div class="sidebar-dc">
        <button class="dc-entry-row" data-test="invoice-center-open" title="发票中心：各平台发票/开票入口" @click="openInvoiceCenter()">
          <span class="dc-ico">🧾</span>
          <span class="dc-txt">发票中心</span>
          <span class="row-sub">全部店铺</span>
        </button>
      </div>

      <div class="sidebar-footer">
        <button class="foot-btn" @click="openTrash">🗑 回收站<span v-if="ws.trashStores.length" class="badge">{{ ws.trashStores.length }}</span></button>
        <button class="foot-btn" @click="onCapture" :disabled="!ws.activeTab" title="截图当前页">📸 截图</button>
        <button class="foot-btn" data-test="settings-open-btn" @click="openSettings()" title="设置（含软件更新）">⚙ 设置</button>
      </div>
      </template>
    </aside>

    <!-- 中栏：浏览器视口 - §8.2 BrowserViewport -->
    <main class="browser-col">
      <template v-if="ws.displayedStoreId">
        <!-- 标签栏（兼作标题栏拖拽区；右栏收起时右上角是原生窗口按钮，需避让） -->
        <div class="tab-strip" :class="{ 'wco-avoid': rightPanelCollapsed }">
          <div class="tabs">
            <div
              v-for="t in ws.displayedTabs"
              :key="t.id"
              :class="['tab', { active: ws.activeTab?.id === t.id, pinned: t.isPinned }]"
              @click="ws.activateTab(t.id)"
            >
              <span v-if="t.loading" class="tab-spinner"></span>
              <span class="tab-title" :title="t.title || t.url">{{ t.title || '新标签页' }}</span>
              <button class="tab-close" @click.stop="ws.closeTab(t.id)">×</button>
            </div>
          </div>
          <button class="tab-add" @click="ws.newTab()" title="新标签页">+</button>
        </div>

        <!-- 地址栏 -->
        <div class="address-bar">
          <!-- 首页（左上角）：回到该店铺所在平台的后台首页，见 homeUrl -->
          <button
            class="nav-btn"
            data-test="nav-home"
            :disabled="!homeUrl"
            :title="homeUrl ? '店铺首页：' + homeUrl : '未配置后台地址'"
            @click="goHome"
          >⌂</button>
          <button class="nav-btn" @click="ws.tabControl('back')" title="后退">‹</button>
          <button class="nav-btn" @click="ws.tabControl('forward')" title="前进">›</button>
          <button class="nav-btn" @click="ws.tabControl('reload')" title="刷新">⟳</button>
          <div class="url-box">
            <input
              ref="urlInput"
              v-model="urlDraft"
              @keydown.enter="submitUrl"
              :key="ws.activeTab?.id + ws.activeTab?.url"
              spellcheck="false"
            />
          </div>
          <button class="nav-btn" @click="bookmarkCurrent" title="收藏本页">☆</button>
          <button class="nav-btn" @click="openWindow" title="独立窗口打开">⧉</button>
        </div>

        <!-- WebContentsView 挂载区域（透明占位，主进程按此 bounds 覆盖真实页面） -->
        <div class="viewport" ref="viewportEl"></div>
      </template>

      <!-- 欢迎页 -->
      <div v-else class="welcome">
        <div class="welcome-inner">
          <div class="welcome-logo">商</div>
          <h1>欢迎使用 ShopPilot</h1>
          <p class="welcome-desc">电商店铺浏览器工作台。选择左侧店铺开始，或创建一个新店铺。</p>
          <div class="quick-platforms">
            <button v-for="p in quickPlatforms" :key="p.name" class="qp" @click="quickCreate(p)">
              <PlatformIcon :name="p.name" :size="16" />{{ p.name }}
            </button>
          </div>
        </div>
      </div>
    </main>

    <!-- 右栏：面板 - §8.2 概览/书签/下载（可收起为窄轨：图标=面板，展开即回到该面板） -->
    <aside class="right-panel" :class="{ collapsed: rightPanelCollapsed }" v-if="ws.displayedStoreId" data-test="right-panel">
      <div class="panel-rail" v-if="rightPanelCollapsed">
        <button class="rail-btn" data-test="panel-expand" title="展开右侧栏（Ctrl+Shift+B）" @click="expandPanel()">‹</button>
        <button
          v-for="t in panelTabs"
          :key="t.key"
          :class="['rail-btn', { on: ws.rightPanel === t.key }]"
          :title="t.label"
          :data-test="'rail-' + t.key"
          @click="expandPanel(t.key)"
        >
          {{ t.icon }}
          <span v-if="t.key === 'tasks' && confirmationCount > 0" class="rail-badge" data-test="rail-confirm-badge"></span>
        </button>
      </div>

      <template v-else>
      <div class="panel-tabs">
        <button :class="['ptab', { on: ws.rightPanel === 'bookmarks' }]" @click="switchPanel('bookmarks')">收藏</button>
        <button :class="['ptab', { on: ws.rightPanel === 'downloads' }]" @click="switchPanel('downloads')">下载</button>
        <button :class="['ptab', { on: ws.rightPanel === 'env' }]" @click="switchPanel('env')">环境</button>
        <button :class="['ptab', { on: ws.rightPanel === 'tasks' }]" @click="switchPanel('tasks')">任务</button>
        <button class="panel-collapse" data-test="panel-collapse" title="收起右侧栏（Ctrl+Shift+B）" @click="collapsePanel()">›</button>
      </div>

      <!-- 人工确认门禁：必须在任何面板都能看到（曾在"任务"面板分支内，用户切到别的面板时任务干等，看起来像卡死） -->
      <div v-for="c in ws.confirmations" :key="c.runId" class="confirm-bar" data-test="task-confirm">
        <div class="cf-txt">
          ⚠ 需要人工确认
          <div class="row-sub">{{ c.message }}（步骤 {{ c.stepIndex + 1 }}）</div>
        </div>
        <div class="cf-btns">
          <button class="mini-btn primary" data-test="confirm-allow" @click="confirmRun(c.runId, true)">允许</button>
          <button class="mini-btn" data-test="confirm-deny" @click="confirmRun(c.runId, false)">拒绝</button>
        </div>
      </div>

      <div class="panel-body" v-if="ws.rightPanel === 'bookmarks'">
        <!-- 平台入口（§16 平台适配层）：只读展示，不入库；深链随平台改版可能变化 -->
        <div class="env-sec" v-if="entryRoutes.length" data-test="entry-routes">
          <div class="env-h"><PlatformIcon :name="displayedPlatformName" :size="14" /><span style="margin-left:6px">{{ displayedPlatformName }} · 平台入口</span></div>
          <div v-for="r in entryRoutes" :key="r.id" class="row-item" data-test="entry-route" @click="ws.navigate(r.url)">
            <div class="row-main">{{ r.title }}</div>
            <div class="row-sub">{{ shortUrl(r.url) }}</div>
          </div>
          <div class="env-note">平台入口由内置适配器提供，页面改版可能调整地址；失效可直接在下方自建收藏。</div>
        </div>

        <div v-if="ws.bookmarks.length === 0" class="empty-hint">暂无收藏</div>
        <div v-for="b in ws.bookmarks" :key="b.id" class="row-item" @click="ws.navigate(b.url)">
          <div class="row-main">{{ b.title }}</div>
          <div class="row-sub">{{ shortUrl(b.url) }}</div>
          <button class="row-del" @click.stop="delBookmark(b.id)">×</button>
        </div>
      </div>

      <div class="panel-body" v-else-if="ws.rightPanel === 'downloads'">
        <div v-if="ws.downloads.length === 0" class="empty-hint">暂无下载</div>
        <div v-for="d in ws.downloads" :key="d.id" class="row-item">
          <div class="row-main" :title="d.fileName">{{ d.fileName }}</div>
          <div class="row-sub">
            <span :class="['dl-state', d.state]">{{ dlStateText(d.state) }}</span>
            <span v-if="d.sizeBytes"> · {{ fmtSize(d.sizeBytes) }}</span>
          </div>
          <button class="row-del" @click.stop="showInFolder(d.id)" title="打开所在文件夹">📁</button>
        </div>
      </div>

      <!-- 环境面板：代理绑定 / 代理管理 / 指纹验证 - §8.1 / §13 -->
      <div class="panel-body env-body" v-else-if="ws.rightPanel === 'env'">
        <div class="env-sec">
          <div class="env-h">网络出口</div>
          <div class="bind-row">
            <select v-model="proxyBindId" @change="applyBind">
              <option value="">直连（不使用代理）</option>
              <option v-for="p in proxies" :key="p.id" :value="p.id">{{ p.label || p.host + ':' + p.port }}</option>
            </select>
          </div>
          <div class="env-note" v-if="envBindingNote">{{ envBindingNote }}</div>
          <div class="env-note ok" v-if="lastProxyAuth">✔ 已注入代理凭据 {{ lastProxyAuth.username }}（{{ new Date(lastProxyAuth.at).toLocaleTimeString() }}）</div>
        </div>

        <div class="env-sec">
          <div class="env-h">代理列表</div>
          <div v-if="proxies.length === 0" class="empty-hint">暂无代理，可在下方添加</div>
          <div v-for="p in proxies" :key="p.id" class="proxy-item">
            <span class="p-dot" :style="{ background: p.status === 'ok' ? '#10B981' : p.status === 'error' ? '#EF4444' : '#6B7280' }" :title="'状态: ' + p.status"></span>
            <div class="p-info">
              <div class="row-main">{{ p.label || p.host }}<span v-if="p.hasCredential" title="含凭据"> 🔑</span></div>
              <div class="row-sub">{{ p.type }}://{{ p.host }}:{{ p.port }} · {{ p.lastLatencyMs != null ? p.lastLatencyMs + ' ms' : '未检测' }}</div>
            </div>
            <button class="mini-btn" @click="testProxy(p)" :disabled="testingIds.includes(p.id)">{{ testingIds.includes(p.id) ? '…' : '检测' }}</button>
            <button class="row-del" @click="removeProxy(p.id)" title="删除">×</button>
          </div>
          <div class="proxy-add">
            <input v-model="np.label" placeholder="名称（可选）" />
            <div class="add-line">
              <select v-model="np.type"><option value="http">http</option><option value="https">https</option><option value="socks5">socks5</option></select>
              <input v-model="np.host" placeholder="主机" class="f-host" />
              <input v-model.number="np.port" type="number" placeholder="端口" class="f-port" />
            </div>
            <div class="add-line">
              <input v-model="np.user" placeholder="用户名（可选）" autocomplete="off" />
              <input v-model="np.pass" type="password" placeholder="密码（可选，本机加密存储）" autocomplete="new-password" />
            </div>
            <button class="mini-btn primary" @click="addProxy" :disabled="!np.host || !np.port">保存代理</button>
          </div>
        </div>

        <div class="env-sec">
          <div class="env-h">环境指纹
            <button class="mini-btn" style="margin-left:auto" @click="verifyEnv" :disabled="verifying">{{ verifying ? '验证中…' : '打开该店铺页面后验证' }}</button>
          </div>
          <div v-if="verifyItems.length === 0" class="env-note">未验证。字段实际值需在店铺浏览器打开后采集，无法验证的字段如实标记"未验证"。</div>
          <div v-for="it in verifyItems" :key="it.field" class="verify-item">
            <span>{{ it.state === 'verified' ? '✅' : '❓' }}</span>
            <div class="v-info">
              <div class="row-main">{{ it.field }}</div>
              <div class="row-sub" :title="'期望 ' + it.expected + ' / 实际 ' + (it.actual ?? '—')">期望 {{ clip(it.expected) }} → 实际 {{ clip(it.actual) }}</div>
            </div>
          </div>
        </div>

        <!-- 会话与 Cookie - §6.3 / §10.2 -->
        <div class="env-sec" data-test="session-sec">
          <div class="env-h">会话与 Cookie</div>
          <div class="cf-btns" style="margin-bottom:6px">
            <button class="mini-btn" data-test="btn-export-session" @click="exportSession" :disabled="secBusy">导出加密会话包…</button>
            <button class="mini-btn" data-test="btn-import-session" @click="importSession" :disabled="secBusy">导入会话包…</button>
          </div>
          <div class="env-note">导出包经口令加密（scrypt + AES-256-GCM）并带有效期；口令由主进程托管窗口采集，不经过界面脚本。</div>
          <input v-model="ckSearch" placeholder="搜索 Cookie（名称/域）" class="ck-search" @input="refreshCookies" />
          <div class="row-sub" style="margin:4px 0">共 {{ cookiesTotal }} 条<span v-if="ckSearch">（筛选后 {{ cookies.length }}）</span></div>
          <div v-for="c in cookies.slice(0, 40)" :key="c.domain + c.path + c.name" class="proxy-item ck-item">
            <div class="p-info">
              <div class="row-main" :title="c.valuePreview">{{ c.name }}<span v-if="c.httpOnly" class="ck-flag">HttpOnly</span><span v-if="c.secure" class="ck-flag">Secure</span></div>
              <div class="row-sub">{{ c.domain }}{{ c.path }} · {{ c.session ? '会话级' : c.expires }} · {{ c.valuePreview }}</div>
            </div>
            <button class="row-del" @click="delCookie(c)" title="删除该 Cookie">×</button>
          </div>
          <button v-if="cookiesTotal > 0" class="mini-btn danger-btn" @click="clearCookies">清空该店铺全部 Cookie</button>
        </div>

        <!-- 应用锁 - §6.5 -->
        <div class="env-sec" data-test="lock-sec">
          <div class="env-h">应用锁</div>
          <template v-if="!ws.securityEnabled">
            <div class="env-note">未设置主密码。设置后可随时锁定应用；锁定会隐藏浏览器视图并拒绝一切业务操作，解锁需主密码。</div>
            <input v-model="pw1" type="password" placeholder="新主密码（≥8 位）" autocomplete="new-password" />
            <input v-model="pw2" type="password" placeholder="再次输入" autocomplete="new-password" style="margin-top:6px" />
            <button class="mini-btn primary" data-test="btn-set-pw" :disabled="pw1.length < 8 || pw1 !== pw2" @click="setMasterPw">设置主密码</button>
          </template>
          <template v-else>
            <div class="cf-btns" style="margin-bottom:6px">
              <button class="mini-btn primary" data-test="btn-lock-now" @click="lockNow">🔒 立即锁定</button>
              <button class="mini-btn" @click="showChangePw = !showChangePw">{{ showChangePw ? '收起' : '更换密码' }}</button>
              <button class="mini-btn danger-btn" @click="removePw">移除主密码</button>
            </div>
            <div class="bind-row">
              <span class="row-sub" style="margin-right:8px">空闲自动锁定</span>
              <select v-model.number="idleMinSel" data-test="sel-idle" @change="applyIdle">
                <option :value="0">关闭</option>
                <option :value="5">5 分钟</option>
                <option :value="15">15 分钟</option>
                <option :value="30">30 分钟</option>
                <option :value="60">60 分钟</option>
              </select>
            </div>
            <template v-if="showChangePw">
              <input v-model="oldPw" type="password" placeholder="旧主密码" autocomplete="off" />
              <input v-model="pw1" type="password" placeholder="新主密码（≥8 位）" autocomplete="new-password" style="margin-top:6px" />
              <input v-model="pw2" type="password" placeholder="再次输入" autocomplete="new-password" style="margin-top:6px" />
              <button class="mini-btn primary" style="margin-top:6px" :disabled="!oldPw || pw1.length < 8 || pw1 !== pw2" @click="setMasterPw">更新</button>
            </template>
          </template>
          <div v-if="secMsg" class="env-note" :class="{ ok: secMsgOk }">{{ secMsg }}</div>
        </div>

        <!-- 备份与诊断 - §10.2 / §22 / §28 -->
        <div class="env-sec" data-test="diag-sec">
          <div class="env-h">备份与诊断</div>
          <div class="cf-btns" style="flex-wrap:wrap">
            <button class="mini-btn" data-test="btn-backup" :disabled="busyBackup" @click="doBackup">{{ busyBackup ? '备份中…' : '立即备份数据库' }}</button>
            <button class="mini-btn" data-test="btn-diag" :disabled="busyDiag" @click="doDiagnostics">导出诊断包</button>
            <button class="mini-btn" @click="doAuditExport">导出审计日志</button>
          </div>
          <div v-if="backups.length" class="row-sub" style="margin-top:6px">最近备份：{{ backups[0].createdAt ? new Date(backups[0].createdAt).toLocaleString() : '—' }}（{{ (backups[0].sizeBytes / 1024).toFixed(0) }} KB）
            <button class="mini-btn" style="margin-left:6px" @click="doRestore(backups[0].id)">恢复到此备份</button>
          </div>
          <div class="env-note">诊断包只含版本、系统、迁移版本、代理体检与脱敏日志，绝不含会话 Cookie、密码或订单原文（§22）。</div>
        </div>
      </div>

      <!-- 任务面板 - §4.4 / §6.6（二级页签：达人邀约 / 待开发占位）
           二级页签刻意不用 .panel-tabs：那一行是标题栏拖拽区（还给 WCO 留了 140px），
           内容区里的页签不该抢拖拽、也不该留白 -->
      <div class="panel-body env-body" v-else>
        <div class="sub-tabs" data-test="task-subtabs">
          <button
            v-for="st in TASK_SUB_TABS" :key="st.key"
            :class="['stab', { on: taskSubTab === st.key }]"
            :data-test="'task-tab-' + st.key"
            @click="taskSubTab = st.key"
          >{{ st.label }}<span v-if="st.pending" class="stab-dot" title="功能开发中"></span></button>
        </div>

        <!-- 任务列表：本店铺的通用任务（读取型步骤 + 人工确认门禁）；可按需新建并手动运行 -->
        <div class="sub-pane" v-show="taskSubTab === 'tasks'" data-test="task-list-panel">
          <div class="env-sec tc-headsec">
            <div class="env-h" style="margin:0">任务列表
              <span class="row-sub" v-if="ws.displayedStoreId"> · {{ storeName(ws.displayedStoreId) }}</span>
              <span class="row-sub" v-else> · 请先打开店铺</span>
            </div>
            <button class="mini-btn primary" data-test="task-new" :disabled="!ws.stores.length" @click="openTaskDialog">+ 新建任务</button>
          </div>

          <div v-if="!ws.displayedStoreId" class="env-note">
            任务要绑定店铺执行：<b>先打开一个店铺</b>，列表只显示该店铺的任务（引擎侧仍存全量，界面按店铺隔离）。
          </div>

          <div v-if="ws.displayedStoreId && storeTasks.length === 0" class="empty-hint" data-test="task-empty" style="padding:14px 8px">
            当前店铺暂无任务。点右上角「+ 新建任务」创建——任务只能由<b>已实测跑通的流程</b>创建
            （当前支持「达人邀约」，参数取「达人邀约」页签里的配置）。<br>
            达人邀约的运行也会出现在这里；想看邀约业务明细（发给谁/额度/留档截图）请去「达人邀约」页签的「邀约记录」。
          </div>

          <div v-for="t in storeTasks" :key="t.id" class="env-sec task-card" :class="{ on: detailTaskId === t.id }" data-test="task-card">
            <div class="tc-head" @click="toggleTaskDetail(t)">
              <div class="p-info">
                <div class="row-main">{{ t.name }}</div>
                <div class="row-sub">
                  {{ t.steps.length }} 步 · {{ storeName(t.storeScope) }}<span v-if="t.schedule"> · 每 {{ Math.round(t.schedule.everyMs / 60000) }} 分钟</span><span v-if="liveStatus(t)"> · {{ statusLabel(liveStatus(t)) }}</span>
                </div>
              </div>
              <button
                class="mini-btn primary"
                data-test="task-run"
                :disabled="isTaskActive(t)"
                :title="isTaskActive(t) ? '当前运行未结束，不能重复启动' : '立即运行'"
                @click.stop="runTask(t)"
              >▶</button>
              <button class="row-del" title="删除任务" @click.stop="delTask(t.id)">×</button>
            </div>

            <template v-if="detailTaskId === t.id">
              <div class="step-row" v-for="(s, i) in t.steps" :key="i">
                <span class="s-ico">{{ stepIcon(t, i) }}</span>
                <div class="p-info">
                  <div class="row-main">{{ i + 1 }}. {{ s.type }}<span class="row-sub"> · {{ s.timeoutMs / 1000 }}s<template v-if="s.retryLimit"> · 重试{{ s.retryLimit }}</template></span></div>
                  <div class="row-sub">{{ stepInputBrief(s) }}<template v-if="stepResultBrief(t, i)"> ⇒ {{ stepResultBrief(t, i) }}</template></div>
                </div>
              </div>

              <div class="tc-btns" v-if="detailRunId(t)">
                <button class="mini-btn" v-if="liveStatus(t) === 'running'" @click="runOp(t, 'pause')">暂停</button>
                <button class="mini-btn" v-if="liveStatus(t) === 'paused'" @click="runOp(t, 'resume')">继续</button>
                <button class="mini-btn" v-if="liveStatus(t) === 'failed'" @click="runOp(t, 'retry')" title="跳过已成功步骤；副作用步骤不可恢复">从失败步骤继续</button>
                <button class="mini-btn" v-if="['running','paused','queued','waiting_confirmation'].includes(liveStatus(t))" @click="runOp(t, 'cancel')">取消</button>
                <button class="mini-btn" @click="loadTaskDetail(t)">刷新</button>
              </div>
              <div class="row-sub" v-if="liveMessage(t)" style="padding:2px 0" data-test="task-live-msg">{{ liveMessage(t) }}</div>

              <div class="log-box" v-if="ws.taskLogs[detailRunId(t)]?.length">
                <div class="log-line" v-for="(l, i) in ws.taskLogs[detailRunId(t)]" :key="i">
                  {{ new Date(l.at || Date.now()).toLocaleTimeString() }} [{{ l.phase }}]{{ l.stepType ? ' ' + l.stepType : '' }} {{ l.message || '' }}
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- 达人邀约：按店铺平台匹配平台档案；本版只有抖店，其余平台明确拒绝 -->
        <div class="sub-pane" v-show="taskSubTab === 'invite'" data-test="invite-panel">
          <div class="env-sec" v-if="!inviteProfile">
            <div class="env-h">达人邀约</div>
            <div class="empty-hint" style="padding:14px 8px">
              当前店铺的平台<b>暂不支持</b>达人邀约
            </div>
            <div class="env-note">
              本版已实现的平台：<b>{{ INVITE_SUPPORTED_PLATFORMS.join('、') }}</b>。其余平台未实测，不做猜测式实现——后续按平台逐个补齐（每加一家只需新增一份平台档案）。
              <template v-if="!ws.displayedStoreId"><br>请先打开一个店铺。</template>
            </div>
          </div>

          <template v-else>
          <div class="env-sec">
            <div class="env-h">达人邀约 · {{ inviteProfile.platform }}
              <button class="mini-btn" style="margin-left:auto" data-test="invite-open-page" @click="openInvitePage">打开达人广场</button>
            </div>

            <!-- batch-list（抖店 / 快手小店）：广场筛选 → 勾满一批 → 批量邀约 → 填话术 → 发送 -->
            <template v-if="inviteProfile.flow === 'batch-list'">
            <div class="inv-card">
              <div class="inv-card-h"><span class="inv-step">1</span><span class="inv-card-t">选人范围</span><span class="row-sub">对应广场筛选项 · 每轮都会重新应用</span></div>

              <div class="inv-grid2" :class="{ 'inv-grid3': inviteProfile.categoryDepth === 3 }">
                <label class="inv-row inv-col">{{ inviteProfile.categoryLabelText || '主推类目' }}
                  <select v-model="invite.category" data-test="invite-category">
                    <option value="">不筛选（全部）</option>
                    <option v-for="c in categoryOptions" :key="c" :value="c">{{ c }}</option>
                  </select>
                </label>
                <label class="inv-row inv-col">二级类目
                  <select v-model="invite.subcategory" data-test="invite-subcategory" :disabled="!invite.category">
                    <option value="">不限</option>
                    <option v-for="s in subCategoryOptions" :key="s" :value="s">{{ s }}</option>
                  </select>
                </label>
                <label v-if="inviteProfile.categoryDepth === 3" class="inv-row inv-col">三级类目
                  <select v-model="invite.category3" data-test="invite-category3" :disabled="!invite.subcategory || !thirdCategoryOptions.length">
                    <option value="">不限</option>
                    <option v-for="s in thirdCategoryOptions" :key="s" :value="s">{{ s }}</option>
                  </select>
                </label>
              </div>
              <div class="env-note" style="margin-top:4px">
                <template v-if="inviteProfile.categoryDepth === 3">
                  可选到「一级/二级/三级」（如 {{ invite.category || '个护家清' }}/{{ invite.subcategory || subCategoryOptions[0] || '家清纸品' }}/{{ invite.category3 || thirdCategoryOptions[0] || '待读取' }}）。三级名称由打开达人广场时的平台筛选接口实时读取，不写死、不猜测。
                </template>
                <template v-else>
                  选二级后按「一级/二级」精确筛选（如 {{ invite.category || '个护家清' }}/{{ invite.subcategory || subCategoryOptions[0] || '家清纸品' }}）；二级名以平台级联实测为准，个别过长名称平台侧有截断，执行时按包含匹配。
                </template>
              </div>

              <!-- 额外筛选行（快手：内容标签 / 合作信息…）。与类目是不同维度，可同时生效 -->
              <div v-for="row in (inviteProfile.extraFilterRows || [])" :key="row.label" class="inv-row inv-block">
                {{ row.label }}
                <span class="inv-chips">
                  <label
                    v-for="opt in row.options" :key="opt"
                    class="inv-chip" :class="{ on: (invite.extraFilters[row.label] || []).includes(opt) }"
                  >
                    <input
                      type="checkbox" :value="opt"
                      :checked="(invite.extraFilters[row.label] || []).includes(opt)"
                      :data-test="'invite-extra-' + row.label + '-' + opt"
                      @change="toggleExtraFilter(row.label, opt)"
                    />{{ opt }}
                  </label>
                </span>
              </div>

              <!-- 达人等级：快手没有这一维（等级是达人自身属性）→ 档案 levels 为空则不显示 -->
              <div v-if="inviteProfile.levels.length" class="inv-row inv-block">达人等级
                <span class="inv-chips">
                  <label
                    v-for="lv in inviteProfile.levels" :key="lv"
                    class="inv-chip" :class="{ on: invite.levels.includes(lv) }"
                  >
                    <input type="checkbox" :value="lv" v-model="invite.levels" :data-test="'invite-level-' + lv" />{{ lv }}
                  </label>
                </span>
              </div>
              <div v-if="inviteProfile.levels.length" class="env-note">
                额度按「店铺类型 × 达人等级」下发：实测本店只有 <b>{{ inviteProfile.levelsWithQuotaHint.join(' / ') }}</b> 有额度，其余为 0（邀约按钮会变禁用态）。额度随经营情况变化，请自行确认。
              </div>

              <label class="inv-row"><span class="inv-label">本批数量</span>
                <input type="number" :min="inviteProfile.minSelect || 1" :max="inviteProfile.maxBatch" v-model.number="invite.count" class="inv-num" data-test="invite-count" />
                <span class="row-sub">
                  上限 {{ inviteProfile.maxBatch }} 位（平台限制）
                  <template v-if="inviteProfile.minSelect && inviteProfile.minSelect > 1">・平台要求至少 {{ inviteProfile.minSelect }} 位</template>
                </span>
              </label>
              <div v-if="inviteProfile.minSelect && invite.count < inviteProfile.minSelect" class="env-note">
                平台实测<b>至少勾选 {{ inviteProfile.minSelect }} 位</b>才能批量邀约（只勾 1 位点按钮没有反应）——执行时会自动按 {{ inviteProfile.minSelect }} 位勾选。
              </div>
            </div>

            <div class="inv-card">
              <div class="inv-card-h"><span class="inv-step">2</span><span class="inv-card-t">邀约内容</span></div>

              <!-- 抽屉里的必填联系方式（实测快手要求三项必填；抖店没有这些输入框 → 不显示） -->
              <template v-if="inviteProfile.contactSelectors">
                <div class="env-note" style="margin-top:0">
                  平台抽屉里这<b>三项必填</b>（联系人 / 手机号 / 微信号）。平台会记住上次填的，这里填了就以这里为准。
                </div>
                <div class="inv-grid2">
                  <label class="inv-row inv-col">联系人
                    <input type="text" v-model="invite.batchContact" maxlength="30" data-test="invite-batch-contact" placeholder="如 刘涛" />
                  </label>
                  <label class="inv-row inv-col">手机号
                    <input type="text" v-model="invite.batchPhone" maxlength="20" data-test="invite-batch-phone" placeholder="11 位手机号" />
                  </label>
                  <label class="inv-row inv-col">微信号
                    <input type="text" v-model="invite.batchWechat" maxlength="40" data-test="invite-batch-wechat" placeholder="如 amike688" />
                  </label>
                </div>
              </template>

              <div class="inv-row inv-block">话术来源
                <span class="inv-chips">
                  <label class="inv-chip" :class="{ on: invite.scriptMode === 'manual' }">
                    <input type="radio" value="manual" v-model="invite.scriptMode" data-test="invite-script-mode-manual" />手填
                  </label>
                  <label class="inv-chip" :class="{ on: invite.scriptMode === 'ai' }">
                    <input type="radio" value="ai" v-model="invite.scriptMode" data-test="invite-script-mode-ai" />AI 生成
                  </label>
                </span>
              </div>
              <label class="inv-row inv-block">邀约话术
                <textarea v-model="invite.script" :readonly="invite.scriptMode === 'ai'" :maxlength="inviteProfile.scriptMaxLen" rows="3" data-test="invite-script"
                  :placeholder="invite.scriptMode === 'ai'
                    ? '不用填：执行到邀约抽屉后，AI 读取平台推荐商品现场生成并写入这个框'
                    : '您好，我们是……想邀请您合作带货：给专属高佣与免费寄样，提供现成素材，发货售后我们全包。'"></textarea>
                <span class="row-sub" v-if="invite.scriptMode === 'manual'">{{ invite.script.length }}/{{ inviteProfile.scriptMaxLen }}</span>
                <span class="row-sub" v-else>AI 生成 · 不超过 {{ inviteProfile.scriptMaxLen }} 字</span>
              </label>
              <div class="env-note" v-if="invite.scriptMode === 'ai' && !aiReady">
                <b>AI 未配置</b>：请到「设置 → AI 配置」填写接口地址、模型名与 API Key（可先点「测试连接」验证）。
              </div>
              <div class="env-note" v-else-if="invite.scriptMode === 'ai'">
                AI 会在打开邀约抽屉后读取该抽屉里的商品信息生成话术；<b>生成的原文会落库留档</b>。
              </div>

              <!-- 邀约商品：快手**必选商品才能发送**（实测点发送会提示「请选择商品」） -->
              <label v-if="inviteProfile.goodsModal" class="inv-row"><span class="inv-label">邀约商品</span>
                <input type="number" min="1" :max="inviteProfile.maxProducts" v-model.number="invite.batchProductCount" class="inv-num" data-test="invite-batch-products" />
                <span class="row-sub">从平台商品里选前 {{ invite.batchProductCount }} 个（平台要求必选，上限 {{ inviteProfile.maxProducts }}）</span>
              </label>

              <div class="inv-row inv-block">{{ inviteProfile.benefitsLabelText || '专属权益' }}（可多选）
                <span class="inv-chips">
                  <label
                    v-for="b in inviteProfile.benefits" :key="b"
                    class="inv-chip" :class="{ on: invite.benefits.includes(b) }"
                  >
                    <input type="checkbox" :value="b" v-model="invite.benefits" :data-test="'invite-benefit-' + b" />{{ b }}
                  </label>
                </span>
              </div>
            </div>

            <div class="inv-card inv-run-bar">
              <div class="inv-card-h"><span class="inv-step">3</span><span class="inv-card-t">运行</span><span class="row-sub" v-if="inviteRun">进行中 · {{ statusLabel(inviteRun.status) }}</span></div>
              <div class="cf-btns">
                <button v-if="!inviteRun" class="mini-btn primary" data-test="invite-start" :disabled="!inviteReady" @click="startInvite">开始邀约</button>
                <button v-else class="mini-btn" data-test="invite-stop" @click="stopInvite">停止邀约</button>
                <span v-if="!inviteReady && !inviteRun" class="row-sub">补齐必填项后可开始</span>
              </div>
              <details class="inv-help">
                <summary>执行说明（点开）</summary>
                <div class="env-note" style="margin-top:4px">
                  可邀约的是"未发过消息"的达人（已邀约行平台会禁用复选框，执行时<b>跳过并如实回报</b>）。勾人是<b>一个一个点</b>（不点表头全选），一屏不够就向下滚动加载更多。
                  <template v-if="inviteProfile.minSelect && inviteProfile.minSelect > 1">
                    该平台<b>至少勾 {{ inviteProfile.minSelect }} 位</b>才能批量邀约，所以会按这个下限勾。
                  </template>
                </div>
                <div class="env-note">
                  点「开始邀约」后<b>连续开批</b>：每批勾满 → 批量邀约 → {{ inviteProfile.goodsModal ? '选商品 → ' : '' }}填话术 → 发送；一批发完自动开下一批，
                  <b>直到额度用完</b>或可选达人不足为止，然后自动停止；每批发送前会停下等待人工确认。
                </div>
                <div class="env-note" v-if="inviteProfile.quotaCheck === 'requireQuota'">
                  该平台在抽屉底部明示剩余额度（<b>{{ inviteProfile.quota?.textIncludes }}N…</b>），额度为 0 时会如实停止，不会硬发。
                </div>
              </details>
              <div class="env-note" v-if="!ws.displayedStoreId">请先打开一个店铺（任务要绑定店铺执行）。</div>
            </div>
            </template>

            <!-- assist-form（微信小店）：全自动连续邀约，逐位达人一张独立表单 -->
            <template v-else>
            <!-- 配置摘要：开跑前一眼核对（面板很长，避免滚到底才发现选错） -->
            <div class="inv-summary" data-test="invite-summary">
              <span v-for="s in inviteSummary" :key="s.k" class="inv-sum-item">
                <i>{{ s.k }}</i>{{ s.v }}
              </span>
            </div>
            <details class="inv-help">
              <summary>使用说明（点开）</summary>
              <div class="env-note" style="margin-top:4px">
                微信小店按达人<b>逐个邀约</b>（每位达人一张独立表单，平台不支持批量）。点「开始邀约」后软件自动完成每一轮：
                进广场 → 按上面筛选挑达人 → 进详情页点「<b>邀请带货</b>」→ 代填联系方式与话术、按商品 ID 添加商品 →
                点「发送邀约」→ 在平台确认弹窗上点「确认」。
                <b>一次一位、连续进行，直到「今日剩余邀请机会」用完或列表里没有更多达人为止</b>。
                <b>没有人工二次确认</b>：点「开始邀约」即开始真实发送（单次运行上限 50 位，随时可点「停止邀约」）。{{ inviteProfile.dailyQuotaHint }}。
              </div>
            </details>

            <div class="inv-card">
              <div class="inv-card-h"><span class="inv-step">1</span><span class="inv-card-t">广场筛选</span><span class="row-sub">点「打开达人广场」时应用</span></div>
              <label class="inv-row inv-col">带货者类型
                <select v-model="invite.finderType" data-test="invite-finder-type">
                  <option v-for="t in inviteProfile.finderTypes" :key="t" :value="t">{{ t }}</option>
                </select>
              </label>
              <div class="inv-row inv-block">带货类目
                <span v-if="invite.finderCategories.length" class="inv-picked">
                  已选 {{ invite.finderCategories.length }} 项：<b>{{ invite.finderCategories.join('、') }}</b>
                  <button class="mini-btn" style="margin-left:auto" data-test="invite-cats-clear" @click="invite.finderCategories.splice(0)">清空</button>
                </span>
                <input
                  v-if="inviteCatsExpanded || inviteCatQuery"
                  v-model="inviteCatQuery" type="text" class="inv-cat-search"
                  data-test="invite-cat-search" placeholder="搜索类目，如 母婴 / 生鲜"
                />
                <span class="inv-chips">
                  <label v-for="c in finderCategoryShown" :key="c" class="inv-chip" :class="{ on: invite.finderCategories.includes(c) }">
                    <input type="checkbox" :value="c" v-model="invite.finderCategories" :data-test="'invite-finder-category-' + c" />{{ c }}
                  </label>
                </span>
                <button
                  v-if="!inviteCatQuery && (finderCategoryHidden > 0 || inviteCatsExpanded)"
                  class="mini-btn inv-more" data-test="invite-cats-toggle"
                  @click="inviteCatsExpanded = !inviteCatsExpanded"
                >{{ inviteCatsExpanded ? '收起类目' : `展开全部 ${inviteProfile.finderCategories.length} 项（还有 ${finderCategoryHidden} 项）` }}</button>
                <span v-else-if="inviteCatQuery" class="row-sub">搜索到 {{ finderCategoryShown.length }} 项</span>
              </div>
              <div class="inv-row inv-block">其他筛选
                <span class="inv-chips">
                  <label v-for="f in inviteProfile.finderOtherFilters" :key="f" class="inv-chip" :class="{ on: invite.finderOtherFilters.includes(f) }">
                    <input type="checkbox" :value="f" v-model="invite.finderOtherFilters" :data-test="'invite-finder-other-' + f" />{{ f }}
                  </label>
                </span>
              </div>
            </div>

            <div class="inv-card">
              <div class="inv-card-h"><span class="inv-step">2</span><span class="inv-card-t">联系方式</span></div>
              <label class="inv-row"><span class="inv-label">邀约联系人</span>
                <input type="text" v-model="invite.contact" maxlength="30" data-test="invite-contact" placeholder="商家侧联系人（必填）" />
              </label>
              <label class="inv-row"><span class="inv-label">微信号</span>
                <input type="text" v-model="invite.wechat" maxlength="30" data-test="invite-wechat" placeholder="必填（与手机号都要填）" />
              </label>
              <label class="inv-row"><span class="inv-label">手机号码</span>
                <input type="text" v-model="invite.phone" maxlength="11" data-test="invite-phone" placeholder="必填（11 位手机号）" />
              </label>
              <div class="env-note">平台要求<b>微信号与手机号都填写</b>，缺一个提交会被平台拦下。</div>
            </div>

            <div class="inv-card">
              <div class="inv-card-h"><span class="inv-step">3</span><span class="inv-card-t">邀约内容</span></div>
              <div class="inv-row inv-block">话术来源
                <span class="inv-chips">
                  <label class="inv-chip" :class="{ on: invite.scriptMode === 'manual' }">
                    <input type="radio" value="manual" v-model="invite.scriptMode" data-test="invite-script-mode-manual" />手填
                  </label>
                  <label class="inv-chip" :class="{ on: invite.scriptMode === 'ai' }">
                    <input type="radio" value="ai" v-model="invite.scriptMode" data-test="invite-script-mode-ai" />AI 生成
                  </label>
                </span>
              </div>
              <label class="inv-row inv-block">合作说明（邀约话术）
                <textarea v-model="invite.script" :readonly="invite.scriptMode === 'ai'" :maxlength="inviteProfile.scriptMaxLen" rows="3" data-test="invite-script"
                  :placeholder="invite.scriptMode === 'ai'
                    ? '不用填：执行到邀约页后，AI 读取邀约商品信息现场生成并写入这个框'
                    : '您好，我们是……想邀请您合作带货：给专属高佣与免费寄样，提供现成素材，发货售后我们全包。'"></textarea>
                <span class="row-sub" v-if="invite.scriptMode === 'manual'">{{ invite.script.length }}/{{ inviteProfile.scriptMaxLen }}</span>
                <span class="row-sub" v-else>AI 生成 · 不超过 {{ inviteProfile.scriptMaxLen }} 字</span>
              </label>
              <div class="env-note" v-if="invite.scriptMode === 'ai' && !aiReady">
                <b>AI 未配置</b>：请到「设置 → AI 配置」填写接口地址、模型名与 API Key（可先点「测试连接」验证）。
              </div>
              <div class="env-note" v-else-if="invite.scriptMode === 'ai'">
                AI 会在打开邀约抽屉后读取该抽屉里的商品信息生成话术；<b>生成的原文会落库留档</b>。
              </div>
              <label class="inv-row inv-block">指定邀约商品 ID
                <textarea v-model="invite.productIds" rows="2" data-test="invite-product-ids" placeholder="可填多个商品 ID，用逗号、空格或换行分隔；例如 10000687986563"></textarea>
                <span class="row-sub">按 ID 精确指定邀约商品；留空则自动添加 1 个，页面已有商品则原样不动</span>
              </label>
            </div>

            <!-- 运行条吸底：面板很长（实测 2200+px），按钮不能只放在最底部 -->
            <div class="inv-card inv-run-bar" data-test="invite-run-bar">
              <div class="inv-card-h"><span class="inv-step">4</span><span class="inv-card-t">运行</span><span class="row-sub" v-if="inviteRun">进行中 · {{ statusLabel(inviteRun.status) }}</span></div>
              <div class="cf-btns">
                <button v-if="!inviteRun" class="mini-btn primary" data-test="invite-start" :disabled="!inviteReady" @click="startInvite">开始邀约</button>
                <button v-else class="mini-btn" data-test="invite-stop" @click="stopInvite">停止邀约</button>
                <span v-if="!inviteReady && !inviteRun" class="row-sub">补齐必填项后可开始</span>
              </div>
              <div class="env-note" v-if="!ws.displayedStoreId">请先打开一个店铺（任务要绑定店铺执行）。</div>
            </div>
            </template>
          </div>

          <div class="env-sec">
            <div class="env-h">邀约记录<span class="row-sub" v-if="inviteHistory.length"> · 近 {{ inviteHistory.length }} 次</span></div>
            <div class="env-note">达人邀约是独立功能，邀约运行不出现在「任务列表」；这里保留本店铺的邀约运行明细（步骤结果、门禁日志、截图工件）。</div>
            <div v-if="!inviteHistory.length" class="empty-hint" style="padding:8px 4px">本店铺还没有邀约记录</div>
            <div v-for="t in inviteHistory" :key="t.id" class="task-card" :class="{ on: detailTaskId === t.id }" data-test="invite-history-card">
              <div class="tc-head" @click="toggleTaskDetail(t)">
                <div class="p-info">
                  <div class="row-main">{{ t.name.replace('达人邀约 · ', '') }}</div>
                  <div class="row-sub">
                    {{ runTimeLabel(t) }} · {{ t.steps.length }} 步<template v-if="liveStatus(t)"> · {{ statusLabel(liveStatus(t)) }}</template>
                  </div>
                </div>
                <button class="mini-btn" v-if="['running','paused','queued','waiting_confirmation'].includes(liveStatus(t))" @click.stop="runOp(t, 'cancel')" data-test="invite-history-stop">停止</button>
                <button class="row-del" title="删除记录" @click.stop="delTask(t.id)">×</button>
              </div>
              <template v-if="detailTaskId === t.id">
                <div class="step-row" v-for="(s, i) in t.steps" :key="i">
                  <span class="s-ico">{{ stepIcon(t, i) }}</span>
                  <div class="p-info">
                    <div class="row-main">{{ i + 1 }}. {{ s.type }}<span class="row-sub"> · {{ s.timeoutMs / 1000 }}s</span></div>
                    <div class="row-sub">{{ stepInputBrief(s) }}<template v-if="stepResultBrief(t, i)"> ⇒ {{ stepResultBrief(t, i) }}</template></div>
                    <div class="row-sub" v-if="s.type === 'loop' && loopSkipSummary(t)" data-test="invite-loop-summary">{{ loopSkipSummary(t) }}</div>
                  </div>
                </div>
                <div class="tc-btns" v-if="detailRunId(t)">
                  <button class="mini-btn" v-if="liveStatus(t) === 'failed'" @click="runOp(t, 'retry')" title="跳过已成功步骤，副作用步骤不可恢复">从失败步骤继续</button>
                  <button class="mini-btn" @click="loadTaskDetail(t)">刷新</button>
                </div>
                <div class="row-sub" v-if="liveMessage(t)" style="padding:2px 0">{{ liveMessage(t) }}</div>
                <div class="log-box" v-if="ws.taskLogs[detailRunId(t)]?.length">
                  <div class="log-line" v-for="(l, i) in ws.taskLogs[detailRunId(t)]" :key="i">
                    {{ new Date(l.at || Date.now()).toLocaleTimeString() }} [{{ l.phase }}]{{ l.stepType ? ' ' + l.stepType : '' }} {{ l.message || '' }}
                  </div>
                </div>
              </template>
            </div>
          </div>

          <div class="env-sec">
            <details class="inv-help" data-test="invite-exec-help">
              <summary>执行说明（点开）</summary>
              <template v-if="inviteProfile.flow === 'batch-list'">
                <div class="env-note">
                  一轮动作（<b>独立功能，不进任务列表</b>；运行明细见下方「邀约记录」）：进入达人广场 → 选类目（点类目 chip 后还要点级联里的「不限」叶子，<b>并校验「已筛选」里真的出现该类目</b>，否则不勾人）→ 选等级 → 搜索 → <b>逐个勾</b> {{ invite.count }} 位（不够就向下滚动加载更多）→ 批量邀约带货 → <b>先检测可邀约额度</b>（以抽屉「确认发送」是否可用来判定）→ 填话术（手填或 AI 生成）→ 勾权益 → 点「确认发送」→ <b>校验抽屉已关闭</b>（没关闭=平台没接受，如实失败）→ 截图留档。
                </div>
                <div class="env-note">
                  一批发完<b>自动开下一批</b>，直到额度用完或可选达人不足 {{ invite.count }} 位为止（这两种都算正常收尾，运行显示成功并在步骤结果里写明停止原因）；单次运行最多 20 批（400–800 位的安全阀）。<b>抖店没有二次确认</b>：点「开始邀约」即开始真实发送，发出去不可撤回。
                </div>
                <div class="env-note">
                  邀约进行中面板会出现「停止邀约」，随时可中止运行。频繁自动操作可能触发平台风控验证（如出现验证码请在页面上手动完成后重试）。发送消耗店铺邀约额度。
                </div>
              </template>
              <template v-else>
                <div class="env-note">
                  一轮动作（<b>独立功能，不进任务列表</b>；运行明细见下方「邀约记录」）：进广场应用筛选 → 取一位<b>还没邀约过</b>的达人
                  （列表每次加载都会重新排序，所以按"是否处理过"去重，不会重复邀同一人）→ 进详情页点「邀请带货」→
                  进邀约表单 → <b>先读「今日剩余 N 次」</b>（为 0 则正常收尾）→ 代填联系方式与合作说明 → 按商品 ID 添加商品 →
                  点「发送邀约」→ 在平台「确认发送邀约」弹窗上点「确认」→ <b>校验表单已被平台清空</b>（没清空=没提交成功，如实失败）→ 截图留档。
                </div>
                <div class="env-note">
                  一轮结束自动开下一轮，<b>直到额度用完或列表翻到底都没有新达人</b>（两种都算正常收尾，运行显示成功并写明停止原因）。
                  本页达人都邀约过会自动点「下一页」；某位达人的详情页打不开（平台限流）会<b>退避重试同一位</b>，不会跳过漏人。
                </div>
                <div class="env-note">
                  邀约进行中面板会出现「停止邀约」，随时可中止运行。发送消耗店铺邀约额度、<b>不可撤回</b>；频繁自动操作可能触发平台限流（软件会自动退避等待）。
                </div>
              </template>
            </details>
          </div>
          </template>
        </div>

        <!-- 待开发占位页签：先把信息层级占住（与达人邀约同级、同样按店铺执行），
             确定要做哪一项后直接在这里落内容，页签结构不用再改 -->
        <div class="sub-pane" v-show="taskSubTab === 'todo'" data-test="todo-panel">
          <div class="env-sec">
            <div class="env-h">待开发<span class="row-sub"> · 本页签预留</span></div>
            <div class="empty-hint" style="padding:14px 8px">
              这里预留给下一项任务类功能，<b>尚未开发</b>。
            </div>
            <div class="env-note">
              位置与「达人邀约」同级、同样按店铺独立执行，并沿用同一套约束：走任务引擎白名单步骤、
              发送/提交类动作<b>按平台要求设确认门禁</b>（如抖店按你的要求已取消二次确认）、结果与截图落库留档、失败如实回报。
            </div>
            <div class="env-note">
              想好要做哪一项（例如：批量商品操作、消息/评论批量回复、数据定时采集等）后告诉我，
              我按平台档案的形式接入——界面结构已经留好，不需要再动面板布局。
            </div>
          </div>
        </div>
      </div>
      </template>
    </aside>

    <!-- 发票中心：抓取并展示各平台后台的**待开票信息**（只读采集；开票操作仍在平台页面完成） -->
    <div v-if="invoiceCenterOpen" class="modal-mask" @click.self="invoiceCenterOpen = false">
      <div class="modal modal-wide dc-modal" data-test="invoice-center-modal">
        <div class="dc-head">
          <h2 style="margin:0">发票中心</h2>
          <span class="row-sub">
            待开票信息汇总
            <template v-if="invoice.generatedAt"> · 读取于 {{ new Date(invoice.generatedAt).toLocaleString() }}</template>
            <template v-if="invoiceLoading"> · 读取中…</template>
          </span>
          <button class="mini-btn" data-test="invoice-collect" :disabled="invoiceCollecting" @click="collectInvoiceData()">
            {{ invoiceCollecting ? '采集中…' : '抓取待开票信息' }}
          </button>
          <button class="mini-btn" data-test="invoice-export" :disabled="!invoiceTotal.count" @click="exportInvoice()">导出 CSV</button>
          <button class="mini-btn" data-test="invoice-refresh" :disabled="invoiceLoading" @click="loadInvoiceCenter()">刷新</button>
          <button class="mini-btn" data-test="invoice-center-close" @click="invoiceCenterOpen = false">关闭</button>
        </div>

        <!-- 总览：跨店铺合计（金额按"能解析出的数字"累加，解析不了的不计入并如实标注） -->
        <div class="dc-cards" data-test="invoice-totals">
          <div class="dc-card"><div class="dc-num">{{ invoiceTotal.count }}</div><div class="dc-label">待开票条数</div></div>
          <div class="dc-card"><div class="dc-num">{{ invoiceTotal.amountText }}</div><div class="dc-label">可开金额合计</div></div>
          <div class="dc-card"><div class="dc-num">{{ invoiceTotal.stores }}</div><div class="dc-label">有待办的店铺</div></div>
          <div class="dc-card"><div class="dc-num">{{ invoiceTotal.overdue }}</div><div class="dc-label">含逾期/到期提示</div></div>
        </div>
        <div v-if="invoiceTotal.historical" class="env-note" style="margin-bottom:10px">
          另有 <b>{{ invoiceTotal.historical }} 条</b>属「已提交 / 已通过」的方向（各平台的「处理中 / 处理记录」这类）——
          商家在那边没有待办，因此<b>不计入</b>上方待开票条数与金额合计；记录照常列在各店铺下方并标了「无需操作」。
        </div>
        <div v-if="invoiceTotal.aliasWarning" class="env-note" style="margin-bottom:10px">
          <b>注意</b>：合计金额混有 {{ invoiceTotal.currencyNote }}；不同平台的金额口径（含税/不含税、阈值金额与账单金额）以各自页面为准。
          <template v-if="invoiceTotal.unparsed">另有 {{ invoiceTotal.unparsed }} 条金额无法解析为数字，<b>未计入</b>合计。</template>
        </div>
        <!-- 按开票方向分开的合计（实测同页不同方向数据不同，分开算才不会互相串） -->
        <div v-if="invoiceTotal.dirs.length" class="inv-dirs" data-test="invoice-dir-totals">
          <span class="inv-dir" v-for="d in invoiceTotal.dirs" :key="d.name" :title="d.pending ? '' : '已提交/已通过的方向，商家无需再操作，不计入待开票合计'">
            <i>{{ d.name }}</i>{{ d.count }} 条<template v-if="!d.pending">（无需操作）</template> · {{ d.amountText }}
            <em v-if="d.unparsed">（{{ d.unparsed }} 条金额未解析）</em>
          </span>
        </div>

        <!-- 按营业执照筛选：发票是**按开票主体**开的，不是按平台账号开的。
             同一个执照下常挂好几家店（同公司开了抖店 + 快手 + 微信小店），只看店铺会把一个主体的票拆成几份。 -->
        <div class="inv-lic-bar" data-test="invoice-license-bar">
          <span class="inv-lic-title">营业执照</span>
          <button class="inv-lic-chip" :class="{ on: !activeLicense }" data-test="invoice-license-all" @click="invoiceLicense = ''">
            全部 <i>{{ licenseSummary.storeCount }} 家</i><template v-if="licenseSummary.pendingCount"> · {{ licenseSummary.pendingCount }} 条 · {{ licenseSummary.amountText }}</template>
          </button>
          <button
            v-for="l in licenseSummary.items" :key="l.key"
            class="inv-lic-chip" :class="{ on: activeLicense === l.key, none: l.key === NO_LICENSE_KEY }"
            :data-test="'invoice-license-' + l.key"
            :title="l.key === NO_LICENSE_KEY ? '这些店铺还没填营业执照——点店铺卡片上的主体标签手动补，或点右侧「获取主体营业执照」让软件去平台后台读回来' : (l.no ? '统一社会信用代码：' + l.no : '只填了主体名称，没有统一社会信用代码')"
            @click="invoiceLicense = activeLicense === l.key ? '' : l.key"
          >
            {{ l.label || '未填写营业执照' }} <i>{{ l.storeCount }} 家</i><template v-if="l.pendingCount"> · {{ l.pendingCount }} 条 · {{ l.amountText }}</template>
          </button>
          <button
            class="mini-btn" style="margin-left:auto" data-test="invoice-entity-fetch"
            :disabled="entityCollecting" title="去各平台后台把本店自己的主体（营业执照）读回来；空着的主体自动填上，与已填不一致的只报告、不覆盖"
            @click="collectStoreEntities()"
          >
            {{ entityCollecting ? '获取中…' : '获取主体营业执照' }}
          </button>
        </div>

        <!-- 获取主体的逐店结果：填了谁、谁与已填不一致、哪些平台现在取不了——都照实说 -->
        <div v-if="entityReport.length" class="inv-entity-report" data-test="invoice-entity-report">
          <div class="inv-entity-report-h">
            <b>获取主体营业执照 · 结果</b>
            <button class="mini-btn" data-test="invoice-entity-report-close" @click="entityReport = []">收起</button>
          </div>
          <div v-for="r in entityReport" :key="r.storeId" class="inv-entity-row" :data-test="'invoice-entity-result-' + r.storeId">
            <span class="inv-entity-store">{{ r.storeName }}</span>
            <span class="row-sub">{{ r.platform }}</span>
            <span :class="{ 'inv-entity-bad': r.status === 'conflict' || r.status === 'unsupported', 'inv-entity-ok': r.status === 'fill' || r.status === 'same' }">
              {{ entityReportText(r) }}
            </span>
          </div>
        </div>

        <!-- 工具栏：搜索 + 只看有数据的 + 排序 -->
        <div class="inv-toolbar" data-test="invoice-toolbar">
          <input
            v-model="invoiceQuery" type="text" class="inv-cat-search" data-test="invoice-search"
            placeholder="搜索：店铺 / 单号 / 类型 / 抬头 / 税号…"
          />
          <label class="inv-chip" :class="{ on: invoiceOnlyWithData }">
            <input type="checkbox" v-model="invoiceOnlyWithData" data-test="invoice-only-data" />只看有数据的
          </label>
          <select v-model="invoiceSort" data-test="invoice-sort" title="行内排序">
            <option value="amountDesc">金额从高到低</option>
            <option value="amountAsc">金额从低到高</option>
            <option value="none">按平台顺序</option>
          </select>
        </div>

        <div class="env-note" style="margin-bottom:10px">
          <b>只做读取与展示</b>：软件在你该店铺的隔离浏览器里打开平台的发票页，把<b>待开票清单</b>读回来；
          开发票/上传发票等操作仍由你在平台页面上完成（本应用不代提交）。
          采集走的是各平台<b>实测过</b>的发票页与表头锚点，改版会如实报错而不是显示错数据。
        </div>

        <div v-if="!invoiceRows.length" class="empty-hint">还没有店铺</div>
        <div v-else-if="!visibleInvoiceRows.length" class="empty-hint">
          没有符合当前筛选/搜索条件的记录<template v-if="invoiceOnlyWithData">（已勾选「只看有数据的」）</template>
        </div>
        <div v-for="r in visibleInvoiceRows" :key="r.storeId" class="inv-row-card" data-test="invoice-row">
          <div class="inv-row-head">
            <span class="inv-dot" :style="{ background: r.color }"></span>
            <b>{{ r.storeName }}</b>
            <span class="row-sub">{{ r.platform }}</span>
            <button
              class="inv-lic-tag" :class="{ none: !r.licenseLabel }"
              :data-test="'invoice-store-license-' + r.storeId"
              :title="r.licenseNo ? '统一社会信用代码：' + r.licenseNo + '（点击修改）' : '点这里填营业执照（发票按主体分账）'"
              @click="openLicenseEditor(r)"
            >
              {{ r.licenseLabel || '未填营业执照' }}<em v-if="r.licenseNo"> · {{ r.licenseNo }}</em>
            </button>
            <span v-if="r.capturedAt" class="row-sub">· 采集于 {{ new Date(r.capturedAt).toLocaleString() }}</span>
            <span v-if="r.manual" class="inv-vtag">手动</span>
            <span class="row-sub" style="margin-left:auto">
              {{ r.supported ? `待开票 ${r.count} 条` : '未支持抓取' }}
              <template v-if="r.historyCount"> · 无需操作 {{ r.historyCount }} 条</template>
            </span>
            <button class="mini-btn" data-test="invoice-open-store" @click="openInvoiceFor(r)">
              {{ r.supported ? '打开发票页' : '打开后台' }}
            </button>
          </div>

          <!-- 平台自己说这个店的主体是谁：与上方"你填的营业执照"并排显示，一眼能核对 -->
          <div v-if="r.entity && (r.entity.name || r.entity.no)" class="inv-entity-line" :data-test="'invoice-platform-entity-' + r.storeId">
            平台读到的主体：<b>{{ r.entity.name || '（没读到名称）' }}</b>
            <template v-if="r.entity.no"> · {{ r.entity.no }}</template>
            <template v-if="r.entity.capturedAt"> <span class="row-sub">（读于 {{ new Date(r.entity.capturedAt).toLocaleString() }}）</span></template>
          </div>
          <div v-else-if="!r.entitySupported" class="inv-entity-line off" :data-test="'invoice-entity-unsupported-' + r.storeId">
            该平台暂不能自动获取主体：{{ r.entityUnsupported || '未实测到可读的主体信息页' }}
          </div>

          <!-- 行内补录营业执照：发票中心正是最容易发现"这家还没填主体"的地方，
               在这里就能填，并且名称有下拉可选（同一个执照的多家店填成一致才不会拆成两个主体） -->
          <div v-if="licenseEditingId === r.storeId" class="inv-lic-edit" :data-test="'invoice-license-edit-' + r.storeId">
            <input v-model="licenseDraft.name" list="store-license-names" data-test="invoice-license-name" placeholder="营业执照主体名称（如：上海某某贸易有限公司）" />
            <input v-model="licenseDraft.no" data-test="invoice-license-no" placeholder="统一社会信用代码（选填，18 位；旧税号 15 位）" />
            <button class="mini-btn" data-test="invoice-license-save" :disabled="licenseSaving" @click="saveLicense(r)">{{ licenseSaving ? '保存中…' : '保存' }}</button>
            <button class="mini-btn" data-test="invoice-license-cancel" @click="licenseEditingId = null">取消</button>
            <span v-if="licenseEditError" class="inv-lic-err" data-test="invoice-license-error">{{ licenseEditError }}</span>
          </div>

          <div v-if="!r.supported" class="env-note" style="margin:0">{{ r.unsupportedReason }}</div>
          <template v-else>
            <div v-if="!r.count && !r.historyCount" class="env-note" style="margin:0">
              还没有采集到数据——点上方「抓取待开票信息」开始。
              <template v-if="r.lastFail">
                上次采集失败：<b>{{ r.lastFail.message || r.lastFail.code }}</b><template v-if="r.lastFail.at">（{{ new Date(r.lastFail.at).toLocaleString() }}）</template>
              </template>
              <template v-if="r.loginRequired">
                <button class="mini-btn" data-test="invoice-relogin" style="margin-left:6px" @click="openInvoiceFor(r)">去登录</button>
              </template>
            </div>
            <!-- 按开票方向分组：每个方向一张小表（实测同页不同方向数据不同，混在一起会看不清） -->
            <div v-for="sec in r.sections" :key="sec.metricKey" class="inv-sec" data-test="invoice-section">
              <div class="inv-sec-h">
                <span class="inv-sec-name">{{ sec.name }}</span>
                <span class="row-sub">{{ sec.items.length }} 条</span>
                <span v-if="sec.pending === false" class="inv-vtag" :title="sec.notPendingNote || '商家无需再操作，不计入上方待开票合计'">无需操作</span>
                <span v-if="sec.measuredRows && sec.items.length < sec.measuredRows" class="inv-vtag" :title="`首次实测该方向有 ${sec.measuredRows} 条，本次抓到 ${sec.items.length} 条`">
                  比实测少（实测 {{ sec.measuredRows }}）
                </span>
                <span v-if="sec.capturedAt" class="row-sub" style="margin-left:auto">采集于 {{ new Date(sec.capturedAt).toLocaleString() }}</span>
              </div>
              <div v-if="!sec.items.length" class="env-note" style="margin:0">该方向当前没有记录</div>
              <div v-else class="inv-table-wrap">
                <table class="inv-table" data-test="invoice-table">
                  <thead>
                    <tr>
                      <th v-for="c in invoice.columns" :key="c.key">{{ c.label }}</th>
                      <th v-if="r.hasExtras">其他信息</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(it, i) in sec.items" :key="i">
                      <td v-for="c in invoice.columns" :key="c.key" :class="{ 'inv-cell-strong': c.key === 'amount' }">
                        {{ cleanCell(it.cells[c.key]) || '—' }}
                      </td>
                      <td v-if="r.hasExtras" class="inv-cell-extra" :title="extrasFull(it)">
                        {{ extrasBrief(it) }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div v-if="r.note" class="env-note" style="margin:6px 0 0">{{ r.note }}</div>
          </template>
        </div>
      </div>
    </div>

    <!-- 数据中心：汇总展示所有店铺的数据（只读；数据来自本机快照与运行记录） -->
    <div v-if="dataCenterOpen" class="modal-mask" @click.self="dataCenterOpen = false">
      <div class="modal modal-wide dc-modal" data-test="datacenter-modal">
        <div class="dc-head">
          <h2 style="margin:0">数据中心</h2>
          <span class="row-sub">汇总所有店铺 · {{ dc.generatedAt ? new Date(dc.generatedAt).toLocaleString() : '加载中' }}<template v-if="dcLoading"> · 刷新中…</template></span>
          <button class="mini-btn" data-test="datacenter-refresh" :disabled="dcLoading" @click="loadDataCenter()">刷新</button>
          <button class="mini-btn" data-test="datacenter-close" @click="dataCenterOpen = false">关闭</button>
        </div>

        <div class="dc-cards">
          <div class="dc-card"><div class="dc-num">{{ dc.totals.stores }}</div><div class="dc-label">店铺</div></div>
          <div class="dc-card"><div class="dc-num">{{ dc.totals.online }}</div><div class="dc-label">在线</div></div>
          <div class="dc-card"><div class="dc-num">{{ dc.totals.archived }}</div><div class="dc-label">已归档</div></div>
          <div class="dc-card"><div class="dc-num">{{ dc.totals.trash }}</div><div class="dc-label">回收站</div></div>
          <div class="dc-card"><div class="dc-num">{{ dc.totals.platforms }}</div><div class="dc-label">平台数</div></div>
          <div class="dc-card"><div class="dc-num">{{ dc.totals.snapshots }}</div><div class="dc-label">指标快照</div></div>
          <div class="dc-card"><div class="dc-num">{{ dc.totals.tasks }}</div><div class="dc-label">任务</div></div>
        </div>

        <div class="env-h">按平台</div>
        <div class="dc-chips" v-if="dc.byPlatform.length">
          <span class="dc-chip" v-for="p in dc.byPlatform" :key="p.platform">{{ p.platform }} · {{ p.c }}（在线 {{ p.online || 0 }}）</span>
        </div>
        <div v-else class="empty-hint">还没有店铺</div>

        <div class="env-h">经营指标<span class="row-sub"> · 销量 / 订单 / 销售额 / 退款金额 / 退款订单数（任务从各平台后台页面读取，每店每指标取最新）</span>
          <button class="mini-btn" style="margin-left:auto" data-test="datacenter-collect" :disabled="dcCollecting" @click="collectBusinessData()">采集经营数据</button>
        </div>
        <table class="dc-table" v-if="bizRows.length">
          <thead><tr><th>店铺</th><th>平台</th><th v-for="m in BIZ_METRICS" :key="m.key">{{ m.label }}</th><th>采集时间</th></tr></thead>
          <tbody>
            <tr v-for="r in bizRows" :key="r.storeId">
              <td>{{ r.storeName }}</td>
              <td class="row-sub">{{ r.platform }}</td>
              <td v-for="m in BIZ_METRICS" :key="m.key" :class="{ 'dc-val': r.values[m.key] != null }">
                {{ bizValue(m.key, r.values[m.key]) }}
                <span v-if="r.manual[m.key]" class="dc-manual" title="手动录入（该平台数字不可自动读取）">手动</span>
                <span
                  v-if="bizDelta(m.key, r.values[m.key], r.prevs[m.key])"
                  class="dc-delta"
                  :class="{ up: bizDelta(m.key, r.values[m.key], r.prevs[m.key])!.dir === 'up', down: bizDelta(m.key, r.values[m.key], r.prevs[m.key])!.dir === 'down' }"
                >{{ bizDelta(m.key, r.values[m.key], r.prevs[m.key])!.dir === 'up' ? '▲' : bizDelta(m.key, r.values[m.key], r.prevs[m.key])!.dir === 'down' ? '▼' : '' }}{{ bizDelta(m.key, r.values[m.key], r.prevs[m.key])!.text }}</span>
              </td>
              <td class="row-sub">{{ r.lastAt ? new Date(r.lastAt).toLocaleString() : '—' }}</td>
            </tr>
            <tr class="dc-total" v-if="bizTotals.contributors">
              <td>合计</td>
              <td class="row-sub">已采集 {{ bizTotals.contributors }} 家</td>
              <td v-for="m in BIZ_METRICS" :key="m.key" class="dc-val">
                {{ bizTotals.sums[m.key] != null ? bizValue(m.key, bizTotals.sums[m.key]) : '—' }}
              </td>
              <td class="row-sub">各平台自报口径</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty-hint">还没有店铺</div>
        <div class="env-note" v-if="bizNotes.length">
          <div v-for="(n, i) in bizNotes" :key="i">口径 · {{ n }}</div>
        </div>

        <!-- 手动录入：平台用反抓取字体渲染数字时（实测拼多多），由用户看页面自行录入 -->
        <div class="dc-manual-form">
          <span class="row-sub">手动录入</span>
          <select v-model="manualDraft.storeId" data-test="dc-manual-store">
            <option v-for="s in ws.stores" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <select v-model="manualDraft.metric" data-test="dc-manual-metric">
            <option v-for="m in BIZ_METRICS" :key="m.key" :value="m.key">{{ m.label }}</option>
          </select>
          <input v-model.number="manualDraft.value" type="number" min="0" step="0.01" placeholder="值" class="inv-num" data-test="dc-manual-value" />
          <button class="mini-btn" :disabled="!manualReady" data-test="dc-manual-save" @click="saveManualMetric">录入</button>
        </div>
        <div class="env-note">
          个别平台（实测<b>拼多多</b>）把数字用<b>反抓取字体的私有区码位</b>渲染——页面 DOM 与接口 JSON 里都不是数字字符，自动读取必须持续对抗平台的反自动化措施，本应用<b>不做这种绕过</b>。这类平台请你自己看后台把数字录进来：录入值会标注「<b>手动</b>」来源，并同样计入合计，绝不与自动采集的数字混淆。
        </div>

        <div class="env-note" v-if="!BUSINESS_SUPPORTED_PLATFORMS.length">
          经营指标的页面锚点<b>尚未实测</b>：本应用没有平台官方 API，只能从各平台后台页面读取（走任务的「指标快照」机制）。实测一个平台登记一个——未登记的平台不会拿猜测的选择器去试。已登记：<b>暂无</b>。
        </div>

        <div class="env-h">指标快照<span class="row-sub"> · 任务 readText/readTable 步骤按「指标名」落库；每店每指标取最新一条</span></div>
        <table class="dc-table" v-if="dc.snapshots.length">
          <thead><tr><th>店铺</th><th>指标</th><th>值</th><th>采集时间</th></tr></thead>
          <tbody>
            <tr v-for="(s, i) in dc.snapshots" :key="i">
              <td>{{ s.storeName }}</td>
              <td>{{ s.metric }}</td>
              <td class="dc-val">{{ typeof s.value === 'object' ? JSON.stringify(s.value) : s.value }}</td>
              <td class="row-sub">{{ new Date(s.capturedAt).toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty-hint">还没有指标快照：在任务的 readText / readTable 步骤里填「指标名」，运行后就会汇总到这里</div>

        <div class="env-h">邀约运行<span class="row-sub"> · 达人邀约独立功能的全部运行（含各店铺）</span></div>
        <div class="dc-chips" v-if="dc.invite.byStatus.length">
          <span class="dc-chip" v-for="s in dc.invite.byStatus" :key="s.status">{{ statusLabel(s.status) }} · {{ s.c }}</span>
        </div>
        <div v-else class="empty-hint">还没有邀约运行记录</div>
        <table class="dc-table" v-if="dc.invite.recent.length">
          <thead><tr><th>店铺</th><th>邀约</th><th>状态</th><th>结束时间</th><th>错误</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in dc.invite.recent" :key="i">
              <td>{{ r.storeName || '（已删除店铺）' }}</td>
              <td>{{ String(r.taskName || '').replace('达人邀约 · ', '') }}</td>
              <td :class="{ 'dc-bad': ['failed','cancelled'].includes(r.status) }">{{ statusLabel(r.status) }}</td>
              <td class="row-sub">{{ r.finished_at || r.started_at ? new Date(r.finished_at || r.started_at).toLocaleString() : '-' }}</td>
              <td class="row-sub">{{ r.error_code || '-' }}</td>
            </tr>
          </tbody>
        </table>

        <div class="env-h">任务运行（近 7 天）<span class="row-sub"> · 全部任务（邀约除外也含在内）</span></div>
        <div class="dc-chips" v-if="dc.runs.byStatus.length">
          <span class="dc-chip" v-for="s in dc.runs.byStatus" :key="s.status">{{ statusLabel(s.status) }} · {{ s.c }}</span>
        </div>
        <div v-else class="empty-hint">近 7 天没有任务运行</div>
        <table class="dc-table" v-if="dc.runs.recentIssues.length">
          <thead><tr><th>店铺</th><th>任务</th><th>状态</th><th>错误码</th><th>时间</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in dc.runs.recentIssues" :key="i">
              <td>{{ r.storeName || '（已删除店铺）' }}</td>
              <td>{{ String(r.taskName || '').slice(0, 40) }}</td>
              <td class="dc-bad">{{ statusLabel(r.status) }}</td>
              <td class="row-sub">{{ r.error_code || '-' }}</td>
              <td class="row-sub">{{ r.finished_at ? new Date(r.finished_at).toLocaleString() : '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 新建店铺对话框 -->
    <div v-if="ws.createDialogOpen" class="modal-mask" @click.self="ws.createDialogOpen = false">
      <div class="modal">
        <h2>新建店铺</h2>
        <label>店铺名称<input v-model="form.name" data-test="store-name" placeholder="例如：美国主站" /></label>
        <label>平台
          <div class="platform-pick">
            <PlatformIcon :name="form.platform" :size="18" />
            <select v-model="form.platform" data-test="platform-select" @change="onPlatformChange">
              <option v-for="p in quickPlatforms" :key="p.name" :value="p.name">{{ p.name }}</option>
              <option value="其他">其他（自定义平台）</option>
            </select>
          </div>
        </label>
        <label>后台地址<input v-model="form.adminUrl" placeholder="例如：https://mms.pinduoduo.com" data-test="admin-url" />
          <span class="field-note" v-if="form.adminUrl">已按所选平台填入默认后台地址，可自行修改</span>
        </label>
        <label>标签（逗号分隔）<input v-model="form.tags" placeholder="主账号, 售后组" /></label>
        <label>营业执照主体名称（选填）
          <input v-model="form.licenseName" list="store-license-names" data-test="store-license-name" placeholder="例如：上海某某贸易有限公司" />
          <span class="field-note">发票要按<b>开票主体</b>分账：同一个执照下开的多家店，填同一个主体名称/代码，发票中心就能按营业执照筛选与合计。</span>
        </label>
        <label>统一社会信用代码（选填）
          <input v-model="form.licenseNo" data-test="store-license-no" placeholder="例如：91310000MA1FL1234X（旧税号 15 位）" />
        </label>
        <datalist id="store-license-names">
          <option v-for="l in licenseOptions" :key="l.key" :value="l.label"></option>
        </datalist>
        <label>备注<textarea v-model="form.notes" rows="2"></textarea></label>
        <div class="modal-actions">
          <button class="btn-ghost" @click="ws.createDialogOpen = false">取消</button>
          <button class="btn-primary" @click="submitCreate" :disabled="!form.name.trim() || !form.adminUrl.trim()">创建</button>
        </div>
      </div>
    </div>

    <!-- 回收站抽屉 -->
    <div v-if="ws.trashOpen" class="modal-mask" @click.self="ws.trashOpen = false">
      <div class="modal">
        <h2>回收站</h2>
        <div v-if="ws.trashStores.length === 0" class="empty-hint">回收站是空的</div>
        <div v-for="s in ws.trashStores" :key="s.id" class="trash-row">
          <PlatformIcon :name="s.platform" :size="28" />
          <div class="trash-meta"><div>{{ s.name }}</div><div class="row-sub"><PlatformIcon :name="s.platform" :size="12" /> {{ s.platform }}</div></div>
          <button class="btn-ghost sm" @click="ws.restoreStore(s.id)">恢复</button>
          <button class="btn-danger sm" @click="confirmPurge(s)">彻底删除</button>
        </div>
        <div class="modal-actions">
          <button class="btn-ghost" @click="ws.trashOpen = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- 店铺右键菜单（§4.3 店铺操作 / §6.6 复制配置） -->
    <div
      v-if="ctx.open && ctx.store"
      class="ctx-menu"
      data-test="store-ctx"
      :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <button class="ctx-item" data-test="ctx-toggle" @click="ctxAction('toggle')">
        {{ isOpen(ctx.store.id) ? '关闭浏览器' : '打开浏览器' }}
      </button>
      <button class="ctx-item" data-test="ctx-standalone" :disabled="!ctxStandalone" title="需先打开该店铺并选中标签页" @click="ctxAction('standalone')">
        在独立窗口打开当前标签页
      </button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-test="ctx-rename" @click="ctxAction('rename')">重命名…</button>
      <button class="ctx-item" data-test="ctx-copycfg" :disabled="otherStores.length === 0" title="只复制环境指纹配置，不含会话与代理凭据" @click="ctxAction('copycfg')">
        复制环境配置到其他店铺…
      </button>
      <button class="ctx-item" data-test="ctx-copyid" @click="ctxAction('copyid')">复制店铺 ID</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item danger" data-test="ctx-trash" @click="ctxAction('trash')">移入回收站</button>
    </div>

    <!-- 重命名店铺 -->
    <div v-if="rename.open" class="modal-mask" @click.self="rename.open = false">
      <div class="modal">
        <h2>重命名店铺</h2>
        <input v-model="rename.value" data-test="rename-input" maxlength="60" placeholder="店铺名称" @keydown.enter="doRename" />
        <div class="modal-actions">
          <button class="btn-ghost" @click="rename.open = false">取消</button>
          <button class="btn-primary" data-test="rename-save" :disabled="!rename.value.trim()" @click="doRename">保存</button>
        </div>
      </div>
    </div>

    <!-- 复制环境配置（§6.6：只迁移配置结构，绝不迁移 Cookie 或代理凭据） -->
    <div v-if="copycfg.open" class="modal-mask" @click.self="copycfg.open = false">
      <div class="modal">
        <h2>复制环境配置</h2>
        <div class="env-note">来源「{{ copycfg.sourceName }}」。只复制环境指纹配置（UA / 语言 / 时区 / 屏幕 / WebGL 等），<b>不含 Cookie 会话，也不迁移代理凭据</b>。</div>
        <div v-if="otherStores.length === 0" class="empty-hint">没有其他店铺可复制</div>
        <label v-for="s in otherStores" :key="s.id" class="store-pick">
          <input type="checkbox" :value="s.id" v-model="copycfg.targets" data-test="pick-target" />
          <span>{{ s.name }}</span>
        </label>
        <div class="modal-actions">
          <button class="btn-ghost" @click="copycfg.open = false">取消</button>
          <button class="btn-primary" data-test="copy-apply" :disabled="copycfg.targets.length === 0" @click="doCopyConfig">复制到选中店铺</button>
        </div>
      </div>
    </div>

    <!-- 新建任务对话框：从已实现的流程里挑，或自己编排步骤。
         原先这里刻意只给流程、不给步骤编辑器，理由是"自己拼步骤必然拼出跑不通的半成品"。
         0.4.37 按用户要求开放了自定义编排，但不是把那条理由无视掉，而是把它逐条堵上：
         参数按目录渲染（拼不出 schema 之外的键）、副作用步骤必须显式标记"提交动作"、
         标记了就必须有前置人工确认门禁（缺失直接拒绝创建）。详见 @shared/custom-task。 -->
    <div v-if="taskDialogOpen" class="modal-mask" data-test="task-dialog" @click.self="taskDialogOpen = false">
      <div class="modal modal-wide task-create-modal" :class="{ 'task-create-tall': taskFlow === 'custom' }">
        <h2>新建任务</h2>
        <div class="row-sub" style="margin-bottom:8px">
          任务只能由<b>已实测跑通的流程</b>创建（参数表单 + 内置确认门禁都由流程自己带），
          这样建出来的任务一定是能跑的；<b>自定义任务</b>则用步骤编排器自建（带创建前校验）。
        </div>

        <label>任务类型
          <select v-model="taskFlow" data-test="task-flow">
            <option v-for="f in taskFlowOptions" :key="f.key" :value="f.key">{{ f.label }}<template v-if="!f.ready">（不可用）</template></option>
          </select>
          <span class="row-sub">{{ taskFlowCurrent?.desc }}</span>
        </label>

        <template v-if="taskFlow === 'invite'">
          <!-- 邀约的参数在「达人邀约」页签里配置（同一份配置、同一份步骤构造），这里只做汇总 -->
          <div class="env-note" v-if="!taskFlowCurrent?.ready" data-test="task-flow-blocked">
            <b>暂时建不了</b>：{{ taskFlowCurrent?.needs }}
          </div>
          <template v-else>
            <div class="env-note">
              参数取「<b>达人邀约</b>」页签里的当前配置（改配置请到那边，两处是同一份）。
              要改配置就先去那边调好，再回来建。
            </div>
            <div class="env-sec" style="padding:0">
              <div class="env-h" style="margin:0">将创建
                <span class="row-sub"> · {{ inviteProfile?.platform }} · {{ inviteProfile?.flow === 'batch-list' ? '批量勾选流' : '辅助填单流' }}</span>
              </div>
              <div class="row-sub" style="padding:2px 0" data-test="task-flow-summary">{{ taskFlowSummaryText }}</div>
            </div>

            <label>定时（分钟，留空 = 仅手动）
              <input v-model.number="tf.everyMin" type="number" min="1" max="43200" data-test="task-every" placeholder="例如 60" />
              <span class="row-sub">到点自动运行（店铺窗口没开时保持排队，不会静默拉起）</span>
            </label>
          </template>
        </template>

        <template v-else-if="taskFlow === 'custom'">
          <div class="env-note" v-if="!ws.displayedStoreId" data-test="task-flow-blocked">
            <b>暂时建不了</b>：请先打开一个店铺（任务要绑定店铺执行）
          </div>
          <template v-else>
            <label>任务名称
              <input v-model="customTaskName" type="text" maxlength="80" data-test="custom-name" placeholder="例如 每日巡检本店资质页" />
            </label>

            <CustomTaskEditor v-model:steps="customSteps" :issues="customIssues" />

            <label>定时（分钟，留空 = 仅手动）
              <input v-model.number="tf.everyMin" type="number" min="1" max="43200" data-test="task-every" placeholder="例如 60" />
              <span class="row-sub">到点自动运行（店铺窗口没开时保持排队，不会静默拉起）</span>
            </label>
          </template>
        </template>

        <div class="modal-actions">
          <button class="btn-ghost" data-test="task-cancel" @click="taskDialogOpen = false">取消</button>
          <button
            class="btn-primary"
            data-test="task-submit"
            :disabled="submitDisabled"
            :title="submitDisabledReason"
            @click="submitTask"
          >创建任务</button>
        </div>
      </div>
    </div>

    <!-- 通用二次确认（危险操作；替代 window.confirm 的原生弹窗） -->
    <div v-if="confirmBox.open" class="modal-mask" @click.self="confirmBox.open = false">
      <div class="modal">
        <h2>{{ confirmBox.title }}</h2>
        <div class="env-note">{{ confirmBox.message }}</div>
        <div class="modal-actions">
          <button class="btn-ghost" data-test="confirm-cancel" @click="confirmBox.open = false">取消</button>
          <button class="btn-danger" data-test="confirm-ok" @click="runConfirm">确认</button>
        </div>
      </div>
    </div>

    <!-- 设置：配置（各平台首页地址）/ 达人广场 / AI 配置 / 关于软件（软件信息 + 更新） -->
    <div v-if="settingsOpen" class="modal-mask" data-test="settings-dialog" @click.self="settingsOpen = false">
      <div class="modal modal-wide settings-modal">
        <h2>设置</h2>
        <div class="sub-tabs">
          <button :class="['stab', { on: settingsTab === 'config' }]" data-test="settings-tab-config" @click="openSettingsTab('config')">配置</button>
          <button :class="['stab', { on: settingsTab === 'square' }]" data-test="settings-tab-square" @click="openSettingsTab('square')">达人广场</button>
          <button :class="['stab', { on: settingsTab === 'ai' }]" data-test="settings-tab-ai" @click="openSettingsTab('ai')">AI 配置</button>
          <button :class="['stab', { on: settingsTab === 'about' }]" data-test="settings-tab-about" @click="openSettingsTab('about')">关于软件</button>
        </div>

        <!-- 配置：每个平台的首页地址 -->
        <div v-if="settingsTab === 'config'" class="sub-pane" data-test="settings-config">
          <div class="env-note">为每个平台设置「首页」地址。地址栏左上角的 ⌂ 首页按钮会跳到它；留空表示使用平台默认地址。</div>
          <div v-for="p in quickPlatforms" :key="p.name" class="plat-row" data-test="platform-home-row">
            <span class="plat-name"><PlatformIcon :name="p.name" :size="14" />{{ p.name }}</span>
            <input
              v-model="homeUrlDraft[p.name]"
              :placeholder="p.adminUrl"
              :data-test="'home-url-' + p.name"
              spellcheck="false"
            />
            <button class="mini-btn" :disabled="!homeUrlDraft[p.name]" @click="resetPlatformHome(p.name)">恢复默认</button>
          </div>
          <div class="env-note">只做格式校验（须以 http:// 或 https:// 开头），不联网探测可达性——填错了首页就打不开，请自行确认。</div>
        </div>

        <!-- 达人广场（独立页签）：按平台覆盖内置默认地址 -->
        <div v-else-if="settingsTab === 'square'" class="sub-pane" data-test="settings-square">
          <div class="env-note">达人邀约进入的页面地址。留空 = 用内置默认（已实测的抖店地址）；换成别的地址后，流程会按新地址的末段等待页面就绪。</div>
          <div v-for="p in inviteProfiles" :key="p.platform" class="plat-row" data-test="square-url-row">
            <span class="plat-name"><PlatformIcon :name="p.platform" :size="14" />{{ p.platform }}</span>
            <input
              v-model="squareUrlDraft[p.platform]"
              :placeholder="p.pageUrl"
              :data-test="'square-url-' + p.platform"
              spellcheck="false"
            />
            <button class="mini-btn" :disabled="!squareUrlDraft[p.platform]" @click="resetSquareUrl(p.platform)">恢复默认</button>
          </div>
          <div class="env-note">当前已支持达人邀约的平台：<b>{{ INVITE_SUPPORTED_PLATFORMS.join('、') }}</b>（其余平台未实测，面板会明确拒绝而不是猜测）。</div>
          <div class="env-note">只做格式校验，不联网探测可达性。</div>
        </div>

        <!-- AI 配置（独立页签）：Key 经系统加密存储，不回显 -->
        <div v-else-if="settingsTab === 'ai'" class="sub-pane" data-test="settings-ai">
          <div class="env-note">用于「达人邀约」里按平台推荐商品自动生成邀约话术。走 <b>OpenAI 兼容</b>的 /chat/completions 协议：各家中转站、聚合网关、自建网关都能接。</div>
          <label class="plat-row">服务商
            <select v-model="aiProviderKey" data-test="ai-provider" @change="applyAiPreset(aiProviderKey)">
              <option v-for="p in AI_PROVIDER_PRESETS" :key="p.key" :value="p.key">{{ p.label }}</option>
              <option value="__custom__">自定义（下方手填地址与模型名）</option>
            </select>
          </label>
          <label class="plat-row">接口地址
            <input v-model="aiDraft.endpoint" data-test="ai-endpoint" spellcheck="false"
              :placeholder="DEFAULT_AI_ENDPOINT"
              @input="aiProviderKey = '__custom__'" />
          </label>
          <div class="env-note" v-if="aiResolvedEndpoint" data-test="ai-resolved">
            实际请求：<code>{{ aiResolvedEndpoint }}</code>
            <template v-if="aiModelsUrl"><br>模型列表：<code>{{ aiModelsUrl }}</code></template>
          </div>
          <div class="env-note" v-else>可填<b>基础地址</b>（如 <code>https://api.xxx.com/v1</code>，中转站通常给这个）或<b>完整补全地址</b>（以 <code>/chat/completions</code> 结尾）——基础地址会按 OpenAI 通行约定自动补全为实际请求地址。</div>
          <label class="plat-row">模型名
            <input v-model="aiDraft.model" data-test="ai-model" spellcheck="false" :placeholder="DEFAULT_AI_MODEL" />
          </label>
          <label class="plat-row">超时(ms)
            <input v-model.number="aiDraft.timeoutMs" type="number" :min="AI_TIMEOUT_MIN_MS" :max="AI_TIMEOUT_MAX_MS" data-test="ai-timeout" class="inv-num" />
          </label>
          <label class="plat-row">API Key
            <input v-model="aiKeyDraft" type="password" data-test="ai-key" autocomplete="new-password"
              :placeholder="aiConfig.hasKey ? '已配置（留空则不改动）' : '粘贴你的 API Key'" />
          </label>
          <div class="cf-btns" style="margin-top:8px">
            <button class="mini-btn" data-test="ai-models-btn" :disabled="aiModelsLoading" @click="fetchAiModels">{{ aiModelsLoading ? '获取中…' : '获取可用模型' }}</button>
            <button class="mini-btn primary" data-test="ai-test" :disabled="aiTesting" @click="testAi">{{ aiTesting ? '测试中…' : '测试连接' }}</button>
            <button class="mini-btn danger-btn" v-if="aiConfig.hasKey" data-test="ai-key-clear" @click="clearAiKey">清除 Key</button>
          </div>
          <div class="plat-row" v-if="aiModels.length">
            <span class="plat-name" style="width:auto;flex:0 0 auto">可选模型</span>
            <select data-test="ai-model-pick" :value="aiDraft.model" @change="pickAiModel(($event.target as HTMLSelectElement).value)">
              <option value="">— 选择后填入上方模型名 —</option>
              <option v-for="m in aiModels" :key="m" :value="m">{{ m }}</option>
            </select>
            <span class="row-sub">{{ aiModels.length }} 个</span>
          </div>
          <div class="env-note" :class="{ ok: aiMsgOk }" v-if="aiMsg" data-test="ai-msg">{{ aiMsg }}</div>
          <div class="env-note">
            Key 经系统 safeStorage（Windows DPAPI）加密存储、<b>只在主进程使用，界面永不回显</b>，也不会进诊断包。
            AI 请求由主进程<b>直连出网，不走店铺代理</b>；接口地址须为 https://（仅本机 127.0.0.1/localhost 允许 http://）。
            非敏感项（接口地址 / 模型名 / 超时）随「保存」写入，Key 点「保存」时一并写入（留空表示不改）。
            「获取可用模型」是只读请求 <b>/models</b>（由接口地址推导，见上方"模型列表"），拉不到就如实报错、不编造候选。
            预设只是便捷预填，各家的模型名与可用性以你的账号为准。
          </div>
        </div>

        <!-- 关于软件：软件信息 + 更新 -->
        <div v-else class="sub-pane" data-test="settings-about">
          <div class="about-head">
            <div class="brand-logo about-logo">商</div>
            <div>
              <div class="about-name">ShopPilot</div>
              <div class="row-sub">电商店铺浏览器工作台</div>
            </div>
          </div>
          <div class="about-row"><span>版本</span><b data-test="about-version">v{{ updateStatus.currentVersion || '—' }}</b></div>
          <div class="about-row"><span>构建标签</span><b>INTERNAL_BUILD</b></div>
          <div class="env-note">未做代码签名，按 §21.5 只能标记 INTERNAL_BUILD；自动更新仅做 SHA-512 哈希校验、无签名校验。</div>

          <div class="env-h" style="margin-top:14px">软件更新</div>
          <!-- 更新区块：内部 data-test 与原对话框保持一致，验收脚本只需改"怎么进来" -->
          <div data-test="update-dialog">
            <div class="update-channel-row">
              <label>更新通道</label>
              <select data-test="update-channel" v-model="updateChannel" @change="saveUpdateChannel">
                <option value="stable">稳定版 stable</option>
                <option value="beta">测试版 beta</option>
              </select>
            </div>
            <label class="update-autocheck" title="开启后每次启动延迟自动检查一次更新">
              <input type="checkbox" data-test="update-autocheck" v-model="updateAutoCheck" @change="saveUpdateAutoCheck">启动时自动检查
            </label>
            <div v-if="updateStatus.state === 'checking'" class="update-message" data-test="update-message">正在检查更新…</div>
            <div v-else-if="updateStatus.state === 'available'" class="update-message" data-test="update-message">发现新版本 v{{ updateStatus.version }}</div>
            <div v-else-if="updateStatus.state === 'downloading'" class="update-message" data-test="update-message">正在下载 v{{ updateStatus.version }}（{{ Math.round(updateStatus.percent || 0) }}%）</div>
            <div v-else-if="updateStatus.state === 'downloaded'" class="update-message success-text" data-test="update-message">更新已下载并通过 SHA-512 校验，重启后安装</div>
            <div v-else-if="updateStatus.state === 'not-available'" class="update-message" data-test="update-message">当前已是最新版本</div>
            <div v-else-if="updateStatus.state === 'error'" class="update-message error-text" data-test="update-message">{{ updateStatus.error }}</div>
            <div v-else class="update-message" data-test="update-message">检查 GitHub Releases 上的新版本；下载完成校验哈希后重启安装，安装失败保留旧版本。</div>
            <div v-if="updateStatus.state === 'downloading'" class="update-progress"><span :style="{ width: (updateStatus.percent || 0) + '%' }"></span></div>
            <div class="cf-btns" style="margin-top:8px">
              <button v-if="['idle','not-available','error'].includes(updateStatus.state)" class="mini-btn primary" data-test="update-check-btn" @click="checkUpdate">检查更新</button>
              <button v-if="updateStatus.state === 'available'" class="mini-btn primary" data-test="update-download-btn" @click="downloadUpdate">下载更新</button>
              <button v-if="updateStatus.state === 'downloaded'" class="mini-btn primary" data-test="update-install-btn" @click="installUpdate">重启并安装</button>
            </div>
          </div>
        </div>

        <div class="modal-actions">
          <template v-if="settingsTab !== 'about'">
            <button class="btn-ghost" @click="settingsOpen = false">取消</button>
            <button class="btn-primary" data-test="settings-save" @click="saveSettingsConfig">保存</button>
          </template>
          <button v-else class="btn-ghost" @click="settingsOpen = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- Toast -->
    <div class="toast-host">
      <div v-for="t in ws.toasts" :key="t.id" :class="['toast', t.kind]">{{ t.text }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useWorkspaceStore, type StoreRow } from '../../stores/workspace'
import { moveStoreId, type StoreDropPosition } from '../../stores/store-order'
import PlatformIcon from '../../components/PlatformIcon.vue'
import CustomTaskEditor from '../tasks/CustomTaskEditor.vue'
import {
  hasBlockingIssues, toEngineSteps, validateCustomSteps,
  type CustomStepDraft, type CustomStepIssue
} from '@shared/custom-task'
import { inviteProfileFor, INVITE_PROFILES, INVITE_SUPPORTED_PLATFORMS, isBatchProfile, isAssistProfile } from '@shared/constants/invite'
import type { CategoryNode } from '@shared/constants/invite'
import { buildInviteSteps } from '@shared/invite-steps'
import { invoiceProfileFor } from '@shared/constants/invoice'
import { buildInvoiceCollectSteps } from '@shared/invoice-steps'
import { NO_LICENSE_KEY, groupStoresByLicense, licenseLabelOf } from '@shared/store-license'
import { entityProfileFor } from '@shared/constants/entity'
import { buildEntityCollectSteps } from '@shared/entity-steps'
import { BIZ_METRICS, businessProfileFor, BUSINESS_SUPPORTED_PLATFORMS } from '@shared/constants/business'
import { buildBusinessCollectSteps } from '@shared/business-steps'
import {
  DEFAULT_AI_ENDPOINT, DEFAULT_AI_MODEL, DEFAULT_AI_TIMEOUT_MS,
  AI_TIMEOUT_MIN_MS, AI_TIMEOUT_MAX_MS, INVITE_SQUARE_URLS_SETTING,
  AI_PROVIDER_PRESETS, normalizeAiEndpoint, modelsUrlFromChat
} from '@shared/constants/ai'

const ws = useWorkspaceStore()
const viewportEl = ref<HTMLElement | null>(null)
const urlInput = ref<HTMLElement | null>(null)
const urlDraft = ref('')

const storeDrag = reactive({
  draggingId: '',
  overId: '',
  position: 'before' as StoreDropPosition
})

function storeGroupKey(store: StoreRow): string {
  return store.groupName || '未分组'
}

function resetStoreDrag() {
  storeDrag.draggingId = ''
  storeDrag.overId = ''
  storeDrag.position = 'before'
}

function onStoreDragStart(store: StoreRow, event: DragEvent) {
  const target = event.target as HTMLElement | null
  if (target?.closest('button')) {
    event.preventDefault()
    return
  }

  storeDrag.draggingId = store.id
  storeDrag.overId = ''
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', store.id)
  }
}

function onStoreDragOver(store: StoreRow, event: DragEvent) {
  const draggingId = storeDrag.draggingId || event.dataTransfer?.getData('text/plain') || ''
  const dragged = ws.stores.find(item => item.id === draggingId)
  if (!dragged || dragged.id === store.id || storeGroupKey(dragged) !== storeGroupKey(store)) {
    if (storeDrag.overId === store.id) {
      storeDrag.overId = ''
      storeDrag.position = 'before'
    }
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    return
  }

  event.preventDefault()
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const position: StoreDropPosition = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  if (storeDrag.overId !== store.id || storeDrag.position !== position) {
    storeDrag.overId = store.id
    storeDrag.position = position
  }
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

function onStoreDragLeave(store: StoreRow, event: DragEvent) {
  const current = event.currentTarget as HTMLElement | null
  const related = event.relatedTarget as Node | null
  if (current && related && current.contains(related)) return
  if (storeDrag.overId === store.id) {
    storeDrag.overId = ''
    storeDrag.position = 'before'
  }
}

async function onStoreDrop(targetStore: StoreRow, event: DragEvent) {
  event.preventDefault()
  const draggingId = storeDrag.draggingId || event.dataTransfer?.getData('text/plain') || ''
  const dragged = ws.stores.find(item => item.id === draggingId)
  const position = storeDrag.position
  resetStoreDrag()

  if (!dragged || dragged.id === targetStore.id) return
  if (storeGroupKey(dragged) !== storeGroupKey(targetStore)) {
    ws.toast('只能在同一个分组内调整店铺顺序', 'info')
    return
  }

  const currentIds = ws.stores.map(store => store.id)
  const nextIds = moveStoreId(currentIds, dragged.id, targetStore.id, position)
  if (nextIds === currentIds) return
  await ws.reorderStores(nextIds)
}

function onStoreDragEnd() {
  resetStoreDrag()
}

// ── 平台筛选增强 ──
/** 当前搜索+状态筛选后未过滤平台前的总店铺数 */
const totalFilteredCount = computed(() => {
  return Object.values(ws.platformCounts).reduce((a, b) => a + b, 0)
})

/** 可用平台列表：只在 quickPlatforms 有店铺的平台 + "其他"(自定义平台聚合) */
const availablePlatforms = computed(() => {
  const counts = ws.platformCounts
  // 已知平台：只保留有店铺的
  const known = quickPlatforms
    .filter(p => counts[p.name])
    .map(p => ({ name: p.name, shortName: p.name, platform: p.name, color: p.color, count: counts[p.name] }))
  // "其他": 不在 quickPlatforms 中的自定义平台
  const knownNames = new Set(quickPlatforms.map(p => p.name))
  let otherCount = 0
  for (const plat of Object.keys(counts)) {
    if (!knownNames.has(plat)) otherCount += counts[plat]
  }
  const result = [...known]
  if (otherCount > 0) {
    result.push({ name: '__other__', shortName: '其他', platform: '', color: '#8B5CF6', count: otherCount })
  }
  return result
})

/** 每个平台 chip 的激活态样式（使用平台色替代统一 primary 色） */
function chipStyle(active: boolean, color: string) {
  if (!active) return {}
  return { backgroundColor: color, borderColor: color }
}

let resizeObserver: ResizeObserver | null = null

// 平台目录来自主进程（shared/constants/platforms.ts），国内四家：拼多多/微信小店/快手小店/抖店
interface PlatformDef { name: string; color: string; adminUrl: string; entryRoutes: Array<{ title: string; url: string }> }
const quickPlatforms = (window.shopilot.platforms || []) as PlatformDef[]
const DEFAULT_PLATFORM = quickPlatforms[0]?.name || '拼多多'

// ── 设置：平台首页地址（持久化在 app_settings.platform.homeUrls） ──
/**
 * 平台首页地址覆盖表：{ 平台名: 地址 }。空/缺省表示用平台目录里的默认地址。
 * 用户可在「设置 → 配置」里为每个平台指定首页；按用户选择，**配置值优先级最高**，
 * 即无论店铺自己填了什么后台地址，首页按钮都走这里配的地址。
 */
const platformHomeUrls = ref<Record<string, string>>({})
/** 设置弹窗内"配置"页的草稿（保存前的编辑态，避免直接改到生效值） */
const homeUrlDraft = reactive<Record<string, string>>({})
const settingsOpen = ref(false)
const settingsTab = ref<'config' | 'square' | 'ai' | 'about'>('config')

/** 某平台的实际首页地址：配置值 → 平台目录默认 */
function platformHome(platformName: string): string {
  const configured = (platformHomeUrls.value[platformName] || '').trim()
  if (configured) return configured
  return quickPlatforms.find(p => p.name === platformName)?.adminUrl || ''
}

async function loadPlatformHomeUrls() {
  const res = await window.shopilot.settings.get('platform.homeUrls')
  const v = res.ok ? res.data?.value : null
  platformHomeUrls.value = v && typeof v === 'object' ? v : {}
}

// ---------- 设置：达人广场地址（按平台覆盖内置默认）----------
const inviteProfiles = computed(() => Object.values(INVITE_PROFILES))
const squareUrls = ref<Record<string, string>>({})
const squareUrlDraft = reactive<Record<string, string>>({})
const INVITE_CATEGORY_TREES_SETTING = 'invite.categoryTrees'
const dynamicCategoryTrees = ref<Record<string, CategoryNode[]>>({})

/** 平台实时读取的三级类目优先；未读取成功时退回档案内置的两级数据。 */
function inviteCategoryTreeFor(p: { platform: string; categoryTree?: readonly CategoryNode[] }): readonly CategoryNode[] {
  const dynamic = dynamicCategoryTrees.value[p.platform]
  return Array.isArray(dynamic) && dynamic.length ? dynamic : (p.categoryTree || [])
}

/** 某平台实际使用的达人广场地址：配置值 → 平台档案内置默认 */
function squareUrlFor(platformName: string): string {
  const configured = (squareUrls.value[platformName] || '').trim()
  if (configured) return configured
  return INVITE_PROFILES[platformName]?.pageUrl || ''
}

async function loadSquareUrls() {
  const res = await window.shopilot.settings.get(INVITE_SQUARE_URLS_SETTING)
  const v = res.ok ? res.data?.value : null
  squareUrls.value = v && typeof v === 'object' ? v : {}
}

async function loadInviteCategoryTrees() {
  const res = await window.shopilot.settings.get(INVITE_CATEGORY_TREES_SETTING)
  const v = res.ok ? res.data?.value : null
  dynamicCategoryTrees.value = v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

async function saveInviteCategoryTree(platform: string, tree: CategoryNode[]): Promise<void> {
  if (!Array.isArray(tree) || tree.length === 0) return
  const next = { ...dynamicCategoryTrees.value, [platform]: tree }
  const res = await window.shopilot.settings.set(INVITE_CATEGORY_TREES_SETTING, JSON.parse(JSON.stringify(next)))
  if (!res.ok) {
    ws.toast('三级类目已读取，但保存失败: ' + res.error.message, 'error')
    return
  }
  dynamicCategoryTrees.value = next
}

/** 存覆盖表；只做格式校验（http/https），不联网探测——与平台首页地址同一红线 */
async function saveSquareUrls(): Promise<boolean> {
  const next: Record<string, string> = {}
  for (const p of inviteProfiles.value) {
    const v = (squareUrlDraft[p.platform] || '').trim()
    if (!v) continue
    if (!/^https?:\/\//i.test(v)) {
      ws.toast(`「${p.platform}」的达人广场地址需以 http:// 或 https:// 开头`, 'error')
      return false
    }
    next[p.platform] = v
  }
  const res = await window.shopilot.settings.set(INVITE_SQUARE_URLS_SETTING, next)
  if (!res.ok) { ws.toast('保存达人广场地址失败: ' + res.error.message, 'error'); return false }
  squareUrls.value = next
  return true
}

function resetSquareUrl(platformName: string) { squareUrlDraft[platformName] = '' }

// ---------- 设置：AI 配置（大模型）----------
const aiConfig = ref<{ endpoint: string; resolvedEndpoint?: string; model: string; timeoutMs: number; hasKey: boolean }>({
  endpoint: DEFAULT_AI_ENDPOINT, model: DEFAULT_AI_MODEL, timeoutMs: DEFAULT_AI_TIMEOUT_MS, hasKey: false
})
const aiDraft = reactive({ endpoint: '', model: '', timeoutMs: DEFAULT_AI_TIMEOUT_MS })
const aiKeyDraft = ref('')
const aiMsg = ref('')
const aiMsgOk = ref(false)
const aiTesting = ref(false)
/** 「获取可用模型」拉回来的模型名（只读接口；失败时保持为空并如实报错，不编造候选） */
const aiModels = ref<string[]>([])
const aiModelsLoading = ref(false)
/** 服务商预设（含中转站/自定义）：只是便捷预填，选完仍可任意改地址与模型名 */
const aiProviderKey = ref('__custom__')

/** 规范化后的实际请求地址（与主进程同一套规则，界面据此让用户看清"到底请求哪"） */
const aiResolvedEndpoint = computed(() => normalizeAiEndpoint(aiDraft.endpoint))
/** 由实际请求地址推导的模型列表地址（推不出来就不显示，不猜） */
const aiModelsUrl = computed(() => modelsUrlFromChat(aiDraft.endpoint) || '')

/** 选中预设：填基础地址 + 常见模型名；「自定义」只切标记，不动用户已填内容 */
function applyAiPreset(key: string) {
  const p = AI_PROVIDER_PRESETS.find(x => x.key === key)
  if (!p || !p.baseUrl) return
  aiDraft.endpoint = p.baseUrl
  if (p.models.length && !p.models.includes(aiDraft.model)) aiDraft.model = p.models[0]
  aiModels.value = []
  aiMsg.value = ''
}

/** 载入配置后按地址反查所属预设（只为下拉显示正确，不改用户数据） */
function matchPresetFor(endpoint: string): string {
  const norm = normalizeAiEndpoint(endpoint)
  const hit = AI_PROVIDER_PRESETS.find(p => p.baseUrl && normalizeAiEndpoint(p.baseUrl) === norm)
  return hit ? hit.key : '__custom__'
}

async function loadAiConfig() {
  const res = await window.shopilot.ai.configGet()
  if (!res.ok) return
  aiConfig.value = res.data
  aiDraft.endpoint = res.data.endpoint
  aiDraft.model = res.data.model
  aiDraft.timeoutMs = res.data.timeoutMs
  aiProviderKey.value = matchPresetFor(res.data.endpoint)
}

/** 保存 AI 非敏感项；Key 留空表示不改动（避免误清空） */
async function saveAiConfig(): Promise<boolean> {
  const res = await window.shopilot.ai.configSet({
    endpoint: aiDraft.endpoint.trim(),
    model: aiDraft.model.trim(),
    timeoutMs: Number(aiDraft.timeoutMs) || DEFAULT_AI_TIMEOUT_MS
  })
  if (!res.ok) { ws.toast('保存 AI 配置失败: ' + res.error.message, 'error'); return false }
  aiConfig.value = res.data
  const key = aiKeyDraft.value.trim()
  if (key) {
    const kr = await window.shopilot.ai.setKey(key)
    if (!kr.ok) { ws.toast('保存 API Key 失败: ' + kr.error.message, 'error'); return false }
    aiKeyDraft.value = ''
    aiConfig.value = { ...aiConfig.value, hasKey: kr.data.hasKey }
  }
  return true
}

async function testAi() {
  aiTesting.value = true
  aiMsg.value = ''
  // 先落盘再测，避免"测的是旧配置"
  if (!(await saveAiConfig())) { aiTesting.value = false; return }
  const res = await window.shopilot.ai.test()
  aiTesting.value = false
  if (res.ok) { aiMsgOk.value = true; aiMsg.value = `连接成功：模型 ${res.data.model}，${res.data.elapsedMs}ms` }
  else { aiMsgOk.value = false; aiMsg.value = `连接失败（${res.error.code}）：${res.error.message}` }
}

/**
 * 获取可用模型：只读 GET /models（地址由接口地址推导）。
 * 先落盘再拉取，避免"拿旧地址去请求"；失败只如实报错，不保留/编造任何候选模型。
 */
async function fetchAiModels() {
  aiModelsLoading.value = true
  aiMsg.value = ''
  if (!(await saveAiConfig())) { aiModelsLoading.value = false; return }
  const res = await window.shopilot.ai.listModels()
  aiModelsLoading.value = false
  if (res.ok) {
    aiModels.value = res.data.models
    aiMsgOk.value = true
    aiMsg.value = `已获取 ${res.data.models.length} 个可用模型（${res.data.elapsedMs}ms），在下拉里选一个即填入模型名`
  } else {
    aiModels.value = []
    aiMsgOk.value = false
    aiMsg.value = `获取模型失败（${res.error.code}）：${res.error.message}`
  }
}

/** 选中下拉项 → 只把模型名填进输入框（仍需点「保存」才生效） */
function pickAiModel(name: string) {
  if (name) aiDraft.model = name
}

// 接口地址一改，之前拉到的模型列表就不再对应当前端点了：立即清空，避免误选
watch(() => aiDraft.endpoint, () => { aiModels.value = [] })

async function clearAiKey() {
  const res = await window.shopilot.ai.clearKey()
  if (res.ok) { aiConfig.value = { ...aiConfig.value, hasKey: false }; aiMsgOk.value = true; aiMsg.value = 'API Key 已清除' }
  else { aiMsgOk.value = false; aiMsg.value = '清除失败: ' + res.error.message }
}

function openSettings(tab: 'config' | 'square' | 'ai' | 'about' = 'config') {
  settingsOpen.value = true
  settingsTab.value = tab
  for (const p of quickPlatforms) homeUrlDraft[p.name] = platformHomeUrls.value[p.name] || ''
  for (const p of inviteProfiles.value) squareUrlDraft[p.platform] = squareUrls.value[p.platform] || ''
  void loadAiConfig()
  if (tab === 'about') void refreshUpdatePanel()
}

/** 打开"关于软件"页时刷新版本与更新状态（进入设置弹窗时调用） */
async function refreshUpdatePanel() {
  const [ch, ac, res] = await Promise.all([
    window.shopilot.settings.get('update.channel'),
    window.shopilot.settings.get('update.autoCheck'),
    window.shopilot.update.status()
  ])
  if (ch.ok && (ch.data?.value === 'stable' || ch.data?.value === 'beta')) updateChannel.value = ch.data.value
  if (ac.ok) updateAutoCheck.value = ac.data?.value === true
  if (res.ok) applyUpdateStatus(res.data)
}

/**
 * 保存平台首页地址。只接受 http(s) 开头或留空（留空 = 回退平台默认）；
 * 这里不做可达性探测——与仓库"不猜测地址"的红线一致，配错了首页就打不开，由用户自己判断。
 */
async function savePlatformHomeUrls(): Promise<boolean> {
  const next: Record<string, string> = {}
  for (const p of quickPlatforms) {
    const v = (homeUrlDraft[p.name] || '').trim()
    if (!v) continue
    if (!/^https?:\/\//i.test(v)) {
      ws.toast(`「${p.name}」的首页地址需以 http:// 或 https:// 开头`, 'error')
      return false
    }
    next[p.name] = v
  }
  const res = await window.shopilot.settings.set('platform.homeUrls', next)
  if (!res.ok) { ws.toast('保存失败: ' + res.error.message, 'error'); return false }
  platformHomeUrls.value = next
  ws.toast('平台首页地址已保存', 'success')
  return true
}

/** 单个平台恢复默认（清空覆盖值，仅改草稿，仍需点保存） */
function resetPlatformHome(name: string) {
  homeUrlDraft[name] = ''
}

/** 保存当前页签自己的配置；校验/写入失败就留在弹窗里，成功才关闭 */
async function saveSettingsConfig() {
  const tab = settingsTab.value
  if (tab === 'config') {
    if (!(await savePlatformHomeUrls())) return
  } else if (tab === 'square') {
    if (!(await saveSquareUrls())) return
    ws.toast('达人广场地址已保存', 'success')
  } else if (tab === 'ai') {
    if (!(await saveAiConfig())) return
    ws.toast('AI 配置已保存', 'success')
  } else {
    settingsOpen.value = false
    return
  }
  settingsOpen.value = false
}

/**
 * 首页按钮的目标地址，按优先级：**设置里配置的平台首页 → 店铺自己的后台地址 → 平台目录默认 → 空**。
 * 配置值优先级最高是用户明确选择的（配了就以它为准）；未配置时仍尊重店铺自己填的后台地址，
 * 否则"每个店铺可定制后台地址"对四家平台就形同失效了。
 */
const homeUrl = computed(() => {
  const s = ws.stores.find(x => x.id === ws.displayedStoreId)
  if (!s) return ''
  const configured = (platformHomeUrls.value[s.platform] || '').trim()
  return configured || (s.adminUrl || '').trim() || platformHome(s.platform)
})

/** 回到店铺首页；无活动标签页时 ws.navigate 会新建一个 */
function goHome() {
  if (homeUrl.value) ws.navigate(homeUrl.value)
}

const form = reactive({ name: '', platform: DEFAULT_PLATFORM, adminUrl: '', tags: '', notes: '', licenseName: '', licenseNo: '' })

type UpdateState = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
const updateStatus = reactive<{ state: UpdateState; currentVersion: string; version?: string; percent?: number; error?: string }>({ state: 'idle', currentVersion: '' })
/** 更新通道与启动自动检查（§21 双通道）：持久化在 app_settings，主进程检查时读取 */
const updateChannel = ref<string>('stable')
const updateAutoCheck = ref(false)
let updateEventHandler: ((payload: any) => void) | null = null

function applyUpdateStatus(payload: any) {
  if (!payload) return
  Object.assign(updateStatus, payload)
}
async function openSettingsTab(tab: 'config' | 'square' | 'ai' | 'about') {
  settingsTab.value = tab
  if (tab === 'about') await refreshUpdatePanel()
}

async function saveUpdateChannel() {
  await window.shopilot.settings.set('update.channel', updateChannel.value === 'beta' ? 'beta' : 'stable')
  const res = await window.shopilot.update.status()
  if (res.ok) applyUpdateStatus(res.data)
}
async function saveUpdateAutoCheck() {
  await window.shopilot.settings.set('update.autoCheck', updateAutoCheck.value === true)
}
async function checkUpdate() {
  updateStatus.state = 'checking'
  const res = await window.shopilot.update.check()
  if (res.ok) applyUpdateStatus(res.data)
  else { updateStatus.state = 'error'; updateStatus.error = res.error.message }
}
async function downloadUpdate() {
  const res = await window.shopilot.update.download()
  if (res.ok) applyUpdateStatus(res.data)
  else { updateStatus.state = 'error'; updateStatus.error = res.error.message }
}
async function installUpdate() { await window.shopilot.update.install() }

/**
 * 选中平台后自动填入该平台的后台地址（仅当地址为空或仍是别的平台的默认值时，不覆盖用户手填）。
 * 取「设置 → 配置」里配的平台首页地址，其次平台目录默认——保持与首页按钮同一套地址来源。
 */
function applyPlatformDefaults(name: string) {
  if (!quickPlatforms.some(p => p.name === name)) return
  const target = platformHome(name)
  const cur = (form.adminUrl || '').trim()
  const isOtherPlatformDefault = quickPlatforms.some(p => p.name !== name && platformHome(p.name) === cur)
  if (!cur || isOtherPlatformDefault) form.adminUrl = target
}
function onPlatformChange() { applyPlatformDefaults(form.platform) }

/** 一键清除所有筛选条件（搜索 + 平台 + 状态） */
function clearFilters() {
  ws.search = ''
  ws.filterPlatform = ''
}

function isOpen(id: string) { return ws.openStoreIds.includes(id) }

function statusColor(s: string) {
  return ({ online: '#10B981', launching: '#3B82F6', needs_login: '#F59E0B', proxy_error: '#EF4444', archived: '#6B6B6B' } as any)[s] || '#6B7280'
}

function shortUrl(u: string) { try { return new URL(u).host } catch { return u } }
function fmtSize(n: number) { if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB' }
function dlStateText(s: string) { return ({ completed: '已完成', in_progress: '下载中', cancelled: '已取消', interrupted: '中断' } as any)[s] || s }

type ViewportReport = { x: number; y: number; width: number; height: number }
let pendingViewportReport: ViewportReport | null = null
let viewportReportRunning = false

/**
 * ResizeObserver、面板切换和窗口 resize 可能在同一帧连续触发。
 * IPC invoke 虽然返回 Promise，但多个调用并不保证按视觉状态顺序完成，
 * 旧 bounds 晚到时会把原生 WebContentsView 留在过期宽度。串行提交并只保留最新值。
 */
function flushViewportReports() {
  if (viewportReportRunning) return
  viewportReportRunning = true
  void (async () => {
    try {
      while (pendingViewportReport) {
        const next = pendingViewportReport
        pendingViewportReport = null
        await window.shopilot.browser.setViewport(next)
      }
    } finally {
      viewportReportRunning = false
      if (pendingViewportReport) flushViewportReports()
    }
  })()
}

function reportViewport() {
  const el = viewportEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  pendingViewportReport = {
    x: Math.round(r.left), y: Math.round(r.top),
    width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height))
  }
  flushViewportReports()
}

async function toggleStore(id: string) {
  if (isOpen(id)) await ws.closeStore(id)
  else await ws.openStore(id)
}

function submitUrl() {
  let u = urlDraft.value.trim()
  if (!u) return
  if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u
  ws.navigate(u)
}

watch(() => ws.activeTab?.url, (v) => { urlDraft.value = v || '' }, { immediate: true })
watch(() => ws.displayedStoreId, () => { nextTick(reportViewport) })

async function bookmarkCurrent() {
  const t = ws.activeTab
  if (!t || t.url === 'about:blank') { ws.toast('当前页无法收藏', 'info'); return }
  const res = await window.shopilot.bookmark.create({ storeId: ws.displayedStoreId, url: t.url, title: t.title || t.url })
  if (res.ok) { ws.toast('已收藏', 'success'); ws.refreshBookmarks() }
}

async function delBookmark(id: string) {
  await window.shopilot.bookmark.delete(id)
  ws.refreshBookmarks()
}

function openWindow() {
  if (ws.activeTab) window.shopilot.browser.openWindow(ws.displayedStoreId!, ws.activeTab.id)
}

// ---------- 环境面板：代理 + 指纹（§8.1 / §13 / §16） ----------
interface ProxyLite { id: string; type: string; host: string; port: number; label: string | null; status: string; hasCredential: boolean; lastLatencyMs: number | null }
const proxies = ref<ProxyLite[]>([])
const proxyBindId = ref('')
const envBindingNote = ref('')
const lastProxyAuth = ref<{ at: number; username: string; proxyId: string } | null>(null)
const testingIds = ref<string[]>([])
const verifyItems = ref<Array<{ field: string; expected: any; actual: any; state: string }>>([])
const verifying = ref(false)
const np = reactive({ label: '', type: 'http', host: '', port: null as number | null, user: '', pass: '' })

async function refreshEnv() {
  const pl = await window.shopilot.proxy.list()
  if (pl.ok) proxies.value = pl.data
  const sid = ws.displayedStoreId
  if (!sid) return
  const st = await window.shopilot.session.status(sid)
  if (st.ok) {
    const b = st.data.binding
    proxyBindId.value = b && b.mode === 'bound' ? (b.proxyId || '') : ''
    envBindingNote.value = b && b.mode === 'bound' ? '当前：绑定代理' : '当前：直连'
    lastProxyAuth.value = st.data.lastProxyAuth || null
  }
}

async function applyBind() {
  const sid = ws.displayedStoreId
  if (!sid) return
  const res = await window.shopilot.proxy.bind(sid, proxyBindId.value || null)
  if (res.ok) {
    ws.toast(proxyBindId.value ? '已绑定代理，对打开中的店铺即时生效' : '已切回直连', 'success')
    refreshEnv()
  } else ws.toast('绑定失败: ' + res.error.message, 'error')
}

async function testProxy(p: ProxyLite) {
  testingIds.value = [...testingIds.value, p.id]
  const res = await window.shopilot.proxy.test({ type: p.type, host: p.host, port: p.port }, p.id)
  testingIds.value = testingIds.value.filter(x => x !== p.id)
  if (res.ok && res.data.ok) ws.toast(`代理可达，延迟 ${res.data.latencyMs} ms`, 'success')
  else ws.toast('代理不可达: ' + (res.ok ? res.data.errorCode : res.error.message), 'error')
  refreshEnv()
}

async function addProxy() {
  const draft = { type: np.type, host: np.host.trim(), port: Number(np.port), label: np.label.trim() || undefined }
  const res = await window.shopilot.proxy.create(draft, np.user || undefined, np.pass || undefined)
  if (res.ok) {
    ws.toast('代理已保存（凭据经本机加密存储，不回显）', 'success')
    np.label = ''; np.host = ''; np.port = null; np.user = ''; np.pass = ''
    refreshEnv()
  } else ws.toast('保存失败: ' + res.error.message, 'error')
}

async function removeProxy(id: string) {
  if (!window.confirm('删除该代理？绑定它的店铺会回退直连。')) return
  await window.shopilot.proxy.delete(id)
  if (proxyBindId.value === id) proxyBindId.value = ''
  refreshEnv()
}

async function verifyEnv() {
  const sid = ws.displayedStoreId
  if (!sid) return
  verifying.value = true
  const res = await window.shopilot.profile.verify(sid)
  verifying.value = false
  if (res.ok) {
    verifyItems.value = res.data.items
    const bad = res.data.items.filter((i: any) => i.state !== 'verified').length
    ws.toast(bad === 0 ? '环境指纹全部字段实测一致' : `${bad} 个字段未验证（需浏览器打开该店铺页面）`, bad === 0 ? 'success' : 'info')
  } else ws.toast('验证失败: ' + res.error.message, 'error')
}

function clip(v: any): string {
  const s = v == null ? '—' : String(v)
  return s.length > 46 ? s.slice(0, 43) + '…' : s
}

// ---------- 会话包 / Cookie 查看器（§6.3 / §10.2） ----------
const cookies = ref<any[]>([])
const cookiesTotal = ref(0)
const ckSearch = ref('')
const secBusy = ref(false)

async function refreshCookies() {
  const sid = ws.displayedStoreId
  if (!sid) { cookies.value = []; cookiesTotal.value = 0; return }
  const res = await window.shopilot.session.cookies(sid, ckSearch.value || undefined)
  if (res.ok) { cookies.value = res.data.items; cookiesTotal.value = res.data.total }
}

async function exportSession() {
  const sid = ws.displayedStoreId
  if (!sid) return
  secBusy.value = true
  const res = await window.shopilot.session.export(sid)
  secBusy.value = false
  if (res.ok) ws.toast(`会话包已导出（${res.data.cookieCount} 条 Cookie，有效期至 ${new Date(res.data.expiresAt).toLocaleDateString()}）`, 'success')
  else if (res.error.code !== 'SESSION_CANCELLED') ws.toast('导出失败: ' + res.error.message, 'error')
  if (res.ok) refreshCookies()
}

async function importSession() {
  const sid = ws.displayedStoreId
  if (!sid) return
  secBusy.value = true
  const res = await window.shopilot.session.import(sid, '', true)
  secBusy.value = false
  if (res.ok) ws.toast(`会话已导入：${res.data.imported} 条 Cookie 生效${res.data.failed ? `（${res.data.failed} 条失败）` : ''}${res.data.profileRestored ? '，指纹配置已随包恢复' : ''}`, 'success')
  else if (res.error.code !== 'SESSION_CANCELLED') ws.toast('导入失败: ' + res.error.message, 'error')
  refreshCookies()
}

async function delCookie(c: any) {
  const sid = ws.displayedStoreId
  if (!sid) return
  await window.shopilot.session.deleteCookie(sid, c.name, c.domain, c.path, c.secure)
  refreshCookies()
}

async function clearCookies() {
  const sid = ws.displayedStoreId
  if (!sid) return
  if (!window.confirm(`清空「${storeName(sid)}」的全部 Cookie？该店铺的登录态将失效。`)) return
  const res = await window.shopilot.session.clearCookies(sid)
  if (res.ok) ws.toast('Cookie 已清空', 'success')
  refreshCookies()
}

// ---------- 应用锁（§6.5 / §189） ----------
const pw1 = ref(''); const pw2 = ref(''); const oldPw = ref('')
const showChangePw = ref(false)
const secMsg = ref(''); const secMsgOk = ref(false)
const idleMinSel = ref(0)

function say(msg: string, okf = true) { secMsg.value = msg; secMsgOk.value = okf }

async function setMasterPw() {
  const wasEnabled = ws.securityEnabled
  const res = await window.shopilot.security.setPassword(pw1.value, wasEnabled ? oldPw.value : undefined)
  if (res.ok) {
    say(wasEnabled ? '主密码已更新' : '主密码已设置，可立即锁定或等待空闲自动锁定')
    pw1.value = ''; pw2.value = ''; oldPw.value = ''; showChangePw.value = false
    await ws.refreshSecurity()
  } else say(res.error.message, false)
}

async function removePw() {
  const cred = window.prompt('移除主密码需输入当前密码')
  if (!cred) return
  const res = await window.shopilot.security.removePassword(cred)
  if (res.ok) { say('主密码已移除'); await ws.refreshSecurity() }
  else say(res.error.message, false)
}

async function lockNow() {
  const res = await window.shopilot.security.lock()
  if (res.ok) await ws.refreshSecurity()
  else say(res.error.message, false)
}

async function applyIdle() {
  const res = await window.shopilot.settings.set('security.idleMinutes', idleMinSel.value)
  if (res.ok) { say(idleMinSel.value ? `空闲 ${idleMinSel.value} 分钟自动锁定已启用` : '空闲自动锁定已关闭'); await ws.refreshSecurity() }
}

watch(() => ws.idleMinutes, (v) => { idleMinSel.value = v }, { immediate: true })
watch(() => ws.proxyEpoch, () => { refreshEnv() })
watch(() => ws.displayedStoreId, () => { refreshCookies(); if (ws.rightPanel === 'bookmarks') refreshEntryRoutes() })

// ---------- 备份与诊断（§10.2 / §22 / §28） ----------
const backups = ref<any[]>([])
const busyBackup = ref(false)
const busyDiag = ref(false)

async function refreshBackups() {
  const res = await window.shopilot.backup.list()
  if (res.ok) backups.value = (res.data || []).slice(0, 3)
}

async function doBackup() {
  busyBackup.value = true
  const res = await window.shopilot.backup.create()
  busyBackup.value = false
  if (res.ok) { ws.toast('数据库备份完成（含校验和）', 'success'); refreshBackups() }
  else ws.toast('备份失败: ' + res.error.message, 'error')
}

async function doRestore(id: string) {
  if (!window.confirm('恢复将覆盖当前数据库（恢复前会自动创建安全快照）。继续？')) return
  busyBackup.value = true
  const res = await window.shopilot.backup.restore(id)
  busyBackup.value = false
  if (res.ok) { ws.toast('已恢复备份，安全快照已保留', 'success'); await ws.refreshStores() }
  else ws.toast('恢复失败（现有数据未受影响）: ' + res.error.message, 'error')
}

async function doDiagnostics() {
  busyDiag.value = true
  const res = await window.shopilot.diagnostics.export()
  busyDiag.value = false
  if (res.ok) ws.toast('诊断包已导出：' + res.data.path, 'success')
  else if (res.error.code !== 'SESSION_CANCELLED') ws.toast('导出失败: ' + res.error.message, 'error')
}

async function doAuditExport() {
  const res = await window.shopilot.audit.export({ limit: 5000 })
  if (res.ok) ws.toast(`审计日志已导出（${res.data.rows} 条）`, 'success')
  else if (res.error.code !== 'SESSION_CANCELLED') ws.toast('导出失败: ' + res.error.message, 'error')
}

refreshBackups()

watch(() => ws.displayedStoreId, () => { verifyItems.value = []; detailTaskId.value = null; if (ws.rightPanel === 'env') refreshEnv() })

// ---------- 任务面板（§4.4 预定义步骤 / §6.6 事件） ----------
/**
 * 任务面板的二级页签：新增任务类功能时在这里加一条即可（面板结构不用动）。
 * pending=true 的页签是占位——只说明"位置留好了"，不代表已有能力。
 */
const TASK_SUB_TABS = [
  { key: 'tasks' as const, label: '任务列表', pending: false },
  { key: 'invite' as const, label: '达人邀约', pending: false },
  { key: 'todo' as const, label: '待开发', pending: true }
]
const taskSubTab = ref<'tasks' | 'invite' | 'todo'>('tasks')
/**
 * 任务功能对应每个店铺：任务列表只显示当前显示店铺的任务（引擎侧仍存全量，仅界面按店铺隔离）。
 *  未打开店铺时显示历史遗留的"未绑定店铺"任务（新任务一律绑定店铺）。
 *
 * **达人邀约也进任务列表**（用户明确要求）：它由「新建任务 → 达人邀约」创建，与其它任务一样
 * 能看进度、运行/停止/删除；同时在「达人邀约」页签保留「邀约记录」视图（同一份运行，
 * 两个入口两种视角：这里看"任务整体状态"，那边看"邀约业务明细"）。
 *
 * 「发票采集 / 经营数据采集」仍**不**列进来：它们由各自面板发起、且结果就在那个面板里，
 * 混进来只会让人对着两份视图找同一个结果。
 */
const INVITE_TASK_PREFIX = '达人邀约 ·'
const SELF_MANAGED_TASK_PREFIXES = ['发票采集 ·', '经营数据采集 ·'] as const
const storeTasks = computed(() => ws.tasks.filter(t =>
  (t.storeScope === ws.displayedStoreId ||
    (!t.storeScope && t.latestRun?.storeId === ws.displayedStoreId)) &&
  !SELF_MANAGED_TASK_PREFIXES.some(p => t.name.startsWith(p))
))
const inviteHistory = computed(() => {
  const sid = ws.displayedStoreId
  if (!sid) return []
  return ws.tasks.filter(t => t.storeScope === sid && t.name.startsWith(INVITE_TASK_PREFIX)).slice(0, 5)
})
/** 邀约记录行的时间标签：取最近一次运行的结束/开始/创建时间 */
function runTimeLabel(t: any): string {
  const run = t.latestRun
  const ts = run?.finishedAt || run?.startedAt || t.createdAt
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
// ---------- 达人邀约：按「当前店铺的平台」匹配平台档案（平台流程相互独立） ----------
const inviteProfile = computed(() => {
  const s = ws.stores.find(x => x.id === ws.displayedStoreId)
  return inviteProfileFor(s?.platform)
})
const invite = reactive({
  category: '' as string,
  /** 二级类目（'' = 不限子类，即整个一级）；仅 category 非空时可选 */
  subcategory: '' as string,
  /** 三级类目（'' = 不限三级）；仅抖店等 categoryDepth=3 的平台可选 */
  category3: '' as string,
  levels: [] as string[],
  count: 5,
  script: '',
  benefits: [] as string[],
  /** 话术来源：手填 / AI 按平台推荐商品生成（AI 模式下话术框只读，由任务运行时写入） */
  scriptMode: 'manual' as 'manual' | 'ai',
  // ---- 以下为 assist-form（微信小店）专属字段 ----
  contact: '',
  wechat: '',
  phone: '',
  /** 微信广场筛选：类型单选、带货类目多选、其他筛选多选 */
  finderType: '全部带货者',
  finderCategories: [] as string[],
  finderOtherFilters: [] as string[],
  /** 指定邀约商品 ID，逗号/空格/换行分隔 */
  productIds: '',
  productCount: 1,
  // ---- batch-list 平台间的差异字段（快手用；抖店留空即不生效）----
  /** 额外筛选行（快手：内容标签 / 合作信息）→ { 行标签: [已选项] } */
  extraFilters: {} as Record<string, string[]>,
  /** 抽屉里的必填联系方式（快手要求联系人/手机号/微信号都填） */
  batchContact: '',
  batchPhone: '',
  batchWechat: '',
  /** 邀约商品数（快手必选商品才能发送；默认 1 个） */
  batchProductCount: 1,
  /** 跨平台不共话术：切到不同平台的店铺时清空脚本（抖店/微信的话术口径不同） */
  platformKey: ''
})
const categoryOptions = computed(() => {
  const p = inviteProfile.value
  if (!p || !isBatchProfile(p)) return []
  return inviteCategoryTreeFor(p).map(c => c.name)
})

/** 当前一级类目的二级选项（平台档案或实时读取；category 为空或无子类 → 空数组） */
const subCategoryOptions = computed(() => {
  const p = inviteProfile.value
  if (!p || !isBatchProfile(p) || !invite.category) return []
  return inviteCategoryTreeFor(p).find(c => c.name === invite.category)?.children ?? []
})

/** 当前二级类目的三级选项（只有平台返回真实三级数据时非空） */
const thirdCategoryOptions = computed(() => {
  const p = inviteProfile.value
  if (!p || !isBatchProfile(p) || p.categoryDepth !== 3 || !invite.category || !invite.subcategory) return []
  return inviteCategoryTreeFor(p)
    .find(c => c.name === invite.category)?.grandchildren
    ?.find(c => c.name === invite.subcategory)?.children ?? []
})

// ---------- 微信邀约面板的展示态（只影响观感，不参与执行） ----------
/** 带货类目默认折叠：34 项铺开要占 13 行（实测 314px），默认只显示已选 + 前若干项 */
const inviteCatsExpanded = ref(false)
const inviteCatQuery = ref('')
/** 类目搜索：空词且未展开时，只给「已选 + 前 N 项」，其余折叠 */
const CAT_COLLAPSED_LIMIT = 10
const finderCategoryShown = computed(() => {
  const p = inviteProfile.value
  if (!p || !isAssistProfile(p)) return []
  const all = p.finderCategories as readonly string[]
  const q = inviteCatQuery.value.trim()
  if (q) return all.filter(c => c.includes(q))
  if (inviteCatsExpanded.value || invite.finderCategories.length > 0) {
    // 展开或已有选择：显示全部（已选的排前面，方便核对）
    const chosen = all.filter(c => invite.finderCategories.includes(c))
    const rest = all.filter(c => !invite.finderCategories.includes(c))
    return inviteCatsExpanded.value ? [...chosen, ...rest] : [...chosen, ...rest.slice(0, CAT_COLLAPSED_LIMIT)]
  }
  return all.slice(0, CAT_COLLAPSED_LIMIT)
})
const finderCategoryHidden = computed(() => {
  const p = inviteProfile.value
  if (!p || !isAssistProfile(p)) return 0
  const q = inviteCatQuery.value.trim()
  if (q) return 0
  return Math.max(0, p.finderCategories.length - finderCategoryShown.value.length)
})
/** 顶部配置摘要：开跑前一眼核对（避免滚下去才发现选错） */
/**
 * 「新建任务」对话框里的"将创建"汇总（纯文本，覆盖两种流程）。
 *
 * 为什么不复用 inviteSummary：那是面板顶部摘要条的 `{k,v}` 数组，且**只对 assist-form（微信）
 * 有返回**——抖店/快手的 batch-list 拿到的是空数组，对话框里会显示成 `[]`（真机实测踩到）。
 * 这里按 flow 分别取各自真正会写进步骤的字段。
 */
const taskFlowSummaryText = computed(() => {
  const p = inviteProfile.value
  if (!p) return ''
  if (p.flow === 'batch-list') {
    const cat = invite.category
      ? invite.category +
        (invite.subcategory ? '/' + invite.subcategory : '') +
        (invite.subcategory && invite.category3 ? '/' + invite.category3 : '')
      : '全部'
    const parts = [`类目 ${cat}`]
    if (p.levels.length) parts.push(`等级 ${invite.levels.join('/') || '未选'}`)
    for (const row of (p.extraFilterRows || [])) {
      const picks = invite.extraFilters[row.label] || []
      if (picks.length) parts.push(`${row.label} ${picks.join('、')}`)
    }
    parts.push(`每批 ${Math.max(invite.count, p.minSelect || 1)} 位`)
    if (p.contactSelectors) parts.push(`联系人 ${invite.batchContact.trim() || '未填'}`)
    if (p.goodsModal) parts.push(`商品 ${invite.batchProductCount} 个`)
    parts.push(invite.scriptMode === 'ai' ? '话术 AI 生成' : `话术 ${invite.script.trim().length} 字`)
    return parts.join(' · ')
  }
  // assist-form（微信）：逐个达人邀约
  const parts = [
    `类型 ${invite.finderType}`,
    `类目 ${invite.finderCategories.length ? (invite.finderCategories.length <= 2 ? invite.finderCategories.join('、') : invite.finderCategories.slice(0, 2).join('、') + ` 等 ${invite.finderCategories.length} 项`) : '不限'}`,
    `其他 ${invite.finderOtherFilters.length ? invite.finderOtherFilters.join('、') : '无'}`,
    `联系人 ${invite.contact.trim() || '未填'}`,
    `商品 ${inviteProducts.value.length ? inviteProducts.value.length + ' 个ID' : '1 个(自动)'}`
  ]
  return parts.join(' · ')
})

const inviteSummary = computed(() => {
  const p = inviteProfile.value
  if (!p || !isAssistProfile(p)) return []
  const cats = invite.finderCategories
  return [
    { k: '类型', v: invite.finderType },
    { k: '类目', v: cats.length ? (cats.length <= 2 ? cats.join('、') : `${cats.slice(0, 2).join('、')} 等 ${cats.length} 项`) : '不限' },
    { k: '其他', v: invite.finderOtherFilters.length ? invite.finderOtherFilters.join('、') : '无' },
    { k: '联系人', v: invite.contact.trim() || '未填' },
    { k: '商品', v: inviteProducts.value.length ? `${inviteProducts.value.length} 个ID` : '1 个(自动)' }
  ]
})

/** 一级变化时二级、三级跟随清空；二级变化时三级跟随清空 */
watch(() => invite.category, () => {
  if (invite.subcategory && !subCategoryOptions.value.includes(invite.subcategory)) invite.subcategory = ''
  if (invite.category3 && !thirdCategoryOptions.value.includes(invite.category3)) invite.category3 = ''
})
watch(() => invite.subcategory, () => {
  if (invite.category3 && !thirdCategoryOptions.value.includes(invite.category3)) invite.category3 = ''
})

/**
 * 额外筛选行的多选切换（快手：内容标签 / 合作信息）。
 * 不用 v-model 直接绑（那是动态 key，模板里不好写），改成一个显式 toggle——
 * 同时保证写回的数组是**新数组**，让 deep watch 能捕捉到并触发配置持久化。
 */
function toggleExtraFilter(rowLabel: string, opt: string) {
  const cur = invite.extraFilters[rowLabel] || []
  const next = cur.includes(opt) ? cur.filter(x => x !== opt) : [...cur, opt]
  invite.extraFilters = { ...invite.extraFilters, [rowLabel]: next }
}
// 店铺/平台变化时把可选项重置为该平台档案的默认值，随后**合并该平台保存过的配置**
// （用户要求：主推类目/达人等级/数量/话术要能记住，不能每次重启都重置）
watch(inviteProfile, (p) => {
  if (!p) return
  if (invite.platformKey !== p.platform) {
    invite.script = ''
    invite.scriptMode = 'manual'
    invite.platformKey = p.platform
  }
  if (p.flow === 'batch-list') {
    const tree = inviteCategoryTreeFor(p)
    invite.category = tree[2]?.name || tree[0]?.name || p.categories[2] || p.categories[0] || ''
    invite.subcategory = ''
    invite.category3 = ''
    invite.levels = [...p.levelsWithQuotaHint]
    invite.benefits = []
    invite.extraFilters = {}
    invite.count = Math.max(1, Math.min(invite.count || 5, p.maxBatch))
  } else {
    invite.levels = []
    invite.benefits = []
    invite.count = 1
    // 微信流程商品固定按 ID 指定（留空则自动加 1 个），不再有可调数量
    invite.productCount = 1
  }
  void loadInviteConfig(p)
}, { immediate: true })

// ---------- 邀约配置持久化（按平台各存一份到 settings 表） ----------
const INVITE_CFG_KEY = (platform: string) => `invite.config.${platform}`
/** 已完成"读取→合并"的平台：此后的变更才回写，防止启动时的默认值把存档覆盖掉 */
const inviteCfgLoaded = new Set<string>()

function inviteCfgFields(flow: 'batch-list' | 'assist-form'): readonly string[] {
  return flow === 'batch-list'
    // extraFilters/batchContact 等是快手需要的字段；抖店那份配置里它们留空，不影响既有行为
    ? ['category', 'subcategory', 'category3', 'levels', 'count', 'script', 'scriptMode', 'benefits',
       'extraFilters', 'batchContact', 'batchPhone', 'batchWechat', 'batchProductCount']
    // 微信流程不含 productCount：面板已去掉「添加商品数量」，商品固定按 ID 指定（留空则加 1 个）
    : ['contact', 'wechat', 'phone', 'finderType', 'finderCategories', 'finderOtherFilters', 'productIds', 'script', 'scriptMode']
}

async function loadInviteConfig(p: NonNullable<ReturnType<typeof inviteProfileFor>>) {
  const key = p.platform
  try {
    const res = await window.shopilot.settings.get(INVITE_CFG_KEY(key))
    // 等待期间用户切走了店铺/平台 → 丢弃，避免把 A 平台的配置灌进 B 平台
    if (inviteProfile.value?.platform !== key) return
    // settings.get 的返回是 { key, value } 包装，配置本体在 .value 里（漏拆包装=永远读不到存档）
    const raw = res.ok && res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>).value : null
    const saved = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
    if (saved) {
      const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null)
      if (p.flow === 'batch-list') {
        const tree = inviteCategoryTreeFor(p)
        const cat = str(saved.category, 40)
        if (cat !== null && (cat === '' || tree.some(c => c.name === cat))) invite.category = cat
        const sub = str(saved.subcategory, 40)
        const catNode = cat ? tree.find(c => c.name === cat) : undefined
        const kids = catNode?.children ?? []
        // 二级只在属于该一级的子类列表时才恢复，否则回「不限」
        if (sub !== null && (sub === '' || kids.includes(sub))) invite.subcategory = sub
        const third = str(saved.category3, 40)
        const thirdKids = catNode?.grandchildren?.find(c => c.name === invite.subcategory)?.children ?? []
        if (third !== null && (third === '' || thirdKids.includes(third))) invite.category3 = third
        if (Array.isArray(saved.levels)) invite.levels = saved.levels.filter((x): x is string => typeof x === 'string' && p.levels.includes(x))
        if (typeof saved.count === 'number' && Number.isFinite(saved.count)) invite.count = Math.max(1, Math.min(Math.round(saved.count), p.maxBatch))
        const sc = str(saved.script, p.scriptMaxLen)
        if (sc !== null) invite.script = sc
        if (saved.scriptMode === 'ai' || saved.scriptMode === 'manual') invite.scriptMode = saved.scriptMode
        if (Array.isArray(saved.benefits)) invite.benefits = saved.benefits.filter((x): x is string => typeof x === 'string' && p.benefits.includes(x))
        // 快手那几项（抖店存档里没有 → 保持默认）
        if (saved.extraFilters && typeof saved.extraFilters === 'object') {
          const out: Record<string, string[]> = {}
          for (const row of (p.extraFilterRows || [])) {
            const v = (saved.extraFilters as any)[row.label]
            // 只收该行**确实存在**的选项（平台改版/换平台后不残留无效项）
            if (Array.isArray(v)) out[row.label] = v.filter((x: unknown): x is string => typeof x === 'string' && row.options.includes(x))
          }
          invite.extraFilters = out
        }
        const bc = str(saved.batchContact, 60); if (bc !== null) invite.batchContact = bc
        const bp = str(saved.batchPhone, 40); if (bp !== null) invite.batchPhone = bp
        const bw = str(saved.batchWechat, 60); if (bw !== null) invite.batchWechat = bw
        if (typeof saved.batchProductCount === 'number' && Number.isFinite(saved.batchProductCount)) {
          // 快手必选商品 → 下限 1（存档里的 0 会被抬到 1）
          invite.batchProductCount = Math.max(1, Math.min(Math.round(saved.batchProductCount), p.maxProducts))
        }
      } else {
        const c = str(saved.contact, 60); if (c !== null) invite.contact = c
        const w = str(saved.wechat, 60); if (w !== null) invite.wechat = w
        const ph = str(saved.phone, 40); if (ph !== null) invite.phone = ph
        if (typeof saved.finderType === 'string' && p.finderTypes.includes(saved.finderType)) invite.finderType = saved.finderType
        if (Array.isArray(saved.finderCategories)) invite.finderCategories = saved.finderCategories.filter((x): x is string => typeof x === 'string' && p.finderCategories.includes(x))
        if (Array.isArray(saved.finderOtherFilters)) invite.finderOtherFilters = saved.finderOtherFilters.filter((x): x is string => typeof x === 'string' && p.finderOtherFilters.includes(x))
        const ids = str(saved.productIds, 4000); if (ids !== null) invite.productIds = ids
        const sc = str(saved.script, p.scriptMaxLen); if (sc !== null) invite.script = sc
        if (saved.scriptMode === 'ai' || saved.scriptMode === 'manual') invite.scriptMode = saved.scriptMode
        // 不再恢复 productCount：面板已去掉该输入项，商品固定按 ID 指定（留空则加 1 个）
      }
    }
  } catch { /* 读不到就按默认值走，不阻塞面板 */ }
  inviteCfgLoaded.add(key)
}

let inviteSaveTimer: ReturnType<typeof setTimeout> | null = null
watch(invite, () => {
  const p = inviteProfile.value
  if (!p || !inviteCfgLoaded.has(p.platform)) return
  if (inviteSaveTimer) clearTimeout(inviteSaveTimer)
  // 防抖 500ms：打字/连点等级时不要每敲一键就写一次库
  inviteSaveTimer = setTimeout(() => {
    const cur = inviteProfile.value
    if (!cur || cur.platform !== p.platform) return
    const snapshot: Record<string, unknown> = {}
    for (const f of inviteCfgFields(cur.flow)) snapshot[f] = (invite as any)[f]
    // 必须转纯对象再过 IPC：快照里的 levels/benefits 是 Vue 响应式 Proxy，
    // Electron 结构化克隆不认（真机实测抛 "An object could not be cloned"，写入静默失败）
    void window.shopilot.settings.set(INVITE_CFG_KEY(cur.platform), JSON.parse(JSON.stringify(snapshot)))
  }, 500)
}, { deep: true })

/** 指定的商品 ID 列表（逗号/空格/分号/换行分隔；去重、保序） */
const inviteProducts = computed(() => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of invite.productIds.split(/[\s,，;；]+/)) {
    const id = raw.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id.slice(0, 40))
  }
  return out
})

/** AI 是否可用（接口地址/模型名有值 + 主进程已存 Key）——AI 模式下用它当"开始邀约"的前置条件 */
const aiReady = computed(() => !!aiConfig.value.endpoint && !!aiConfig.value.model && aiConfig.value.hasKey)

const inviteReady = computed(() => {
  const p = inviteProfile.value
  if (!p || !ws.displayedStoreId) return false
  const scriptOk = invite.scriptMode === 'ai' ? aiReady.value : invite.script.trim().length > 0
  // 微信小店：联系人、微信号、手机号**都要填**（用户明确要求；平台也会因缺项拦下提交）
  // 商品：固定按商品 ID 指定（留空则由引擎自动加 1 个，页面已有则不动）；只约束 ID 数量上限
  if (p.flow === 'assist-form') {
    const ids = inviteProducts.value
    return scriptOk &&
      invite.contact.trim().length > 0 &&
      invite.wechat.trim().length > 0 &&
      invite.phone.trim().length > 0 &&
      ids.length <= 30
  }
  // 批量流：等级（快手没有这一维 → 档案 levels 为空，不要求）与数量必须合法，话术就绪。
  // 快手另外要求抽屉里的联系方式必填（平台会拦），所以也在开跑前就要求填好——
  // 免得跑起来了才在抽屉那一步失败（那时已经勾了一批人、白跑）。
  const levelsOk = p.levels.length === 0 || invite.levels.length > 0
  const contactsOk = !p.contactSelectors ||
    invite.batchContact.trim().length > 0
  return levelsOk &&
    contactsOk &&
    invite.count >= 1 && invite.count <= p.maxBatch &&
    scriptOk
})

/** 打开达人广场：抖店直接导航；微信按面板里保存的类型/类目/其他筛选自动应用后，再由用户人工进详情页 */
async function openInvitePage() {
  const p = inviteProfile.value
  if (!p) return
  const url = squareUrlFor(p.platform)
  if (p.flow === 'assist-form') {
    try {
      // 必须转成**纯数组**再过 IPC：finderCategories/otherFilters 是 Vue 响应式数组（Proxy），
      // Electron 结构化克隆不认，会抛 "An object could not be cloned"，
      // 结果是点了按钮什么都不发生、也没有任何提示（真机实测踩过，与配置持久化同一个坑）
      const res = await window.shopilot.browser.prepareInviteSquare(ws.displayedStoreId!, {
        url,
        finderType: invite.finderType,
        categories: JSON.parse(JSON.stringify(invite.finderCategories)),
        otherFilters: JSON.parse(JSON.stringify(invite.finderOtherFilters))
      })
      if (!res.ok) {
        ws.toast('打开达人广场失败: ' + res.error.message, 'error')
      } else {
        const applied: any = (res.data || {})
        // 如实回报每一项筛选的落点：平台改版导致某项点不中时，用户要能立刻看出来
        const bad: string[] = []
        if (applied.finderType && applied.finderType.ok === false) bad.push(`类型「${applied.finderType.name}」`)
        for (const c of (applied.categories || [])) if (c.ok === false) bad.push(`类目「${c.name}」`)
        for (const f of (applied.otherFilters || [])) if (f.ok === false) bad.push(`其他「${f.name}」`)
        if (bad.length) ws.toast(`达人广场已打开，但这些筛选没选上：${bad.join('、')}`, 'error')
        else ws.toast('达人广场已打开并应用筛选', 'success')
      }
    } catch (e: any) {
      // 绝不静默：处理函数里任何异常都要让用户看见（此前这个异常被吞掉，表现为"点了没反应"）
      ws.toast('打开达人广场失败: ' + String(e?.message || e), 'error')
    }
  } else if (p.platform === '抖店' && p.categoryDepth === 3 && ws.activeTab) {
    try {
      const res = await window.shopilot.browser.prepareInviteSquare(ws.displayedStoreId!, {
        url,
        loadCategoryTree: true
      })
      if (!res.ok) {
        ws.toast('打开达人广场/读取三级类目失败: ' + res.error.message, 'error')
        return
      }
      const tree = (res.data as any)?.categoryTree as CategoryNode[] | undefined
      if (tree?.length) {
        await saveInviteCategoryTree(p.platform, tree)
        // 首次读取完成后重新合并该平台存档，让已保存的三级类目恢复出来。
        await loadInviteConfig(p)
        ws.toast(`达人广场已打开，已读取 ${tree.length} 个一级类目的完整三级结构`, 'success')
      } else {
        ws.toast('达人广场已打开，但平台未返回三级类目', 'info')
      }
    } catch (e: any) {
      ws.toast('打开达人广场/读取三级类目失败: ' + String(e?.message || e), 'error')
    }
  } else {
    ws.navigate(url)
  }
}

/**
 * 步骤序列构造已下沉到 shared/invite-steps.ts（渲染层与单测共用，平台流程相互独立）。
 * 这里只负责把面板配置收拢成对应流程的 options。
 */
/** 当前店铺是否有邀约任务在途（排队/运行/等确认/暂停）：有则面板显示「停止邀约」并禁用「开始」 */
const ACTIVE_RUN_STATES = ['queued', 'running', 'waiting_confirmation', 'paused']
const inviteRun = computed(() => {
  const sid = ws.displayedStoreId
  if (!sid) return null
  for (const t of ws.tasks) {
    if (t.storeScope !== sid || !t.name.startsWith('达人邀约 ·')) continue
    const run = t.latestRun
    if (!run) continue
    const st = ws.runLive[run.id]?.status || run.status
    if (ACTIVE_RUN_STATES.includes(st)) return { taskId: t.id, runId: run.id, status: st }
  }
  return null
})

async function stopInvite() {
  const run = inviteRun.value
  if (!run) return
  const res = await window.shopilot.task.cancel(run.runId)
  if (res.ok) ws.toast('已请求停止邀约，运行将尽快取消', 'info')
  else ws.toast('停止邀约失败: ' + res.error.message, 'error')
  await ws.refreshTasks()
}

/**
 * 由**邀约面板当前的配置**构造一个邀约任务的载荷（名称 + 步骤）。
 *
 * 为什么抽出来：邀约面板的「开始邀约」与「任务列表 → 新建任务 → 达人邀约」必须是**同一份**
 * 步骤构造——两处各写一遍必然漂移（引擎那边改了步骤，漏改一处就会出现"从这个入口建的能跑、
 * 从那个入口建的跑不了"）。所以两边共用这一个函数。
 *
 * 返回 null 表示当前不可建（平台不支持 / 配置没填齐），调用方负责提示原因。
 */
function buildInviteTaskPayload(): { name: string; storeScope: string; steps: unknown[] } | null {
  const p = inviteProfile.value
  if (!p || !ws.displayedStoreId || !inviteReady.value) return null
  const squareUrl = squareUrlFor(p.platform)
  const steps = p.flow === 'batch-list'
    ? buildInviteSteps(p, {
        batch: {
          category: invite.category, subcategory: invite.subcategory, category3: invite.category3,
          levels: invite.levels, count: invite.count,
          script: invite.script, scriptMode: invite.scriptMode, benefits: invite.benefits,
          // 快手：额外筛选行 / 抽屉必填联系方式 / 邀约商品数（抖店没有这些字段 → 传空即不生效）
          extraFilters: JSON.parse(JSON.stringify(invite.extraFilters)),
          contacts: p.contactSelectors
            ? [
                { selector: p.contactSelectors.contact, text: invite.batchContact.trim() },
                ...(p.contactSelectors.phone ? [{ selector: p.contactSelectors.phone, text: invite.batchPhone.trim() }] : []),
                ...(p.contactSelectors.wechat ? [{ selector: p.contactSelectors.wechat, text: invite.batchWechat.trim() }] : [])
              ].filter(c => c.text)
            : [],
          productCount: invite.batchProductCount
        }
      }, squareUrl)
    : buildInviteSteps(p, {
        assist: {
          contact: invite.contact, wechat: invite.wechat, phone: invite.phone,
          script: invite.script, scriptMode: invite.scriptMode,
          // 面板已去掉「添加商品数量」；留空 productIds 时引擎按 1 个自动添加（页面已有则不动）
          productCount: 1,
          productIds: inviteProducts.value,
          finderType: invite.finderType,
          finderCategories: invite.finderCategories,
          finderOtherFilters: invite.finderOtherFilters
        }
      }, squareUrl)
  const name = p.flow === 'batch-list'
    ? `达人邀约 · ${p.platform} · ${
        invite.category
          ? invite.category +
            (invite.subcategory ? '/' + invite.subcategory : '') +
            (invite.subcategory && invite.category3 ? '/' + invite.category3 : '')
          : '全部'
      } · 最多 ${invite.count} 位`
    : `达人邀约 · ${p.platform} · 辅助填单 · ${invite.contact.trim() || '未命名'}`
  return { name, storeScope: ws.displayedStoreId, steps }
}

async function startInvite() {
  const p = inviteProfile.value
  if (!p || !inviteReady.value) return
  const payload = buildInviteTaskPayload()
  if (!payload) { ws.toast('邀约配置不完整，无法创建任务', 'error'); return }
  const created = await window.shopilot.task.create(payload)
  if (!created.ok) { ws.toast('创建邀约任务失败: ' + created.error.message, 'error'); return }
  const started = await window.shopilot.task.run(created.data.id)
  if (!started.ok) { ws.toast('启动邀约任务失败: ' + started.error.message, 'error'); return }
  ws.toast(p.flow === 'batch-list'
    ? '邀约任务已启动：每批发送前都会暂停等待人工确认，直到额度用完或可选达人不足'
    : '邀约任务已启动：点「发送」前会先停下让你确认', 'success')
  // 留在邀约面板：进行中状态与「停止邀约」按钮就地可见（任务详情在「任务列表」页签可查）
  await ws.refreshTasks()
}

/**
 * 「新建任务」= **从已实现的流程里挑一个建**（当前只有「达人邀约」）。
 *
 * 为什么不给底层步骤编辑器：引擎的步骤类型有 20 多种，让用户自己拼 navigate/readTable/click…
 * 必然拼出跑不通的半成品（选择器写不对、少了必要的等待、提交类动作漏了确认门禁），
 * 而失败会以"任务失败"的形式回抛——用户无从对应到"我少填了哪个字段"。
 * 每个**已实测跑通的流程**都有自己的参数表单与内置门禁，从这儿建出来的任务是"能跑的"。
 *
 * 【0.4.37 变更】上面这条限制按用户要求放开了：新增「自定义任务」，用户可自己编排步骤。
 * 放开的同时把当初的理由逐条堵上（参数按目录渲染、副作用步骤必须标记"提交动作"、
 * 标记后强制前置人工确认门禁），详见 @shared/custom-task 的模块注释。
 * **流程入口仍然保留且是默认项**——"能跑的"这条价值没变，自定义只是多一条出路。
 *
 * 新增流程 = 在这里加一条（label/描述/是否可用/建法），面板结构不用动。
 */
type TaskFlowKey = 'invite' | 'custom'
const taskFlow = ref<TaskFlowKey>('invite')

/** 「新建任务」的定时输入（唯一还需要用户填的字段——其余参数都取自各流程自己的面板配置） */
const tf = reactive({ everyMin: null as number | null })

// ---------- 自定义任务（步骤编排） ----------
/** 编排中的步骤草稿（submit/retryLimit 是编排器元数据，不进引擎，见 toEngineSteps） */
const customSteps = ref<CustomStepDraft[]>([])
const customTaskName = ref('')

/**
 * 创建前校验结果。
 * 放在父组件算而不是编辑器组件内部算：创建按钮的可用性依赖它，
 * 两处各算一遍会出现"按钮可点、点了却被拒"这种最让人困惑的组合。
 */
const customIssues = computed<CustomStepIssue[]>(() => validateCustomSteps(customSteps.value))
const customReady = computed(() => !!ws.displayedStoreId && !hasBlockingIssues(customIssues.value))

const taskFlowOptions = computed(() => {
  const p = inviteProfile.value
  const openStore = !!ws.displayedStoreId
  // 「能建」= 档案存在 + 已打开店铺 + 面板配置填齐（与「开始邀约」同一套判据 inviteReady）。
  // 不用 inviteReady 直接当 ready 的原因是还要区分"没打开店铺"和"配置没填齐"两种阻断，
  // 好把原因说清楚（一句"配置不完整"用户不知道该去哪儿补）。
  const ready = !!p && openStore && inviteReady.value
  return [
    {
      key: 'invite' as TaskFlowKey,
      label: '达人邀约',
      desc: p
        ? `${p.platform} · ${p.flow === 'batch-list' ? '广场筛选后批量邀约' : '逐个达人邀约'}`
        : '当前店铺的平台暂不支持达人邀约',
      ready,
      // 不可用时说清到底缺什么，别让用户点完才发现建不了
      needs: !openStore
        ? '请先打开一个店铺（任务要绑定店铺执行）'
        : (!p
            ? `平台「${(ws.stores.find(s => s.id === ws.displayedStoreId)?.platform) || '未知'}」尚未实现达人邀约`
            : '邀约参数还没填齐——请到「达人邀约」页签补齐必填项（联系方式 / 话术 / 商品等），再回来创建')
    },
    {
      key: 'custom' as TaskFlowKey,
      label: '自定义任务',
      desc: '自己编排步骤（导航 / 等待 / 读取 / 交互 / 断言 / 门禁）',
      /**
       * 这里的 ready 只表示"这个流程能不能用"（= 有没有打开店铺），**不含**"步骤编好了没"。
       *
       * 为什么与邀约流程不同：邀约的参数在**另一个页签**里填，所以"没填齐"必须在下拉里就说清，
       * 否则用户不知道该去哪儿补。自定义任务的步骤就在这个对话框里编，此时标成"（不可用）"
       * 读起来像"这个功能用不了"，会把人挡在门外——而它其实点进去就能用。
       * "步骤还没编好"由编辑器下方的校验清单 + 创建按钮置灰来表达（见 submitDisabled）。
       */
      ready: openStore,
      needs: !openStore
        ? '请先打开一个店铺（任务要绑定店铺执行）'
        : (customIssues.value.find(i => i.level === 'error')?.message || '')
    }
  ]
})
const taskFlowCurrent = computed(() => taskFlowOptions.value.find(f => f.key === taskFlow.value) || taskFlowOptions.value[0])

/**
 * 「创建任务」是否置灰。
 * 自定义流程要单独判：它的 ready 只到"流程可用"，真正的可创建性取决于步骤校验。
 */
const submitDisabled = computed(() => (
  taskFlow.value === 'custom' ? !customReady.value : !taskFlowCurrent.value?.ready
))

/** 置灰原因（挂在按钮 title 上，鼠标悬停能看到到底缺什么） */
const submitDisabledReason = computed(() => {
  if (!submitDisabled.value) return ''
  if (taskFlow.value === 'custom') {
    if (!ws.displayedStoreId) return '请先打开一个店铺（任务要绑定店铺执行）'
    return customIssues.value.find(i => i.level === 'error')?.message || '步骤编排里还有问题未解决'
  }
  return taskFlowCurrent.value?.needs || ''
})

const taskDialogOpen = ref(false)

function openTaskDialog() {
  taskFlow.value = 'invite'
  tf.everyMin = null
  taskDialogOpen.value = true
}

async function submitTask() {
  if (taskFlow.value === 'custom') return submitCustomTask()
  if (taskFlow.value !== 'invite') { ws.toast('该流程尚未实现', 'error'); return }
  const payload = buildInviteTaskPayload()
  if (!payload) {
    // 说清到底缺什么，而不是一句"配置不完整"
    const p = inviteProfile.value
    if (!ws.displayedStoreId) ws.toast('请先打开一个店铺（任务要绑定店铺执行）', 'error')
    else if (!p) ws.toast('当前店铺的平台未实现达人邀约', 'error')
    else ws.toast('邀约配置不完整：请到「达人邀约」页签补齐必填项（联系方式/话术/商品等）', 'error')
    return
  }
  // 用面板里配置好的名称（与「开始邀约」建的完全一致），定时由这里补
  const res = await window.shopilot.task.create({
    ...payload,
    schedule: tf.everyMin ? { everyMs: Math.max(1, Number(tf.everyMin)) * 60000 } : null
  })
  if (res.ok) {
    taskDialogOpen.value = false
    ws.toast('任务已创建，可在列表里点 ▶ 运行', 'success')
    await ws.refreshTasks()
  } else ws.toast('创建失败: ' + res.error.message, 'error')
}

/**
 * 创建自定义任务。
 *
 * 提交前**再校验一次**（而不是只信按钮的 disabled）：按钮状态是渲染期的产物，
 * 用户可能在两次校验之间改了步骤（例如删掉了那道确认门禁）。
 * 这是"提交类动作必须有前置门禁"这条约束真正生效的地方。
 */
async function submitCustomTask() {
  if (!ws.displayedStoreId) { ws.toast('请先打开一个店铺（任务要绑定店铺执行）', 'error'); return }

  const issues = validateCustomSteps(customSteps.value)
  const blocking = issues.filter(i => i.level === 'error')
  if (blocking.length) {
    ws.toast(`还有 ${blocking.length} 处需要修正：${blocking[0].message}`, 'error')
    return
  }

  const name = customTaskName.value.trim() || `自定义任务 · ${new Date().toLocaleString()}`
  const res = await window.shopilot.task.create({
    name,
    storeScope: ws.displayedStoreId,
    steps: toEngineSteps(customSteps.value),
    schedule: tf.everyMin ? { everyMs: Math.max(1, Number(tf.everyMin)) * 60000 } : null
  })
  if (res.ok) {
    // 创建成功后清掉草稿：任务已经进列表了，把同一份步骤继续留在对话框里
    // 只会让下一次「新建任务」看起来像填好的、一点就建出个同名重复任务
    // （验收实测：创建并删掉后重开，上一条的 3 步连同任务名还都在）。
    // 取消不走这里——那是"还没建"，草稿留着是有用的。
    customSteps.value = []
    customTaskName.value = ''
    taskDialogOpen.value = false
    ws.toast('任务已创建，可在列表里点 ▶ 运行', 'success')
    await ws.refreshTasks()
  } else {
    // 走到这里说明主进程的 Zod 拒了（本模块的校验已放行）——如实报出来，
    // 那意味着目录与引擎 schema 出现了漂移，是需要修的 bug，不该被含糊成"创建失败"
    ws.toast('创建失败: ' + res.error.message, 'error')
  }
}

async function runTask(t: any) {
  if (isTaskActive(t)) {
    ws.toast('当前运行未结束，不能重复启动；请先等待、恢复或取消', 'info')
    return
  }
  const res = await window.shopilot.task.run(t.id)
  if (res.ok) {
    // 店铺窗口没开时引擎会把运行保持 queued（不静默拉起）——如实告诉用户，别让他干等
    ws.toast(res.data?.waitingForStore ? '任务已排队：店铺浏览器打开后自动开始' : '任务已入队开始', 'success')
    await ws.refreshTasks()
    const fresh = ws.tasks.find(x => x.id === t.id)
    if (fresh) await loadTaskDetail(fresh)
  } else ws.toast('运行失败: ' + res.error.message, 'error')
}

const detailTaskId = ref<string | null>(null)
const detailData = reactive<Record<string, any>>({})

function storeName(id: string | null) {
  if (!id) return '未绑定店铺'
  const s = ws.stores.find(x => x.id === id)
  return s ? s.name : '店铺'
}
function statusLabel(st: string) {
  return ({ queued: '排队中', running: '运行中', waiting_confirmation: '等待确认', paused: '已暂停', succeeded: '已成功', failed: '已失败', cancelled: '已取消' } as any)[st] || st
}
function liveStatus(t: any): string {
  const rid = t.latestRun?.id
  return (rid && ws.runLive[rid]?.status) || t.latestRun?.status || ''
}
function isTaskActive(t: any): boolean {
  const persisted = t.latestRun?.status || ''
  if (['succeeded', 'failed', 'cancelled'].includes(persisted)) return false
  return ['queued', 'running', 'waiting_confirmation', 'paused'].includes(persisted) ||
    ['queued', 'running', 'waiting_confirmation', 'paused'].includes(liveStatus(t))
}
function liveMessage(t: any): string {
  const rid = t.latestRun?.id
  if (rid && ws.runLive[rid]?.message) return ws.runLive[rid].message
  return t.latestRun?.statusReason || t.latestRun?.errorMessage || ''
}
function detailRunId(t: any): string | null { return t.latestRun?.id || null }
function resultOf(t: any, i: number) {
  const d = detailData[t.id]
  return d?.results?.find((r: any) => r.stepIndex === i) || null
}
function stepIcon(t: any, i: number): string {
  if (resultOf(t, i)) return '✅'
  const st = liveStatus(t)
  const live = t.latestRun ? ws.runLive[t.latestRun.id] : null
  const at = live?.stepIndex ?? t.latestRun?.currentStep
  if (st === 'failed' && at === i) return '❌'
  if ((st === 'running' || st === 'waiting_confirmation') && at === i) return '⏳'
  if (st === 'paused' && at === i) return '⏸'
  if (st === 'queued') return '·'
  return '·'
}
function stepInputBrief(s: any): string {
  const p = s.input || {}
  if (s.type === 'navigate') return String(p.url || '').slice(0, 48)
  if (s.type === 'fillDraft') return `${p.selector || ''} · ${String(p.text || '').length} 字符`
  if (p.selector) return String(p.selector) + (p.metric ? ` → ${p.metric}` : '')
  if (p.message) return String(p.message).slice(0, 48)
  if (p.urlIncludes) return String(p.urlIncludes)
  return ''
}
function stepResultBrief(t: any, i: number): string {
  const r = resultOf(t, i)
  return r ? String(r.summary || r.kind).slice(0, 60) : ''
}

/**
 * 邀约循环的"换人"明细：把 loop.payload.rounds 里的恢复记录汇总成一行。
 *
 * 为什么需要它（真机实测的缺口）：逐位邀约时引擎会**跳过**两类不能邀约的达人
 * （不达合作门槛 / 7 天内已邀约过），这些位不会出现在任何步骤成功里。用户只看
 * "本次邀约 N 位"根本分不清"跳过了 3 位"和"平台不给发了"——而这两件事的处置完全不同。
 * 这里如实把跳过数说出来，并把最后为什么停下也带出来。
 */
function loopSkipSummary(t: any): string {
  const d = detailData[t.id]
  const loop = (d?.results || []).map((r: any) => {
    try { return typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload || {}) } catch { return {} }
  }).find((p: any) => p.action === 'loop')
  if (!loop) return ''
  const rounds: any[] = Array.isArray(loop.rounds) ? loop.rounds : []
  const skipped = rounds.reduce((n, r) => n + (Array.isArray(r.recovered) ? r.recovered.filter((m: string) => /跳过这一位|跳过并重开本轮/.test(String(m))).length : 0), 0)
  const parts = [`成功邀约 ${loop.completedRounds ?? 0} 位`]
  if (skipped) parts.push(`跳过 ${skipped} 位（不达合作门槛 / 7 天内已邀约过）`)
  // 部分成功：loop 中途失败时已完成的那几轮是**真实发出去了**的，必须与"整批失败"区分开。
  // completedRounds=0 时不写这句（"已完成的 0 位"读起来像废话）。
  if (loop.failedRound) {
    parts.push(loop.completedRounds > 0
      ? `第 ${loop.failedRound} 轮失败——已完成的 ${loop.completedRounds} 位是真发出去了的`
      : `第 ${loop.failedRound} 轮失败，没有发出任何邀约`)
  } else if (loop.stopReason) parts.push(`因「${loop.stopReason}」正常收尾`)
  return parts.join(' · ')
}

async function toggleTaskDetail(t: any) {
  if (detailTaskId.value === t.id) { detailTaskId.value = null; return }
  detailTaskId.value = t.id
  await loadTaskDetail(t)
}
async function loadTaskDetail(t: any) {
  if (!t.latestRun?.id) { delete detailData[t.id]; return }
  const res = await window.shopilot.task.results(t.latestRun.id)
  if (res.ok) detailData[t.id] = res.data
  else delete detailData[t.id]
}

async function delTask(id: string) {
  if (!window.confirm('删除该任务？其运行记录与结果引用将一并级联删除。')) return
  const task = ws.tasks.find(t => t.id === id)
  const res = await window.shopilot.task.delete(id)
  if (!res.ok) {
    ws.toast('删除失败: ' + res.error.message, 'error')
    return
  }
  if (task?.latestRun?.id) ws.clearConfirmation(task.latestRun.id)
  if (detailTaskId.value === id) detailTaskId.value = null
  ws.refreshTasks()
}

async function runOp(t: any, action: 'pause' | 'resume' | 'retry' | 'cancel') {
  const rid = t.latestRun?.id
  if (!rid) return
  const api = window.shopilot.task
  let res: any
  if (action === 'pause') res = await api.pause(rid)
  else if (action === 'resume') res = await api.resume(rid)
  else if (action === 'retry') res = await api.resume(rid, 'retry')
  else res = await api.cancel(rid)
  if (!res.ok) ws.toast('操作失败: ' + res.error.message, 'error')
  else if (action === 'cancel') ws.clearConfirmation(rid)
  setTimeout(() => ws.refreshTasks(), 400)
}

async function confirmRun(runId: string, approved: boolean) {
  const res = await window.shopilot.task.confirm(runId, approved)
  if (!res.ok) ws.toast('确认失败: ' + res.error.message, 'error')
  ws.clearConfirmation(runId)
  setTimeout(() => ws.refreshTasks(), 400)
}

async function onCapture() {
  if (!ws.activeTab || !ws.displayedStoreId) return
  const res = await window.shopilot.browser.capture(ws.displayedStoreId, ws.activeTab.id, 'png')
  if (res.ok) {
    const a = document.createElement('a')
    a.href = 'data:image/png;base64,' + res.data.data
    a.download = `capture-${Date.now()}.png`
    a.click()
    ws.toast('已截图并保存', 'success')
  } else ws.toast('截图失败: ' + res.error.message, 'error')
}

/**
 * 右侧栏收起/展开（用户要求"右侧边栏可以收起"）。
 * 收起后留 44px 窄轨：图标=各面板，点一下即展开并回到该面板；状态写入 app_settings 持久化。
 * 两条不变量：① 有待处理的人工确认时**不允许收起**（否则门禁提示被藏起来，任务看起来又"卡住"）；
 * ② 收起状态下若来了新的确认请求，自动临时展开并提示（不改用户偏好）。
 */
const panelTabs = [
  { key: 'bookmarks', label: '收藏', icon: '★' },
  { key: 'downloads', label: '下载', icon: '↓' },
  { key: 'env', label: '环境', icon: '⚙' },
  { key: 'tasks', label: '任务', icon: '☑' }
] as Array<{ key: 'bookmarks' | 'downloads' | 'env' | 'tasks'; label: string; icon: string }>

const rightPanelCollapsed = ref(false)
// 注意：ws.confirmations 是 Record<runId, item>（对象），不是数组 —— 用 .length 会恒为 undefined，
// 导致"待确认时禁止收起"与"来新确认自动展开"两条守卫静默失效（M3 断言当场抓到）。
const confirmationCount = computed(() => Object.keys(ws.confirmations || {}).length)

/** 中栏宽度变了 → 立刻上报原生视图 bounds（ResizeObserver 之外再兜一次，避免慢一帧） */
function syncViewportSoon() {
  nextTick(() => {
    reportViewport()
    requestAnimationFrame(reportViewport)
    setTimeout(reportViewport, 80)
    setTimeout(reportViewport, 250)
  })
}

function collapsePanel() {
  if (confirmationCount.value > 0) {
    ws.toast('有待处理的人工确认，处理后才能收起右侧栏', 'info')
    return
  }
  rightPanelCollapsed.value = true
  window.shopilot.settings.set('ui.rightPanelCollapsed', true).catch(() => {})
  syncViewportSoon()
}

function expandPanel(p?: 'bookmarks' | 'downloads' | 'env' | 'tasks') {
  rightPanelCollapsed.value = false
  if (p) switchPanel(p)
  window.shopilot.settings.set('ui.rightPanelCollapsed', false).catch(() => {})
  syncViewportSoon()
}

function togglePanel() {
  if (rightPanelCollapsed.value) expandPanel()
  else collapsePanel()
}

/**
 * 左栏收起/展开（用户要求"左侧边栏可以收起和展开"），与右栏同一套约定：
 * 收起留 44px 窄轨（新建/回收站/更新仍可达），状态写入 app_settings 持久化，Ctrl+Shift+E 切换。
 * 与右栏不同：左栏不设门禁——人工确认门禁提示在右栏，收起左栏不会藏住它。
 */
const leftSidebarCollapsed = ref(false)

function collapseSidebar() {
  leftSidebarCollapsed.value = true
  window.shopilot.settings.set('ui.leftSidebarCollapsed', true).catch(() => {})
  syncViewportSoon()
}

function expandSidebar() {
  leftSidebarCollapsed.value = false
  window.shopilot.settings.set('ui.leftSidebarCollapsed', false).catch(() => {})
  syncViewportSoon()
}

function toggleSidebar() {
  if (leftSidebarCollapsed.value) expandSidebar()
  else collapseSidebar()
}

watch(confirmationCount, (n) => {
  if (n > 0 && rightPanelCollapsed.value) {
    rightPanelCollapsed.value = false
    ws.toast('任务需要人工确认，已临时展开右侧栏', 'info')
    syncViewportSoon()
  }
})

function switchPanel(p: 'bookmarks' | 'downloads' | 'env' | 'tasks') {
  ws.rightPanel = p
  if (p === 'downloads') ws.refreshDownloads()
  else if (p === 'env') { refreshEnv(); refreshCookies() }
  else if (p === 'tasks') ws.refreshTasks()
  else { ws.refreshBookmarks(); refreshEntryRoutes() }
}

/**
 * 平台入口（§16）：按当前店铺的平台取内置适配器入口，只读展示不入库。
 * 目前平台为国内四家（拼多多/微信小店/快手小店/抖店），非内置平台返回空列表 → 不显示该段。
 */
const entryRoutes = ref<any[]>([])
const displayedPlatformName = computed(() => ws.stores.find(s => s.id === ws.displayedStoreId)?.platform || '')

async function refreshEntryRoutes() {
  const sid = ws.displayedStoreId
  if (!sid) { entryRoutes.value = []; return }
  const res = await window.shopilot.bookmark.entryRoutes(sid)
  entryRoutes.value = res && res.ok ? (res.data.routes || []) : []
}

/**
 * 店铺右键菜单：使用应用内菜单，并纳入弹层遮挡处理（店铺页面是原生层，会盖住 HTML 菜单）。
 */
const ctx = reactive({ open: false, x: 0, y: 0, store: null as StoreRow | null })
const otherStores = computed(() => ws.stores.filter(s => s.id !== ctx.store?.id))
const ctxStandalone = computed(() =>
  !!ctx.store && isOpen(ctx.store.id) && ws.displayedStoreId === ctx.store.id && !!ws.activeTab
)

function onStoreContext(s: StoreRow, ev?: MouseEvent) {
  ctx.store = s
  // 菜单尺寸按内容估算后夹在窗口内，避免靠边右键时菜单跑出屏幕
  const w = 250, h = 300
  const x = ev ? ev.clientX : 60
  const y = ev ? ev.clientY : 60
  ctx.x = Math.max(8, Math.min(x, window.innerWidth - w - 8))
  ctx.y = Math.max(8, Math.min(y, window.innerHeight - h - 8))
  ctx.open = true
}

function closeCtx() { ctx.open = false }
function onDocMouseDown(ev: MouseEvent) {
  if (!ctx.open) return
  const el = ev.target as HTMLElement | null
  if (el && el.closest && el.closest('[data-test="store-ctx"]')) return
  closeCtx()
}
function onDocKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape') closeCtx()
  // Ctrl+Shift+B：收起/展开右侧栏（与 Ctrl+Shift+L 锁定同一套快捷键约定）
  if (ev.ctrlKey && ev.shiftKey && (ev.key === 'B' || ev.key === 'b')) { ev.preventDefault(); togglePanel() }
  // Ctrl+Shift+E：收起/展开左侧栏
  if (ev.ctrlKey && ev.shiftKey && (ev.key === 'E' || ev.key === 'e')) { ev.preventDefault(); toggleSidebar() }
}

const rename = reactive({ open: false, value: '' })
const copycfg = reactive({ open: false, sourceId: '', sourceName: '', targets: [] as string[] })
const confirmBox = reactive({ open: false, title: '', message: '', onOk: null as null | (() => void | Promise<void>) })

async function ctxAction(kind: 'toggle' | 'standalone' | 'rename' | 'copycfg' | 'copyid' | 'trash') {
  const s = ctx.store
  if (!s) return
  closeCtx()
  if (kind === 'toggle') { await toggleStore(s.id); return }
  if (kind === 'standalone') {
    const tab = ws.activeTab
    if (!tab) { ws.toast('没有可打开的标签页', 'info'); return }
    const res = await window.shopilot.browser.openWindow(s.id, tab.id)
    ws.toast(res.ok ? '已在独立窗口打开' : '打开失败: ' + res.error.message, res.ok ? 'success' : 'error')
    return
  }
  if (kind === 'rename') { rename.value = s.name; rename.open = true; return }
  if (kind === 'copycfg') { copycfg.sourceId = s.id; copycfg.sourceName = s.name; copycfg.targets = []; copycfg.open = true; return }
  if (kind === 'copyid') {
    try {
      await navigator.clipboard.writeText(s.id)
      ws.toast('已复制店铺 ID', 'success')
    } catch {
      ws.toast('复制失败：' + s.id, 'info')
    }
    return
  }
  if (kind === 'trash') {
    confirmBox.title = '移入回收站'
    confirmBox.message = `「${s.name}」将移入回收站，会话与环境配置保留，可在回收站恢复或彻底删除。`
    confirmBox.onOk = async () => { await ws.moveToTrash(s.id) }
    confirmBox.open = true
  }
}

async function runConfirm() {
  const fn = confirmBox.onOk
  confirmBox.open = false
  confirmBox.onOk = null
  if (fn) await fn()
}

async function doRename() {
  const s = ctx.store
  const name = rename.value.trim()
  if (!s || !name) return
  const res = await window.shopilot.store.update({ storeId: s.id, patch: { name } })
  if (res.ok) { rename.open = false; await ws.refreshStores(); ws.toast('已重命名', 'success') }
  else ws.toast('重命名失败: ' + res.error.message, 'error')
}

async function doCopyConfig() {
  const src = copycfg.sourceId
  const targets = [...copycfg.targets]
  if (!src || targets.length === 0) return
  const res = await window.shopilot.profile.copyConfig(src, targets)
  if (res.ok) {
    copycfg.open = false
    await ws.refreshStores()
    const copied = res.data?.copied ?? 0
    const skipped = res.data?.skipped || []
    // 如实回报：跳过（环境已锁定/店铺不存在）绝不写成"成功"
    if (skipped.length) {
      const why = skipped.map((s: any) => s.reason === 'PROFILE_LOCKED' ? '环境已锁定' : '店铺不存在').join('、')
      ws.toast(`已复制 ${copied} 个，跳过 ${skipped.length} 个（${why}）`, copied ? 'info' : 'error')
    } else {
      ws.toast(`已复制环境配置到 ${copied} 个店铺（不含会话与代理凭据）`, 'success')
    }
  } else ws.toast('复制配置失败: ' + res.error.message, 'error')
}

/**
 * 发票中心：抓取并展示各平台后台的**待开票信息**（只读采集）。
 *
 * 数据链路与数据中心一致：采集任务在发票页 readTable(keepRows) → store_snapshots
 * → overview:invoiceCenter 汇总（主进程按实测表头映射成统一列）→ 这里展示。
 * 开票动作仍在平台页面上人工完成，本应用只读取、不代提交。
 */
const invoiceCenterOpen = ref(false)
const invoiceLoading = ref(false)
const invoiceCollecting = ref(false)
/** 工具栏：搜索词 / 只看有数据的 / 行内排序 */
const invoiceQuery = ref('')
const invoiceOnlyWithData = ref(false)
const invoiceSort = ref<'amountDesc' | 'amountAsc' | 'none'>('amountDesc')
/** 按营业执照筛选（'' = 全部；NO_LICENSE_KEY = 未填写那一桶） */
const invoiceLicense = ref('')
const invoice = reactive<{ generatedAt: number | null; columns: Array<{ key: string; label: string }>; rows: any[] }>({
  generatedAt: null,
  columns: [],
  rows: []
})

/** 行内补录营业执照的编辑态（发票中心是发现"这家还没填主体"的第一现场） */
const licenseEditingId = ref<string | null>(null)
const licenseDraft = reactive({ name: '', no: '' })
const licenseSaving = ref(false)
const licenseEditError = ref('')
/** 「获取主体营业执照」：采集进行中 + 逐店结果（填了哪些、哪些不一致、哪些平台取不了） */
const entityCollecting = ref(false)
const entityReport = ref<Array<Record<string, any>>>([])

/**
 * 金额解析：各平台金额是**带符号的字符串**（¥14.89 / ￥9.49 / 2.02 / -），
 * 解析不出数字的（"—"/空）返回 null 并**不计入合计**——绝不把解析失败当 0 加进去。
 */
function parseAmount(v: unknown): number | null {
  const s = cleanCell(v)
  if (!s || s === '—' || s === '-') return null
  const m = /-?[\d,]+(?:\.\d+)?/.exec(s.replace(/[¥￥$€\s]/g, ''))
  if (!m) return null
  const n = Number(m[0].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}
/** 金额显示：合计用两位小数 + 千分位；货币符号按出现过的样式挑一个 */
function fmtAmount(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * 各店铺的发票行（**未按营业执照筛选**，只有搜索与行内排序）。
 * 单独留这一份是因为「按营业执照」的合计要对每个主体各算一份：
 * 若在筛选后的结果上算，一点某个主体，别的主体的数字全变 0，就没法横向比了。
 */
const invoiceAllRows = computed(() => {
  const cat = (window.shopilot.platforms || []) as Array<PlatformDef>
  const byStore = new Map(invoice.rows.map((r: any) => [r.storeId, r]))
  const q = invoiceQuery.value.trim().toLowerCase()
  const sortItems = (items: any[]) => {
    if (invoiceSort.value === 'none' || items.length < 2) return items
    const dir = invoiceSort.value === 'amountDesc' ? -1 : 1
    const parsed = items.map((it: any) => parseAmount(it.cells?.amount))
    const idx = items.map((_, i) => i)
    idx.sort((a, b) => {
      const pa = parsed[a], pb = parsed[b]
      if (pa == null && pb == null) return 0
      if (pa == null) return 1
      if (pb == null) return -1
      return (pa - pb) * dir
    })
    return idx.map(i => items[i])
  }
  // 行内搜索：店铺/平台/方向 命中则整组保留；否则只留命中的行
  const filterSections = (storeName: string, platform: string, sections: any[]) => {
    if (!q) return sections.map(sec => ({ ...sec, items: sortItems(sec.items) }))
    const storeHit = (storeName + ' ' + platform).toLowerCase().includes(q)
    return sections.map(sec => {
      if (storeHit || sec.name.toLowerCase().includes(q)) return { ...sec, items: sortItems(sec.items) }
      const items = sec.items.filter((it: any) => {
        const text = [
          ...Object.values(it.cells || {}),
          ...(it.extras || []).map((x: any) => `${x.label} ${x.value}`)
        ].map(v => cleanCell(v)).join(' ').toLowerCase()
        return text.includes(q)
      })
      return { ...sec, items: sortItems(items) }
    })
  }
  return ws.stores.map(s => {
    const got: any = byStore.get(s.id) || {}
    const sections = Array.isArray(got.sections) ? got.sections : []
    const visible = filterSections(s.name, s.platform, sections)
    // 主进程也回了营业执照，但这里以**渲染层这份店铺列表**为准：
    // 行内刚改完主体要立刻生效，不能等下一次「刷新」把发票数据重新拉一遍。
    const lic = { licenseName: s.licenseName ?? got.licenseName ?? null, licenseNo: s.licenseNo ?? got.licenseNo ?? null }
    return {
      storeId: s.id,
      storeName: s.name,
      platform: s.platform,
      licenseName: lic.licenseName,
      licenseNo: lic.licenseNo,
      licenseLabel: licenseLabelOf(lic),
      // 平台自己说这个店的主体是谁（采到才有；卡片上如实展示，便于用户核对）
      entity: got.entity || null,
      entitySupported: got.entitySupported === true,
      entityUnsupported: got.entityUnsupported || null,
      color: cat.find(p => p.name === s.platform)?.color || 'var(--color-primary)',
      supported: got.supported !== false,
      unsupportedReason: got.unsupportedReason || '该平台尚未实测到可读取的发票页',
      capturedAt: got.capturedAt || null,
      manual: !!got.manual,
      note: got.note || null,
      lastFail: got.lastFail || null,
      loginRequired: !!got.loginRequired,
      sections: visible,
      // 该店**待办**方向的条数合计（筛选后）；历史方向（pending===false）不算进来，
      // 否则"待开票 N 条"里会混进已办完的记录（实测快手「处理记录」）
      count: visible.reduce((a: number, x: any) => a + (x.pending === false ? 0 : x.items.length), 0),
      // 该店历史方向的条数（界面在卡片角上单独说明，不藏起来）
      historyCount: visible.reduce((a: number, x: any) => a + (x.pending === false ? x.items.length : 0), 0),
      hasExtras: visible.some((x: any) => x.items.some((it: any) => Array.isArray(it.extras) && it.extras.length > 0))
    }
  })
})

/**
 * 按营业执照分组的合计（每个主体各一行：几家店 / 待开票几条 / 可开金额）。
 * 用 `invoiceAllRows` 算——**不受当前营业执照筛选影响**，否则点一个主体，别的全变 0。
 * 金额口径与总合计一致：解析不出的不计入，但条数照数（界面在 chip 上标出未解析的条数）。
 */
const licenseGroups = computed(() => groupStoresByLicense(ws.stores.map(s => ({
  id: s.id, licenseName: s.licenseName ?? null, licenseNo: s.licenseNo ?? null
}))))

const licenseSummary = computed(() => {
  const items = licenseGroups.value.groups.map(l => ({
    ...l, pendingCount: 0, historyCount: 0, amount: 0, unparsed: 0, amountText: '', stores: 0
  }))
  const byKey = new Map(items.map(l => [l.key, l]))
  for (const r of invoiceAllRows.value) {
    const hit = byKey.get(licenseGroups.value.keyByStore.get(r.storeId) || '')
    if (!hit) continue
    // "有几家店"数的是**有待办**的店（和总览的"有待办的店铺"同口径）；店铺归属另由 chip 的 storeCount 显示
    if (r.sections.some((s: any) => s.pending !== false && s.items.length)) hit.stores++
    for (const sec of r.sections) {
      const isPending = sec.pending !== false
      for (const it of sec.items) {
        if (!isPending) { hit.historyCount++; continue }
        hit.pendingCount++
        const a = parseAmount(it.cells?.amount)
        if (a == null) hit.unparsed++
        else hit.amount += a
      }
    }
  }
  const withText = items.map(l => ({ ...l, amountText: l.amount ? '¥' + fmtAmount(l.amount) : '—' }))
  return {
    items: withText,
    storeCount: ws.stores.length,
    pendingCount: withText.reduce((a, l) => a + l.pendingCount, 0),
    amountText: withText.some(l => l.amount) ? '¥' + fmtAmount(withText.reduce((a, l) => a + l.amount, 0)) : '—'
  }
})

/** 选中的主体若已不存在（店铺被删/改了主体）就退回"全部"，避免界面卡在一个空列表上没法退出 */
const activeLicense = computed(() => (
  invoiceLicense.value && licenseSummary.value.items.some(l => l.key === invoiceLicense.value)
    ? invoiceLicense.value
    : ''
))

/** 发票行 = 上面那份（含搜索）再按营业执照筛一道（用统一的归属表，见 shared/store-license.ts） */
const invoiceRows = computed(() => (
  activeLicense.value
    ? invoiceAllRows.value.filter(r => licenseGroups.value.keyByStore.get(r.storeId) === activeLicense.value)
    : invoiceAllRows.value
))

/** 已在用的主体（给输入框做下拉候选：同一个执照的多家店要填成完全一致，才不会拆成两个主体） */
const licenseOptions = computed(() => licenseSummary.value.items.filter(l => l.key !== NO_LICENSE_KEY))

function openLicenseEditor(r: any) {
  licenseEditingId.value = r.storeId
  licenseDraft.name = r.licenseName || ''
  licenseDraft.no = r.licenseNo || ''
  licenseEditError.value = ''
}

async function saveLicense(r: any) {
  licenseSaving.value = true
  licenseEditError.value = ''
  const res = await ws.setStoreLicense(r.storeId, licenseDraft.name.trim(), licenseDraft.no.trim())
  licenseSaving.value = false
  if (!res.ok) {
    licenseEditError.value = res.message || '保存失败'
    return
  }
  licenseEditingId.value = null
  ws.toast('营业执照已保存', 'success')
}

/**
 * 「获取主体营业执照」：去平台后台把**本店自己的主体**读回来，再写进店铺的营业执照字段。
 *
 * 两步分开（都复用既有机制）：
 *  1. 采集：为每个"已实测主体页锚点"的店铺建一个只读采集任务（navigate → readLabelValue×N → 快照 entity.name/no）；
 *  2. 写回：主进程按快照决定写不写——**空则填；与已填不一致就不覆盖**，把两边都报出来（错一个公司就是错票）。
 * 未实测的平台（或登录态过期的）**不猜**，在结果里照实说明原因。
 */
async function collectStoreEntities() {
  const supported = ws.stores.filter(s => !!entityProfileFor(s.platform))
  if (!supported.length) {
    ws.toast('还没有已实测主体信息页的平台——需先在真实登录态后台实测（不猜选择器），当前只有快手小店已登记', 'error')
    return
  }
  entityCollecting.value = true
  entityReport.value = []
  const runIds: string[] = []
  try {
    for (const s of supported) {
      const profile = entityProfileFor(s.platform)!
      if (!ws.openStoreIds.includes(s.id)) {
        // 引擎不静默拉起店铺浏览器（§4.4）：用户点这个按钮就是要采这几家 → 显式打开
        try { await window.shopilot.browser.open(s.id) } catch { /* 打开失败就排队，下面如实汇报 */ }
      }
      const res = await window.shopilot.task.create({
        name: `主体信息采集 · ${s.platform} · ${new Date().toLocaleDateString()}`,
        storeScope: s.id,
        steps: buildEntityCollectSteps(profile)
      })
      if (!res.ok) continue
      const run = await window.shopilot.task.run(res.data.id)
      if (run.ok && run.data?.runId) runIds.push(run.data.runId)
    }
    await ws.refreshTasks()
    if (runIds.length) {
      const deadline = Date.now() + 150000
      for (;;) {
        await new Promise(r => setTimeout(r, 3000))
        const list = await window.shopilot.task.list()
        const all = list.ok ? (list.data.tasks || list.data) : []
        const done = runIds.every(id => {
          const t = all.find((x: any) => x.latestRun?.id === id)
          const st = t?.latestRun?.status
          return st && ['succeeded', 'failed', 'cancelled'].includes(st)
        })
        if (done || Date.now() > deadline) break
      }
    }
    // 写回：空则填、不一致不覆盖（主进程按快照决定，界面只展示结果）
    const applied = await window.shopilot.overview.entityApply()
    if (!applied.ok) { ws.toast('写回主体信息失败：' + applied.error.message, 'error'); return }
    entityReport.value = applied.data.rows || []
    const filled = applied.data.filled || 0
    ws.toast(
      filled ? `已按平台读到的主体填入 ${filled} 家店铺的营业执照` : '采集完成：没有需要新填的主体（详见下方结果）',
      filled ? 'success' : 'info'
    )
    await Promise.all([ws.refreshStores(), loadInvoiceCenter()])
  } finally {
    entityCollecting.value = false
  }
}

/** 结果里每行的一句话说明（照实说：填了什么、哪不一致、为什么取不了） */
function entityReportText(r: any): string {
  const w = r.written || {}
  const parts: string[] = []
  if (r.status === 'fill') {
    if (w.licenseName) parts.push(`名称「${w.licenseName}」`)
    if (w.licenseNo) parts.push(`统一社会信用代码「${w.licenseNo}」`)
    return `已填入 ${parts.join(' + ')}`
  }
  if (r.status === 'same') return '平台读到的主体与已填一致，未改动'
  if (r.status === 'conflict') {
    return '平台读到的与你已填的不一致——没有覆盖你的填写，请自己核对：' +
      (r.conflicts || []).map((c: any) => `${c.field === 'licenseName' ? '名称' : '信用代码'}：已填「${c.existing}」／平台「${c.fetched}」`).join('；')
  }
  if (r.status === 'nothing') {
    if (!(r.rejected || []).length) return '平台页面上没读到主体信息——该店可能是个人店铺（本来没有营业执照），也可能页面已改版；没有写入任何值'
    return '平台给的值不可用（未写入）：' + (r.rejected || []).map((x: any) => `${x.field === 'licenseName' ? '名称' : '信用代码'} ${x.raw}——${x.why}`).join('；')
  }
  if (r.status === 'no-data') return r.note || '还没有采到该店的主体信息'
  if (r.status === 'unsupported') return '该平台暂不能自动获取：' + (r.note || '')
  return String(r.status)
}

/** 「只看有数据的」筛选（搜索与排序已在 invoiceRows 里做过） */
const visibleInvoiceRows = computed(() =>
  invoiceOnlyWithData.value ? invoiceRows.value.filter(r => r.count > 0 || r.historyCount > 0) : invoiceRows.value
)
/**
 * 跨店铺合计（含**按方向**分开的合计）。金额口径如实处理：
 *  - 解析不出的**不计入**，并把条数报出来（界面注明），避免"合计比实际小"却看不出来；
 *  - 同时出现过 ¥ 与 ￥ 时提示一下；不同平台/方向口径以各自页面为准（不做汇率/含税换算）；
 *  - `pending === false` 的方向是**已提交/已通过、商家无需操作**（实测快手「处理中」「处理记录」）
 *    → 照常展示，但**不计入**待开票条数与可开金额，否则合计虚高。
 */
const invoiceTotal = computed(() => {
  let count = 0
  let amount = 0
  let unparsed = 0
  let overdue = 0
  let stores = 0
  let historical = 0
  const symbols = new Set<string>()
  // 按方向汇总（方向名跨平台合并，如各家的「给平台开票」）
  const byDirection = new Map<string, { name: string; count: number; amount: number; unparsed: number; pending: boolean }>()
  for (const r of invoiceRows.value) {
    if (!r.supported) continue
    // "有数据的店铺"只算**有待办**的店：只有历史记录的店不该被算成"有 1 家在等你开票"
    if (r.sections.some((s: any) => s.pending !== false && s.items.length)) stores++
    for (const sec of r.sections) {
      const isPending = sec.pending !== false
      const dir = byDirection.get(sec.name) || { name: sec.name, count: 0, amount: 0, unparsed: 0, pending: isPending }
      for (const it of sec.items) {
        // 历史方向：条数与金额都不进合计，只统计条数让界面能说明"另有 N 条历史记录"
        if (!isPending) { historical++; dir.count++; continue }
        count++
        dir.count++
        const a = parseAmount(it.cells?.amount)
        if (a == null) { unparsed++; dir.unparsed++ }
        else { amount += a; dir.amount += a }
        const s = cleanCell(it.cells?.amount)
        const sym = /[¥￥$€]/.exec(s)
        if (sym) symbols.add(sym[0])
        const dl = cleanCell(it.cells?.deadline) + ' ' + cleanCell(it.cells?.status) + ' ' + cleanCell(it.cells?.id)
        if (/逾期|过期|即将|待开票|未开票|待处理/.test(dl)) overdue++
      }
      byDirection.set(sec.name, dir)
    }
  }
  const symList = [...symbols]
  // 历史方向也列出来（照实展示），但标出来它不参与合计。
  const dirs = [...byDirection.values()]
    .filter(d => d.count > 0)
    .sort((a, b) => b.count - a.count)
    .map(d => ({ ...d, amountText: '¥' + fmtAmount(d.amount) }))
  return {
    count, amount, stores, unparsed, overdue, dirs, historical,
    amountText: count ? (symList.includes('￥') && !symList.includes('¥') ? '￥' : '¥') + fmtAmount(amount) : '—',
    aliasWarning: symList.length > 1 || (amount > 0 && unparsed > 0),
    currencyNote: symList.length > 1 ? `¥ 与 ￥ 两种符号（同一币种，仅符号不同）` : `无法解析的金额`
  }
})

async function loadInvoiceCenter() {
  invoiceLoading.value = true
  try {
    const res = await window.shopilot.overview.invoiceCenter()
    if (!res.ok) { ws.toast('读取发票信息失败: ' + res.error.message, 'error'); return }
    invoice.generatedAt = res.data.generatedAt || null
    invoice.columns = res.data.columns || []
    invoice.rows = res.data.rows || []
  } finally {
    invoiceLoading.value = false
  }
}

/** 抓取：为每个有实测发票档案的店铺建一个采集任务（发票页 → readTable 落快照） */
async function collectInvoiceData() {
  const supported = ws.stores.filter(s => !!invoiceProfileFor(s.platform))
  if (!supported.length) {
    ws.toast('还没有已实测发票页锚点的平台——需先在真实登录态后台实测发票页（不猜选择器）', 'error')
    return
  }
  invoiceCollecting.value = true
  let created = 0
  const runIds: string[] = []
  const skipped: string[] = []
  try {
    for (const s of supported) {
      const profile = invoiceProfileFor(s.platform)!
      const steps = buildInvoiceCollectSteps(profile)
      // 引擎不静默拉起店铺浏览器（§4.4）：未打开的店铺会一直排队。
      // 用户点「抓取」就是要采集这几家 → 这里显式把它打开（这是用户主动发起的动作，不算静默）。
      if (!ws.openStoreIds.includes(s.id)) {
        try { await window.shopilot.browser.open(s.id) } catch { /* 打开失败就让它在队里等，下面汇报 */ }
      }
      const res = await window.shopilot.task.create({
        name: `发票采集 · ${s.platform} · ${new Date().toLocaleDateString()}`,
        storeScope: s.id,
        steps
      })
      if (!res.ok) { skipped.push(`${s.name}（创建失败）`); continue }
      const run = await window.shopilot.task.run(res.data.id)
      if (!run.ok) { skipped.push(`${s.name}（启动失败）`); continue }
      if (run.data?.runId) runIds.push(run.data.runId)
      created++
    }
    await ws.refreshTasks()
    const notOpen = supported.filter(s => !ws.openStoreIds.includes(s.id)).length
    ws.toast(
      `已启动 ${created} 个发票采集任务` +
      (notOpen ? `（其中 ${notOpen} 家店铺浏览器未打开，会排队等待，不静默拉起）` : '') +
      (skipped.length ? `；跳过：${skipped.join('、')}` : ''),
      created ? 'success' : 'error'
    )
    // 等采集跑完再刷新，避免界面停在旧值上；逐店如实汇报结果
    if (runIds.length) {
      const deadline = Date.now() + 180000
      let last: any[] = []
      for (;;) {
        await new Promise(r => setTimeout(r, 3000))
        const list = await window.shopilot.task.list()
        const all = list.ok ? (list.data.tasks || list.data) : []
        last = all.filter((x: any) => x.latestRun && runIds.includes(x.latestRun.id))
        const done = runIds.every(id => {
          const t = all.find((x: any) => x.latestRun?.id === id)
          const st = t?.latestRun?.status
          return st && ['succeeded', 'failed', 'cancelled'].includes(st)
        })
        if (done || Date.now() > deadline) break
      }
      const parts = last.map((t: any) => {
        const st = t.latestRun?.status
        const name = String(t.name || '').split(' · ')[1] || t.name
        if (st === 'succeeded') return `${name} ✓`
        if (st === 'queued') return `${name}（排队等浏览器打开）`
        return `${name} ✗（${String(t.latestRun?.errorMessage || st).slice(0, 60)}）`
      })
      if (parts.length) ws.toast('发票采集结果：' + parts.join('；'), parts.every((p: string) => p.includes('✓')) ? 'success' : 'info')
    }
    await loadInvoiceCenter()
  } finally {
    invoiceCollecting.value = false
  }
}

/** 导出当前待开票清单为 CSV（主进程弹保存框写文件；只落本地，不上传） */
async function exportInvoice() {
  const res = await window.shopilot.overview.invoiceExport()
  if (!res.ok) { ws.toast('导出失败：' + res.error.message, 'error'); return }
  if (res.data?.canceled) return
  ws.toast(`已导出 ${res.data.rows} 条待开票记录：${res.data.path}`, 'success')
}

async function openInvoiceFor(row: { storeId: string; storeName: string }) {
  const profile = invoiceProfileFor(ws.stores.find(x => x.id === row.storeId)?.platform || '')
  const cat = (window.shopilot.platforms || []) as Array<PlatformDef>
  const s = ws.stores.find(x => x.id === row.storeId)
  // 有实测发票页就打开发票页；否则退回该店后台首页
  const url = profile?.pageUrl || s?.adminUrl || cat.find(p => p.name === (s?.platform || ''))?.adminUrl || ''
  if (!url) { ws.toast('该店铺没有可打开的地址', 'error'); return }
  invoiceCenterOpen.value = false
  await ws.openStore(row.storeId)
  await ws.newTab(url)
  ws.toast(`已在「${row.storeName}」打开：${profile ? '发票页' : '后台首页'}`, 'info')
}

/**
 * 数据中心：汇总所有店铺的数据（只读）。
 * 数据全部来自本机：stores / store_snapshots（任务指标快照）/ task_runs（任务与邀约运行）。
 * 没有数据就如实显示空状态，不做任何估算补数。
 *
 * 说明：界面入口已改为「发票中心」（0.4.21），本功能代码保留以便随时恢复；
 * 需要时把左栏入口重新指到 openDataCenter() 即可。
 */
const dataCenterOpen = ref(false)
const dcLoading = ref(false)
const dcCollecting = ref(false)

/** 经营指标矩阵：按店铺汇总五个指标的最新快照值（值从 store_snapshots 的 biz.* 指标名来），
 *  并带上"上一次采集值"用于显示增减 */
const bizRows = computed(() => {
  const byStore = new Map<string, { storeId: string; storeName: string; platform: string; values: Record<string, unknown>; prevs: Record<string, unknown>; manual: Record<string, boolean>; lastAt: number }>()
  for (const s of ws.stores) {
    byStore.set(s.id, { storeId: s.id, storeName: s.name, platform: s.platform, values: {}, prevs: {}, manual: {}, lastAt: 0 })
  }
  for (const snap of dc.snapshots as any[]) {
    if (!String(snap.metric || '').startsWith('biz.')) continue
    const hit = [...byStore.values()].find(r => r.storeName === snap.storeName)
    if (!hit) continue
    hit.values[snap.metric] = snap.value
    if (snap.manual) hit.manual[snap.metric] = true
    if (snap.prevValue != null) hit.prevs[snap.metric] = snap.prevValue
    if (snap.capturedAt > hit.lastAt) hit.lastAt = snap.capturedAt
  }
  return [...byStore.values()]
})

/** 手动录入草稿（平台反抓取导致无法自动读取时使用；来源会如实标注"手动"） */
const manualDraft = reactive({ storeId: '', metric: 'biz.orders' as string, value: null as number | null })
const manualReady = computed(() =>
  !!manualDraft.storeId && !!manualDraft.metric &&
  manualDraft.value != null && Number.isFinite(Number(manualDraft.value)) && Number(manualDraft.value) >= 0
)

async function saveManualMetric() {
  if (!manualReady.value) return
  const res = await window.shopilot.overview.manualMetric(manualDraft.storeId, manualDraft.metric, Number(manualDraft.value))
  if (!res.ok) { ws.toast('录入失败: ' + res.error.message, 'error'); return }
  ws.toast('已录入（来源：手动）', 'success')
  manualDraft.value = null
  await loadDataCenter()
}

/** 合计行：只对**已采集到的数值**求和，并如实标注参与合计的店铺数（不做任何估算补齐） */
const bizTotals = computed(() => {
  const sums: Record<string, number> = {}
  let contributors = 0
  for (const r of bizRows.value) {
    let has = false
    for (const m of BIZ_METRICS) {
      const v = r.values[m.key]
      if (typeof v === 'number' && Number.isFinite(v)) { sums[m.key] = (sums[m.key] || 0) + v; has = true }
    }
    if (has) contributors++
  }
  return { sums, contributors }
})

/** 经营指标单元格显示：金额类补 ¥ 与千分位；没有值如实显示"—"（未采集） */
function bizValue(key: string, v: unknown): string {
  if (v == null || v === '') return '—'
  const money = key === 'biz.gmv' || key === 'biz.refundAmount'
  if (typeof v === 'number' && Number.isFinite(v)) {
    const s = v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
    return money ? '¥' + s : s
  }
  return String(v)
}

/** 与上一次采集相比的增减（delta 文本 + 方向），供界面显示 ▲/▼ */
function bizDelta(key: string, v: unknown, prev: unknown): { text: string; dir: 'up' | 'down' | 'flat' } | null {
  if (typeof v !== 'number' || typeof prev !== 'number') return null
  const d = v - prev
  if (!Number.isFinite(d) || d === 0) return { text: '持平', dir: 'flat' }
  const money = key === 'biz.gmv' || key === 'biz.refundAmount'
  const abs = Math.abs(d).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  return { text: (d > 0 ? '+' : '-') + (money ? '¥' : '') + abs, dir: d > 0 ? 'up' : 'down' }
}
const dc = reactive<any>({
  generatedAt: 0,
  totals: { stores: 0, online: 0, archived: 0, trash: 0, platforms: 0, snapshots: 0, tasks: 0 },
  byPlatform: [] as any[],
  snapshots: [] as any[],
  invite: { byStatus: [] as any[], recent: [] as any[] },
  runs: { byStatus: [] as any[], recentIssues: [] as any[] }
})

/**
 * 单元格文本：换行压成空格（实测拼多多「订单号」把"逾期未开票"折在下一行，
 * 一个单元格多行会把整行撑到 170px+，表格看着像坏了），并去掉平台重复渲染的整段重复。
 * 与主进程 `normalizeCellText`（shared/constants/invoice.ts）同一口径——界面显示的值
 * 与 CSV 导出的值必须一致，不能一个去重一个不去。
 */
function cleanCell(v: unknown): string {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  const compact = s.replace(/ /g, '')
  // 每半段至少 2 字符才判重复——否则「人人」这类叠字会被误削成「人」
  if (compact.length >= 4 && compact.length % 2 === 0) {
    const half = compact.slice(0, compact.length / 2)
    if (half === compact.slice(compact.length / 2)) return half
  }
  return s
}

/** 「其他信息」列：内容可能很长（拼多多 5 项、每项都不短）→ 只显示前 2 项，
 *  完整值放 title 悬停看。否则单元格折成十几行、把整行撑到 170px+（实测踩过）。 */
function extrasBrief(it: any): string {
  const ex = Array.isArray(it?.extras) ? it.extras : []
  if (!ex.length) return '—'
  const shown = ex.slice(0, 2).map((x: any) => `${x.label}：${x.value}`).join('；')
  return ex.length > 2 ? `${shown} …（共 ${ex.length} 项）` : shown
}
function extrasFull(it: any): string {
  const ex = Array.isArray(it?.extras) ? it.extras : []
  return ex.map((x: any) => `${x.label}：${x.value}`).join('；') || '—'
}

/** 打开发票中心（先把已采集的数据读回来） */
function openInvoiceCenter() {
  invoiceCenterOpen.value = true
  void loadInvoiceCenter()
}

async function loadDataCenter() {
  dcLoading.value = true
  try {
    const res = await window.shopilot.overview.datacenter()
    if (res.ok) {
      Object.assign(dc, res.data)
    } else {
      ws.toast('数据中心加载失败: ' + res.error.message, 'error')
    }
  } finally {
    dcLoading.value = false
  }
}

/** 经营指标口径说明（来自各平台实测档案的 note）：界面如实展示，避免"数字没有口径" */
const bizNotes = computed(() => {
  const plats = new Set(ws.stores.map(s => s.platform))
  return [...plats]
    .map(p => businessProfileFor(p))
    .filter((p): p is NonNullable<typeof p> => !!p && !!p.note)
    .map(p => `${p.platform}（实测 ${p.measuredAt}）：${p.note}`)
})
/**
 * 采集经营数据：为每个「平台已实测」的店铺各创建一个只读采集任务并立即运行
 * （navigate 经营数据页 → 每个指标一条 readText，值落 store_snapshots）。
 * 未实测平台不猜锚点，如实跳过并说明；需要店铺浏览器已打开（引擎不静默拉起，§4.4）。
 */
async function collectBusinessData() {
  const supported = ws.stores.filter(s => !!businessProfileFor(s.platform))
  if (!supported.length) {
    ws.toast('还没有已实测经营指标锚点的平台——需要先在真实登录态后台实测页面锚点（不猜选择器）', 'error')
    return
  }
  dcCollecting.value = true
  let created = 0
  const runIds: string[] = []
  const skipped: string[] = []
  try {
    for (const s of supported) {
      const profile = businessProfileFor(s.platform)!
      const steps = buildBusinessCollectSteps(profile)
      const res = await window.shopilot.task.create({
        name: `经营数据采集 · ${s.platform} · ${new Date().toLocaleDateString()}`,
        storeScope: s.id,
        steps
      })
      if (!res.ok) { skipped.push(`${s.name}（创建失败）`); continue }
      const run = await window.shopilot.task.run(res.data.id)
      if (!run.ok) { skipped.push(`${s.name}（启动失败）`); continue }
      if (run.data?.runId) runIds.push(run.data.runId)
      created++
    }
    await ws.refreshTasks()
    const notOpen = supported.filter(s => !ws.openStoreIds.includes(s.id)).length
    ws.toast(
      `已启动 ${created} 个采集任务` +
      (notOpen ? `（其中 ${notOpen} 家店铺浏览器未打开，会排队等待，不静默拉起）` : '') +
      (skipped.length ? `；跳过：${skipped.join('、')}` : ''),
      created ? 'success' : 'error'
    )
    // 采集要跑十几秒到一分钟：等运行结束后再刷新数据中心的数字，避免界面停在旧值上。
    // 任务列表已移除——这里**逐店如实汇报结果**（含失败原因），失败不被埋在看不见的运行记录里。
    if (runIds.length) {
      const deadline = Date.now() + 180000
      let last: any[] = []
      for (;;) {
        await new Promise(r => setTimeout(r, 3000))
        const list = await window.shopilot.task.list()
        const all = list.ok ? (list.data.tasks || list.data) : []
        last = all.filter((x: any) => x.latestRun && runIds.includes(x.latestRun.id))
        const done = runIds.every(id => {
          const t = all.find((x: any) => x.latestRun?.id === id)
          const st = t?.latestRun?.status
          return st && ['succeeded', 'failed', 'cancelled'].includes(st)
        })
        if (done || Date.now() > deadline) break
      }
      const parts = last.map((t: any) => {
        const st = t.latestRun?.status
        const name = String(t.name || '').split(' · ')[1] || t.name
        if (st === 'succeeded') return `${name} ✓`
        if (st === 'queued') return `${name}（排队等浏览器打开）`
        if (st === 'failed') return `${name} ✗ ${t.latestRun?.errorCode || '失败'}${t.latestRun?.errorMessage ? '：' + String(t.latestRun.errorMessage).slice(0, 60) : ''}`
        return `${name}（${st || '未知'}）`
      })
      if (parts.length) ws.toast('采集结果 —— ' + parts.join('｜'), last.every((t: any) => t.latestRun?.status === 'succeeded') ? 'success' : 'error')
      await ws.refreshTasks()
    }
    await loadDataCenter()
  } finally {
    dcCollecting.value = false
  }
}

/**
 * 弹层遮挡：店铺页面是原生 WebContentsView（永远画在 HTML 之上），
 * 弹层落在视口区域内会被整块盖住（实测回收站弹窗遮挡比例 100%）→ 遮挡期间摘除挂载。
 * 右键菜单通常落在左栏、不与视口相交，那种情况不摘除（避免每次右键中栏白闪）。
 */
const ctxOverlapViewport = ref(false)
let lastObscured = false
let overlaySyncChain: Promise<void> = Promise.resolve()
let overlayRevision = 0

function refreshOverlayOcclusion() {
  const revision = ++overlayRevision
  overlaySyncChain = overlaySyncChain.then(async () => {
    await nextTick()
    // A newer watch event has already scheduled a fresher DOM state.
    if (revision !== overlayRevision) return

    const modalOpen = !!(ws.createDialogOpen || ws.trashOpen || rename.open || copycfg.open || confirmBox.open || settingsOpen.value || dataCenterOpen.value || invoiceCenterOpen.value || taskDialogOpen.value)
    if (ctx.open && viewportEl.value) {
      const m = document.querySelector('[data-test="store-ctx"]')?.getBoundingClientRect()
      const v = viewportEl.value.getBoundingClientRect()
      ctxOverlapViewport.value = !!m && !(m.right <= v.left || m.left >= v.right || m.bottom <= v.top || m.top >= v.bottom)
    } else {
      ctxOverlapViewport.value = false
    }
    const shouldHide = modalOpen || ctxOverlapViewport.value
    if (shouldHide === lastObscured) return
    lastObscured = shouldHide
    await window.shopilot.browser.setViewsObscured(shouldHide)
  }).catch(() => {})
}

watch(
  () => [ws.createDialogOpen, ws.trashOpen, ctx.open, rename.open, copycfg.open, confirmBox.open, settingsOpen.value, dataCenterOpen.value, invoiceCenterOpen.value, taskDialogOpen.value],
  () => { refreshOverlayOcclusion() },
  { immediate: true }
)

async function openTrash() {
  await ws.refreshTrash()
  ws.trashOpen = true
}

async function confirmPurge(s: StoreRow) {
  if (window.confirm(`彻底删除「${s.name}」？此操作不可撤销，将清除其环境、下载记录与缓存。`)) {
    await ws.purgeStore(s.id)
  }
}

function quickCreate(p: { name: string }) { openCreateDialog(p.name) }

/** 打开"新建店铺"对话框：带上所选平台的默认后台地址（避免默认平台却给空地址，用户还得自己粘） */
function openCreateDialog(platformName?: string) {
  const name = platformName || DEFAULT_PLATFORM
  form.platform = name
  form.adminUrl = ''
  form.name = ''
  applyPlatformDefaults(name)
  ws.createDialogOpen = true
}

async function submitCreate() {
  const name = form.name.trim()
  const adminUrl = form.adminUrl.trim()
  if (!name || !adminUrl) {
    ws.toast('请填写店铺名称和后台地址', 'info')
    return
  }
  const tags = form.tags.split(',').map(t => t.trim()).filter(Boolean)
  const res = await ws.createStore({
    name, platform: form.platform, adminUrl, tags, notes: form.notes.trim(),
    licenseName: form.licenseName.trim(), licenseNo: form.licenseNo.trim()
  })
  if (res && res.ok) {
    Object.assign(form, { name: '', platform: DEFAULT_PLATFORM, adminUrl: '', tags: '', notes: '', licenseName: '', licenseNo: '' })
  }
}

function showInFolder(id: string) { window.shopilot.download.showInFolder(id) }

onMounted(async () => {
  updateEventHandler = (payload: any) => applyUpdateStatus(payload)
  window.shopilot.on('update:statusChanged', updateEventHandler)
  window.shopilot.on('update:progress', updateEventHandler)
  // 采集任务可能在数据中心的等待窗口之后才跑完（例如运行排队等店铺浏览器打开）：
  // 任何运行结束都刷新一次已打开的面板，避免表格停在旧数字上
  window.shopilot.on('task:progress', (ev: any) => {
    if (ev?.phase === 'finished' || ev?.phase === 'failed') {
      if (dataCenterOpen.value) void loadDataCenter()
      if (invoiceCenterOpen.value) void loadInvoiceCenter()
    }
  })
  await ws.init()
  // Renderer reloads do not reset main-process WebContentsView state. Explicitly
  // clear a stale overlay flag before the first viewport report; app-lock state
  // remains authoritative in the main process and still prevents mounting.
  lastObscured = true
  refreshOverlayOcclusion()
  if (ws.rightPanel === 'bookmarks') refreshEntryRoutes()
  // 恢复「设置 → 配置」里的平台首页地址（影响首页按钮与新建店铺的默认后台地址）
  await loadPlatformHomeUrls()
  // 达人广场地址覆盖表（邀约面板与设置都用它）
  await loadSquareUrls()
  // 已成功读取过的完整类目树（抖店三级类目优先于档案内的两级快照）
  await loadInviteCategoryTrees()
  // AI 配置（只回 hasKey，Key 本身永不回渲染层）：邀约面板的"AI 生成"要据此判断能不能开始
  await loadAiConfig()
  // 恢复上次的右栏收起状态
  const saved = await window.shopilot.settings.get('ui.rightPanelCollapsed')
  if (saved?.ok && saved.data?.value === true) { rightPanelCollapsed.value = true }
  // 恢复上次的左栏收起状态
  const savedLeft = await window.shopilot.settings.get('ui.leftSidebarCollapsed')
  if (savedLeft?.ok && savedLeft.data?.value === true) { leftSidebarCollapsed.value = true }
  await nextTick()
  if (viewportEl.value) {
    resizeObserver = new ResizeObserver(() => reportViewport())
    resizeObserver.observe(viewportEl.value)
  }
  window.addEventListener('resize', reportViewport)
  window.addEventListener('mousedown', onDocMouseDown, true)
  window.addEventListener('keydown', onDocKey)
  reportViewport()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('resize', reportViewport)
  window.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('keydown', onDocKey)
  if (updateEventHandler) {
    window.shopilot.off('update:statusChanged', updateEventHandler)
    window.shopilot.off('update:progress', updateEventHandler)
  }
})
</script>

<style scoped>
.workbench { display: flex; width: 100vw; height: 100vh; overflow: hidden; }

/* 左栏 */
.sidebar {
  width: 304px; min-width: 304px; height: 100%;
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-border);
  display: flex; flex-direction: column;
}
.brand { display: flex; align-items: center; gap: 10px; padding: 16px; -webkit-app-region: drag; }
.brand-logo {
  width: 30px; height: 30px; border-radius: 8px;
  background: linear-gradient(135deg, #3b82f6, #8b5cf6);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 16px;
}
.brand-name { font-weight: 600; font-size: 15px; }
/* 更新入口已搬进「设置 → 关于软件」，品牌行只留 logo/名称/收起按钮；
   margin-left:auto 从原 .brand-update 挪到这里，收起按钮才会留在右端 */
.sidebar-collapse {
  margin-left: auto;
  width: 26px; height: 26px; flex: 0 0 auto; border: 0; background: none;
  border-radius: 6px; font-size: 15px; line-height: 1; color: var(--color-text-secondary);
  -webkit-app-region: no-drag;
}
.sidebar-collapse:hover { background: var(--color-bg-tertiary); color: #fff; }

/* 左栏收起态：留一条窄轨（新建/回收站/更新仍可达；顶部留拖拽区，按钮自身 no-drag） */
.sidebar.collapsed { width: 44px; min-width: 44px; }
.sidebar-rail {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 16px 0 8px; height: 100%; -webkit-app-region: drag;
}
.sidebar-rail .rail-btn { -webkit-app-region: no-drag; }

.sidebar-tools { display: flex; gap: 8px; padding: 0 16px 10px; }
.search-box {
  flex: 1; display: flex; align-items: center; gap: 6px;
  background: var(--color-bg-tertiary); border: 1px solid var(--color-border);
  border-radius: var(--radius-sm); padding: 0 10px; height: 32px;
}
.search-box input { flex: 1; background: none; border: none; outline: none; color: var(--color-text-primary); font-size: 13px; }
.search-ico { opacity: .6; font-size: 12px; }
.btn-new {
  width: 32px; height: 32px; border-radius: var(--radius-sm);
  background: var(--color-primary); color: #fff; font-size: 18px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
}
.btn-new:hover { filter: brightness(1.1); }

.filter-chips { display: flex; gap: 6px; padding: 0 16px 10px; }
.filter-platform {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 0 16px 10px;
}
.fp-header { display: flex; align-items: center; gap: 6px; width: 100%; margin-bottom: 2px; }
.fp-label { font-size: 11px; color: var(--color-text-muted); flex-shrink: 0; }
.fp-clear {
  font-size: 10px; color: var(--color-primary); background: none; border: 0; cursor: pointer; padding: 0; line-height: 1; text-decoration: underline;
}
.fp-chip {
  display: flex; align-items: center; gap: 4px;
  font-size: 11px; padding: 2px 8px; border-radius: 20px;
  background: var(--color-bg-tertiary); color: var(--color-text-secondary); border: 1px solid var(--color-border);
  cursor: pointer; height: 24px; transition: background .15s, border-color .15s, color .15s;
}
.fp-chip:hover:not(.on) { border-color: var(--color-text-secondary); }
.fp-chip.on { color: #fff; }
.fp-count {
  font-size: 10px; opacity: .7; background: rgba(255,255,255,.2); border-radius: 8px;
  padding: 0 5px; line-height: 14px; min-width: 14px; text-align: center;
}
.fp-chip:not(.on) .fp-count { background: var(--color-border); color: var(--color-text-muted); }
.fp-other-icon { font-size: 12px; }

.store-list { flex: 1; overflow-y: auto; padding: 4px 10px; }
.store-group { margin-bottom: 8px; }
.group-title { font-size: 11px; color: var(--color-text-muted); padding: 8px 6px 4px; text-transform: uppercase; letter-spacing: .04em; }

.store-card {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border-radius: var(--radius-sm); cursor: grab; border: 1px solid transparent;
}
.store-card:hover { background: var(--color-bg-tertiary); }
.store-card.active { background: var(--color-bg-tertiary); }
.store-card.displayed { border-color: var(--color-primary); }
.store-card:active { cursor: grabbing; }
.store-card.dragging { opacity: .42; }
.store-card.drag-over-before { box-shadow: inset 0 2px 0 var(--color-primary); }
.store-card.drag-over-after { box-shadow: inset 0 -2px 0 var(--color-primary); }
.avatar {
  width: 34px; height: 34px; border-radius: 8px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600; font-size: 15px; color: #fff;
}
.avatar.sm { width: 28px; height: 28px; font-size: 13px; border-radius: 6px; }
.store-meta { flex: 1; min-width: 0; }
.store-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.store-sub { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--color-text-secondary); }
.dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.store-action { width: 26px; height: 26px; border-radius: 6px; color: var(--color-text-secondary); font-size: 13px; opacity: 0; }
.store-card:hover .store-action { opacity: 1; }
.store-action:hover { background: var(--color-bg-elevated); color: var(--color-primary); }

.empty-hint { color: var(--color-text-muted); font-size: 13px; text-align: center; padding: 30px 10px; line-height: 1.8; }
.field-note { display: block; font-size: 11px; color: var(--color-text-secondary); margin-top: 4px; }
.link { color: var(--color-primary); text-decoration: underline; }
/* 右栏收起态：只留一条窄轨（图标=面板；徽标=有待人工确认） */
.right-panel.collapsed { width: 44px; min-width: 44px; }
/* 顶部 46px 避让：右上角原生窗口按钮（WCO 高 38px）压在窄轨上方 */
.panel-rail { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 46px 0 8px; height: 100%; }
.rail-btn {
  position: relative; width: 30px; height: 30px; border: 0; background: none; cursor: pointer;
  border-radius: 6px; font-size: 14px; color: var(--color-text-secondary); line-height: 1;
}
.rail-btn:hover { background: var(--color-bg-tertiary); color: #fff; }
.rail-btn.on { background: var(--color-bg-tertiary); color: #fff; }
.rail-badge { position: absolute; top: 2px; right: 2px; width: 8px; height: 8px; border-radius: 50%; background: var(--color-warning); }
.panel-collapse {
  flex: 0 0 30px; border: 0; background: none; cursor: pointer;
  font-size: 15px; color: var(--color-text-secondary);
  -webkit-app-region: no-drag;
}
.panel-collapse:hover { background: var(--color-bg-tertiary); color: #fff; }

.sidebar-footer { display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--color-border); }
.foot-btn {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px; border-radius: var(--radius-sm); font-size: 12px;
  background: var(--color-bg-tertiary); color: var(--color-text-secondary);
}
.foot-btn:hover:not(:disabled) { color: var(--color-text-primary); }
.foot-btn:disabled { opacity: .4; cursor: not-allowed; }
.badge { background: var(--color-error); color: #fff; border-radius: 10px; padding: 0 6px; font-size: 10px; }

/* 中栏 */
.browser-col { flex: 1; display: flex; flex-direction: column; background: var(--color-bg-primary); min-width: 0; }
.tab-strip { display: flex; align-items: center; height: 38px; background: var(--color-bg-secondary); padding: 0 8px; gap: 4px; -webkit-app-region: drag; }
/* §17 顶部融合（titleBarStyle:'hidden'）：标签栏即标题栏拖拽区，可交互元素排除；
   右栏收起时右上角原生窗口按钮（WCO ≈140×38）会压住标签栏右端，避让 140-44(窄轨)+8 = 104px */
.tab, .tab-close, .tab-add { -webkit-app-region: no-drag; }
.tab-strip.wco-avoid { padding-right: 104px; }
.tabs { display: flex; gap: 4px; overflow-x: auto; flex: 1; height: 100%; align-items: center; }
.tab {
  display: flex; align-items: center; gap: 6px; max-width: 220px; min-width: 120px;
  height: 28px; padding: 0 8px 0 10px; border-radius: 8px;
  background: var(--color-bg-tertiary); font-size: 12px; cursor: pointer;
}
.tab.active { background: var(--color-bg-primary); box-shadow: inset 0 0 0 1px var(--color-border); }
.tab.pinned { min-width: 40px; }
.tab-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tab-close { width: 16px; height: 16px; border-radius: 4px; color: var(--color-text-secondary); line-height: 1; font-size: 14px; }
.tab-close:hover { background: rgba(255,255,255,.12); color: #fff; }
.tab-spinner { width: 11px; height: 11px; border: 2px solid var(--color-border); border-top-color: var(--color-primary); border-radius: 50%; animation: spin .7s linear infinite; flex-shrink: 0; }
@keyframes spin { to { transform: rotate(360deg); } }
.tab-add { width: 26px; height: 26px; border-radius: 6px; font-size: 17px; color: var(--color-text-secondary); }
.tab-add:hover { background: var(--color-bg-tertiary); color: #fff; }

.address-bar { display: flex; align-items: center; gap: 4px; height: 44px; padding: 0 8px; background: var(--color-bg-primary); border-bottom: 1px solid var(--color-border); }
.nav-btn { width: 30px; height: 30px; border-radius: 6px; color: var(--color-text-secondary); font-size: 16px; display: flex; align-items: center; justify-content: center; }
.nav-btn:hover { background: var(--color-bg-tertiary); color: #fff; }
.nav-btn:disabled { opacity: .35; cursor: default; }
.nav-btn:disabled:hover { background: none; color: var(--color-text-secondary); }
.url-box { flex: 1; height: 30px; background: var(--color-bg-tertiary); border: 1px solid var(--color-border); border-radius: 15px; padding: 0 14px; display: flex; align-items: center; }
.url-box input { width: 100%; background: none; border: none; outline: none; color: var(--color-text-primary); font-size: 13px; }
.viewport { flex: 1; position: relative; background: #fff; }

/* 欢迎页 */
/* §17 顶部融合：欢迎页空白区也可拖动窗口（右上角是原生窗口按钮 overlay） */
.welcome { flex: 1; display: flex; align-items: center; justify-content: center; -webkit-app-region: drag; }
.welcome-inner { text-align: center; max-width: 520px; -webkit-app-region: no-drag; }
.welcome-logo { width: 64px; height: 64px; border-radius: 16px; margin: 0 auto 18px; background: linear-gradient(135deg,#3b82f6,#8b5cf6); display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 700; }
.welcome h1 { font-size: 24px; margin-bottom: 8px; }
.welcome-desc { color: var(--color-text-secondary); margin-bottom: 24px; }
.quick-platforms { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
.qp { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 20px; background: var(--color-bg-secondary); border: 1px solid var(--color-border); font-size: 13px; }
.qp:hover { border-color: var(--color-primary); }
.qp-dot { width: 10px; height: 10px; border-radius: 50%; }

/* 右栏 */
.right-panel { width: 320px; min-width: 320px; height: 100%; background: var(--color-bg-secondary); border-left: 1px solid var(--color-border); display: flex; flex-direction: column; }
/* §17 顶部融合：面板顶行也是标题栏拖拽区；右侧 140px 留给原生窗口按钮（WCO） */
.panel-tabs { display: flex; height: 40px; border-bottom: 1px solid var(--color-border); padding-right: 140px; -webkit-app-region: drag; }
.ptab { flex: 1; font-size: 13px; color: var(--color-text-secondary); border-bottom: 2px solid transparent; -webkit-app-region: no-drag; }
.ptab.on { color: #fff; border-bottom-color: var(--color-primary); }
.panel-body { flex: 1; overflow-y: auto; padding: 8px; }
.row-item { position: relative; padding: 8px 30px 8px 10px; border-radius: var(--radius-sm); cursor: pointer; }
.row-item:hover { background: var(--color-bg-tertiary); }
.row-main { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-sub { font-size: 11px; color: var(--color-text-secondary); }
/* 行内小按钮（删除/打开目录）。原实现把"绝对定位 + opacity:0 悬停显示"写在 .row-del 基类上，
   导致 .proxy-item / .tc-head 里的删除按钮既不可见、又相对 .modal-mask 跑到窗口右上角。
   现在：基类=可见的静态小按钮；仅 .row-item（列表行）保留悬停显示。 */
.row-del { width: 22px; height: 22px; flex: 0 0 auto; border: 0; background: none; border-radius: 4px; color: var(--color-text-muted); opacity: .65; cursor: pointer; }
.row-item .row-del { position: absolute; right: 8px; top: 10px; width: 20px; height: 20px; opacity: 0; }
.row-item:hover .row-del { opacity: 1; }
.row-del:hover { background: var(--color-bg-elevated); color: #fff; opacity: 1; }
.dl-state { font-weight: 500; }
.dl-state.completed { color: var(--color-success); }
.dl-state.in_progress { color: var(--color-primary); }
.dl-state.cancelled, .dl-state.interrupted { color: var(--color-error); }

/* 模态 */
.modal-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex;
  align-items: center; justify-content: center; z-index: 100;
  /* The window uses hidden title bars and app-region drag zones. A modal must
     explicitly opt out, otherwise mouse clicks are interpreted as window drag
     gestures and text fields never receive focus. */
  -webkit-app-region: no-drag;
}
.modal, .modal * { -webkit-app-region: no-drag; }
.modal { position: relative; z-index: 101; width: 420px; max-height: 80vh; overflow-y: auto; background: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: var(--radius); padding: 22px; }
.modal h2 { font-size: 17px; margin-bottom: 16px; }
.modal label { display: block; font-size: 12px; color: var(--color-text-secondary); margin-bottom: 12px; }
.modal input, .modal select, .modal textarea {
  width: 100%; margin-top: 4px; padding: 8px 10px; border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary); border: 1px solid var(--color-border); color: #fff; font-size: 13px; outline: none;
}
.modal input:focus, .modal textarea:focus { border-color: var(--color-primary); }
.platform-pick { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.platform-pick select { margin-top: 0; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
.btn-primary { background: var(--color-primary); color: #fff; padding: 8px 18px; border-radius: var(--radius-sm); font-size: 13px; }
.btn-primary:disabled { opacity: .45; cursor: not-allowed; }
.btn-ghost { background: var(--color-bg-tertiary); color: var(--color-text-primary); padding: 8px 16px; border-radius: var(--radius-sm); font-size: 13px; }
.btn-danger { background: var(--color-error); color: #fff; padding: 8px 14px; border-radius: var(--radius-sm); font-size: 13px; }
.btn-ghost.sm, .btn-danger.sm { padding: 5px 10px; font-size: 12px; }

.trash-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--color-border); }
.trash-meta { flex: 1; font-size: 13px; }

/* Toast */
.toast-host { position: fixed; right: 20px; bottom: 20px; display: flex; flex-direction: column; gap: 8px; z-index: 200; }
.toast { padding: 10px 16px; border-radius: var(--radius-sm); font-size: 13px; background: var(--color-bg-elevated); border: 1px solid var(--color-border); box-shadow: 0 8px 24px rgba(0,0,0,.4); animation: slideIn .2s ease; }
.toast.success { border-color: var(--color-success); }
.toast.error { border-color: var(--color-error); }
@keyframes slideIn { from { transform: translateX(20px); opacity: 0; } to { transform: none; opacity: 1; } }

/* 环境面板 - §13 / §16 */
.env-body { display: flex; flex-direction: column; gap: 0; }
.env-sec { padding: 12px 14px; border-bottom: 1px solid var(--color-border); }
.env-h { font-size: 12px; font-weight: 600; color: var(--color-text-secondary); letter-spacing: .5px; margin-bottom: 10px; display: flex; align-items: center; }
.bind-row select { width: 100%; background: var(--color-bg-tertiary); color: var(--color-text-primary); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 7px 9px; font-size: 13px; }
.env-note { font-size: 12px; color: var(--color-text-secondary); margin-top: 8px; line-height: 1.5; }
.env-note.ok { color: var(--color-success); }
.proxy-item { display: flex; align-items: center; gap: 8px; padding: 7px 0; }
.p-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.p-info { flex: 1; min-width: 0; }
.mini-btn { background: var(--color-bg-elevated); color: var(--color-text-primary); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 4px 9px; font-size: 12px; cursor: pointer; flex-shrink: 0; }
.mini-btn:hover:not(:disabled) { border-color: var(--color-primary); }
.mini-btn:disabled { opacity: .5; cursor: default; }
.mini-btn.primary { background: var(--color-primary); border-color: var(--color-primary); color: #fff; }
.proxy-add { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.proxy-add input, .add-line select, .add-line input { background: var(--color-bg-tertiary); color: var(--color-text-primary); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 6px 8px; font-size: 12px; width: 100%; box-sizing: border-box; }
.add-line { display: flex; gap: 6px; }
.add-line select { width: 74px; min-width: 74px; flex: 0 0 74px; }
.add-line .f-host { flex: 1 1 auto; min-width: 60px; width: auto; }
.add-line .f-port { width: 72px; min-width: 72px; flex: 0 0 72px; }
.verify-item { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.v-info { flex: 1; min-width: 0; }

/* 会话 / Cookie / 应用锁 / 备份诊断：只作用于这三段，
   不要写成 .env-sec input —— 会连带改掉"添加代理"那一行的下拉/主机宽度（实测把主机输入挤到 18px 并让右栏横向溢出） */
[data-test="session-sec"] input, [data-test="session-sec"] select,
[data-test="lock-sec"] input, [data-test="lock-sec"] select,
[data-test="diag-sec"] input, [data-test="diag-sec"] select {
  background: var(--color-bg-tertiary); color: var(--color-text-primary); border: 1px solid var(--color-border);
  border-radius: var(--radius-sm); padding: 6px 8px; font-size: 12px; width: 100%; box-sizing: border-box; margin-top: 6px;
}
[data-test="session-sec"] .mini-btn, [data-test="lock-sec"] .mini-btn, [data-test="diag-sec"] .mini-btn { margin-top: 6px; }
.env-sec .cf-btns .mini-btn { margin-top: 0; }
.ck-search { margin-top: 6px; }
.ck-item { padding: 5px 0; }
.ck-flag { font-size: 10px; color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: 4px; padding: 0 4px; margin-left: 5px; }
.danger-btn { color: #fca5a5; border-color: #7f1d1d; }
.danger-btn:hover { background: rgba(239, 68, 68, .15); }

/* 任务面板 - §4.4 / §6.6 */
.confirm-bar { background: rgba(245, 158, 11, .12); border-bottom: 1px solid var(--color-warning); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.cf-txt { font-size: 13px; color: var(--color-warning); }
.cf-btns { display: flex; gap: 8px; }
.tc-headsec { display: flex; align-items: center; justify-content: space-between; }
.task-card { padding: 10px 14px; }
.task-card.on { background: var(--color-bg-secondary); }
.tc-head { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.step-row { display: flex; align-items: flex-start; gap: 8px; padding: 5px 0 0 4px; }
.s-ico { width: 18px; text-align: center; flex-shrink: 0; font-size: 12px; }
.tc-btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.log-box { margin-top: 8px; background: var(--color-bg-primary); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 6px 8px; max-height: 160px; overflow-y: auto; }
.log-line { font-size: 11px; color: var(--color-text-secondary); font-family: Consolas, monospace; line-height: 1.6; word-break: break-all; }
.modal-wide { width: 560px; max-width: 92vw; }
/* 自定义任务的步骤编排器是三栏（目录 156 + 序列 自适应 + 参数 268 + 间距），
   560px 那一档会把参数表单挤成一团，单给更宽的一档。

   高度上这一档**不能沿用 .modal 的"固定 80vh + 整体内滚动"**：三栏编排器本身较高，
   整体滚动会把「创建任务」按钮和校验清单一起推到视野外（实测内容 887 > 可视 718），
   用户只看到按钮点不动却找不到原因。改成 flex 列布局——标题/类型/名称/定时/按钮都是
   固定项，只让中间的编排器滚动，按钮与校验始终在视野里。 */
.task-create-tall {
  width: 980px; max-width: 96vw; max-height: 88vh;
  display: flex; flex-direction: column; overflow: hidden;
}
.task-create-tall > h2,
.task-create-tall > .row-sub,
.task-create-tall > label { flex: 0 0 auto; }
.task-create-tall > .modal-actions { flex: 0 0 auto; margin-top: 12px; }
/* ---------- 数据中心入口（左栏底部：独立一行） ---------- */
.sidebar-dc { padding: 8px 12px 0; border-top: 1px solid var(--color-border); }
.dc-entry-row {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 8px 10px; border-radius: var(--radius-sm); font-size: 13px;
  color: var(--color-text-primary); background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
}
.dc-entry-row:hover { border-color: var(--color-primary); color: #fff; }
.dc-entry-row .dc-ico { font-size: 14px; }
.dc-entry-row .dc-txt { flex: 1 1 auto; text-align: left; }
/* 左栏收起为窄轨时：数据中心图标钉在窄轨底部（左下角） */
.sidebar-rail .dc-rail-btn { margin-top: auto; }
.dc-modal { width: 880px; max-width: 94vw; max-height: 84vh; }
.dc-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.dc-head .row-sub { flex: 1 1 auto; }
.dc-cards { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 6px; }
.dc-card {
  flex: 1 1 90px; min-width: 84px; padding: 10px 8px; text-align: center;
  background: var(--color-bg-tertiary); border: 1px solid var(--color-border); border-radius: var(--radius-sm);
}
.dc-num { font-size: 20px; font-weight: 600; color: #fff; }
.dc-label { font-size: 11px; color: var(--color-text-secondary); margin-top: 2px; }
.dc-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.dc-chip {
  font-size: 11px; padding: 3px 8px; border-radius: 10px;
  background: var(--color-bg-tertiary); border: 1px solid var(--color-border); color: var(--color-text-secondary);
}
.dc-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 10px; }
.dc-table th {
  text-align: left; padding: 5px 6px; color: var(--color-text-secondary);
  border-bottom: 1px solid var(--color-border); font-weight: 500;
}
.dc-table td { padding: 5px 6px; border-bottom: 1px solid rgba(255,255,255,.05); vertical-align: top; }
.dc-val { font-weight: 600; color: #fff; }
.dc-bad { color: #ff7875; }
.dc-total td { border-top: 1px solid var(--color-border); font-weight: 600; }
.dc-delta { margin-left: 4px; font-size: 10px; font-weight: 400; color: var(--color-text-secondary); }
.dc-delta.up { color: #4ade80; }
.dc-delta.down { color: #ff7875; }
.dc-manual {
  margin-left: 4px; font-size: 10px; font-weight: 400; padding: 1px 4px; border-radius: 6px;
  background: rgba(250, 173, 20, .16); color: #faad14; border: 1px solid rgba(250, 173, 20, .35);
}
.dc-manual-form {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin: 8px 0 6px; padding: 8px; border: 1px dashed var(--color-border); border-radius: var(--radius-sm);
}
.dc-manual-form select, .dc-manual-form input {  background: var(--color-bg-tertiary); color: var(--color-text-primary);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 4px 6px; font-size: 12px;
}
/* ---------- 发票中心 ---------- */
/* 工具栏：搜索 + 只看有数据的 + 排序（窄屏自动换行） */
.inv-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.inv-toolbar .inv-cat-search { flex: 1 1 200px; min-width: 160px; }
/* 「只看有数据的」是 label.inv-chip：工具栏里必须保持单行（勾选框 + 文字），
   否则窄宽度下勾选框和文字会被拆成两行（实测 .inv-chip 是 flex，需要 nowrap + 不收缩） */
.inv-toolbar .inv-chip { flex: 0 0 auto; white-space: nowrap; padding: 4px 9px; }
.inv-toolbar select {
  box-sizing: border-box; background: var(--color-bg-tertiary); color: var(--color-text-primary);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 4px 6px; font-size: 12px;
}
/* 按开票方向的合计条：一行一个小胶囊，方向名浅色、数字加粗 */
.inv-dirs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
/* 按营业执照筛选：发票按开票主体开，这一条是"给哪个公司开票"的入口。
   可点即筛（再点一下取消），chip 上直接写着该主体有几家店、欠几张票、多少钱。 */
.inv-lic-bar {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 10px;
  padding: 6px 8px; border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
}
.inv-lic-title { font-size: 11px; color: var(--color-text-secondary); flex: 0 0 auto; }
.inv-lic-chip {
  display: inline-flex; align-items: baseline; gap: 5px; font-size: 11px; cursor: pointer;
  padding: 3px 9px; border: 1px solid var(--color-border); border-radius: 20px;
  background: var(--color-bg-elevated); color: var(--color-text-primary); white-space: nowrap;
}
.inv-lic-chip:hover { border-color: var(--color-primary); }
.inv-lic-chip.on { border-color: var(--color-primary); background: rgba(59, 130, 246, .16); }
.inv-lic-chip > i { font-style: normal; color: var(--color-text-secondary); }
/* 未填写那一桶用警示色：它是"要补录"的待办，不是某个真实主体 */
.inv-lic-chip.none { border-style: dashed; color: #d9a441; }
.inv-lic-chip.none.on { background: rgba(217, 164, 65, .16); }
/* 店铺卡片头上的主体标签（点击就地补录） */
.inv-lic-tag {
  font-size: 11px; padding: 1px 7px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--color-border); background: var(--color-bg-tertiary);
  color: var(--color-text-secondary); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.inv-lic-tag:hover { border-color: var(--color-primary); color: var(--color-text-primary); }
.inv-lic-tag.none { border-style: dashed; color: #d9a441; }
.inv-lic-tag > em { font-style: normal; opacity: .75; }
.inv-lic-edit { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }
.inv-lic-edit input {
  box-sizing: border-box; background: var(--color-bg-tertiary); color: var(--color-text-primary);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 5px 8px; font-size: 12px;
}
.inv-lic-edit input[data-test="invoice-license-name"] { flex: 1 1 240px; min-width: 180px; }
.inv-lic-edit input[data-test="invoice-license-no"] { flex: 0 1 240px; min-width: 160px; }
.inv-lic-err { font-size: 11px; color: #fca5a5; flex: 1 1 200px; }
/* 平台读到的主体（与"你填的"并排展示，便于核对） */
.inv-entity-line { font-size: 11px; color: var(--color-text-secondary); margin: 0 0 6px; }
.inv-entity-line > b { color: var(--color-text-primary); font-weight: 600; }
.inv-entity-line.off { color: var(--color-text-muted); font-style: normal; }
/* 「获取主体营业执照」的逐店结果 */
.inv-entity-report {
  margin: 0 0 10px; padding: 8px 10px; border: 1px solid var(--color-border);
  border-radius: var(--radius-sm); background: var(--color-bg-tertiary);
}
.inv-entity-report-h { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; font-size: 12px; }
.inv-entity-row { display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; padding: 2px 0; line-height: 1.5; }
.inv-entity-store { font-weight: 600; flex: 0 0 auto; }
.inv-entity-ok { color: #4ade80; }
.inv-entity-bad { color: #d9a441; }
.inv-dir {
  display: inline-flex; align-items: baseline; gap: 5px; font-size: 11px;
  padding: 3px 8px; border: 1px solid var(--color-border); border-radius: 20px;
  background: var(--color-bg-tertiary); color: var(--color-text-primary);
}
.inv-dir > i { font-style: normal; color: var(--color-text-secondary); }
.inv-dir > em { font-style: normal; color: #d9a441; }
/* 方向分组（一个方向一张表） */
.inv-sec { margin-top: 8px; }
.inv-sec-h { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 12px; }
.inv-sec-name { font-weight: 600; color: var(--color-text-primary); flex: 0 0 auto; white-space: nowrap; }
.inv-row-card {
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  padding: 8px 10px; margin-bottom: 8px;
}
.inv-row-head { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; font-size: 13px; }
.inv-row-head .inv-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.inv-row-head > b { flex: 0 0 auto; }
.inv-links { display: flex; flex-wrap: wrap; gap: 6px; }
.inv-link {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 9px; font-size: 12px; cursor: pointer;
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary); color: var(--color-text-primary);
}
.inv-link:hover { border-color: var(--color-primary); }
/* 已实测的入口给主色描边，和未实测的区分开 */
.inv-link.primary { border-color: var(--color-primary); }
.inv-link-t { white-space: nowrap; }
.inv-vtag {
  font-size: 10px; padding: 1px 5px; border-radius: 10px;
  border: 1px solid var(--color-border); color: var(--color-text-secondary);
}
.inv-vtag.on { border-color: #4ade80; color: #4ade80; }
/* 待开票信息表：列多（拼多多 15 列）→ 允许横向滚动，不挤成竖排 */
.inv-table-wrap { overflow-x: auto; border: 1px solid var(--color-border); border-radius: var(--radius-sm); }
.inv-table { width: 100%; border-collapse: collapse; font-size: 12px; white-space: nowrap; table-layout: auto; }
.inv-table th {
  text-align: left; padding: 5px 8px; font-weight: 600; color: var(--color-text-secondary);
  background: var(--color-bg-tertiary); border-bottom: 1px solid var(--color-border); vertical-align: top;
}
.inv-table td { padding: 5px 8px; border-bottom: 1px solid rgba(255, 255, 255, .05); vertical-align: top; }
.inv-table tr:last-child td { border-bottom: none; }
.inv-cell-strong { font-weight: 600; color: #fff; }
/* 「其他信息」列内容较长：限宽并**截断为最多 2 行**，完整值在 title 里；
   不限高的话一个单元格折十几行会把整行撑到 170px+（实测拼多多踩过） */
.inv-cell-extra {
  color: var(--color-text-secondary); max-width: 220px;
  white-space: normal; word-break: break-all;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.update-modal { width: 390px; }
/* 设置弹窗 + 任务面板二级页签共用的页签条。刻意不复用 .panel-tabs：
   那是右栏一级页签，带 padding-right:140px 给原生窗口按钮避让，装在弹窗/面板里会右侧留白诡异 */
.sub-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--color-border); margin-bottom: 10px; }
.stab {
  padding: 6px 12px; font-size: 13px; color: var(--color-text-secondary);
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.stab:hover { color: var(--color-text-primary); }
.stab.on { color: #fff; border-bottom-color: var(--color-primary); }
.settings-modal { width: 520px; }
.sub-pane { display: flex; flex-direction: column; }
/* 邀约面板分区卡片：① 选人范围/联系方式 ② 邀约内容 ③ 运行 */
.inv-card { border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 8px 9px; margin: 0 0 8px; }
.inv-card-h { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
/* 标题必须是 flex 项并禁止收缩+折行：右栏只有 320px，裸文本会被当匿名项挤压，
   实测把「选人范围」断成「选人范/围」、并把右侧说明挤成竖排 */
.inv-card-h > .inv-card-t { flex: 0 0 auto; white-space: nowrap; }
.inv-card-h > .row-sub { flex: 1 1 auto; min-width: 0; }
/* 步骤序号做成小圆标，扫一眼就知道到哪一步了 */
.inv-step {
  flex: 0 0 auto; width: 16px; height: 16px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700; color: #fff; background: var(--color-primary);
}
/* 配置摘要：一行一个键值对，长文本截断（细节在下面卡片里） */
.inv-summary {
  display: flex; flex-wrap: wrap; gap: 4px 10px; margin: 0 0 8px;
  padding: 6px 8px; border: 1px dashed var(--color-border); border-radius: var(--radius-sm);
  font-size: 11px; color: var(--color-text-primary);
}
.inv-sum-item { display: inline-flex; gap: 4px; align-items: baseline; min-width: 0; }
.inv-sum-item > i { font-style: normal; color: var(--color-text-secondary); flex: 0 0 auto; }
/* 长说明默认折叠：整块说明文字实测占 648px，展开才看，日常不挡操作 */
.inv-help { margin: 0 0 8px; }
.inv-help > summary {
  cursor: pointer; font-size: 11px; color: var(--color-text-secondary);
  padding: 4px 2px; list-style: none; user-select: none;
  display: flex; align-items: center; gap: 4px;
}
/* 箭头用 CSS 三角，不用字符（'▸' 在本机字体里会落到序号字形，实测显示成「①」） */
.inv-help > summary::before {
  content: ''; flex: 0 0 auto;
  width: 0; height: 0;
  border-left: 4px solid currentColor;
  border-top: 3.5px solid transparent;
  border-bottom: 3.5px solid transparent;
  transition: transform 0.12s ease;
}
.inv-help[open] > summary::before { transform: rotate(90deg); }
.inv-help > summary:hover { color: var(--color-text-primary); }
/* 类目搜索框 + 「展开全部」按钮：34 项铺开占 13 行，默认折叠 */
.inv-cat-search { width: 100%; }
.inv-more { align-self: flex-start; font-size: 11px; }
/* 已选类目回显：一眼看清选了什么，右边给「清空」 */
.inv-picked {
  display: flex; align-items: center; gap: 4px; font-size: 11px;
  color: var(--color-text-primary); background: var(--color-bg-tertiary);
  border-radius: var(--radius-sm); padding: 3px 6px; min-width: 0;
}
.inv-picked > b { font-weight: 600; word-break: break-all; }
/* 运行条吸底：面板内容实测 2200+px 而可视区只有 ~960px，按钮不能只放最底下 */
.inv-run-bar {
  position: sticky; bottom: -1px; z-index: 2;
  background: var(--color-bg-secondary);
  box-shadow: 0 -6px 12px -6px rgba(0, 0, 0, 0.45);
  margin-bottom: 0;
}
.inv-run-bar .cf-btns { align-items: center; }
.inv-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.inv-grid3 .inv-col:last-child { grid-column: 1 / -1; }
.inv-col { display: flex; flex-direction: column; align-items: stretch; gap: 3px; }
.inv-col select { width: 100%; }
/* 任务面板的二级页签：内容区自己的页签行（不参与标题栏拖拽、不占 WCO 那 140px 留白） */
.sub-tabs { display: flex; align-items: center; gap: 4px; margin: 0 0 8px; padding-bottom: 6px; border-bottom: 1px solid var(--color-border); }
.sub-tabs .stab { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; padding: 3px 9px; border-radius: var(--radius-sm); color: var(--color-text-secondary); }
.sub-tabs .stab:hover { background: var(--color-bg-tertiary); }
.sub-tabs .stab.on { color: #fff; background: var(--color-primary); }
.sub-tabs .stab-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-warning, #d9a441); }
/* 达人邀约面板：全部按 [data-test="invite-panel"] 作用域限定，
   避免历史上"通用 .env-sec input 撑爆布局"那类连带影响（右栏只有 320px 宽） */
[data-test="invite-panel"] .inv-row { display: flex; align-items: center; gap: 6px; margin: 6px 0; font-size: 12px; color: var(--color-text-secondary); }
/* 行首标签不收缩、不折行：右栏仅 320px，「本批数量」这类 4 字标签会被挤成竖排（实测踩过）。
   裸文本节点在 flex 里是匿名项，所以模板里已把它们包成 .inv-label。 */
[data-test="invite-panel"] .inv-label { flex: 0 0 auto; white-space: nowrap; }
[data-test="invite-panel"] .inv-block { flex-direction: column; align-items: stretch; gap: 4px; }
[data-test="invite-panel"] select,
[data-test="invite-panel"] textarea,
[data-test="invite-panel"] .inv-num,
[data-test="invite-panel"] .inv-row > input[type="text"] {
  box-sizing: border-box; background: var(--color-bg-tertiary); color: var(--color-text-primary);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  padding: 5px 7px; font-size: 12px; outline: none;
}
[data-test="invite-panel"] select:focus,
[data-test="invite-panel"] textarea:focus,
[data-test="invite-panel"] .inv-num:focus,
[data-test="invite-panel"] .inv-row > input[type="text"]:focus { border-color: var(--color-primary); }
[data-test="invite-panel"] select { flex: 1 1 auto; min-width: 0; }
[data-test="invite-panel"] .inv-row > input[type="text"] { flex: 1 1 auto; min-width: 0; }
[data-test="invite-panel"] textarea { width: 100%; resize: vertical; font-family: inherit; }
[data-test="invite-panel"] .inv-num { width: 64px; flex: 0 0 64px; }
[data-test="invite-panel"] .inv-chips { display: flex; flex-wrap: wrap; gap: 4px; }
[data-test="invite-panel"] .inv-chip {
  display: flex; align-items: center; gap: 3px; font-size: 11px; padding: 2px 7px;
  border: 1px solid var(--color-border); border-radius: 20px; cursor: pointer;
  background: var(--color-bg-tertiary);
}
/* 选中态给**实底**：此前只有蓝色描边（文字仍是白色、底色透明），在深色卡片上不够醒目，
   多选类目时容易看漏自己勾了哪些 */
[data-test="invite-panel"] .inv-chip.on {
  border-color: var(--color-primary); color: #fff; background: var(--color-primary);
}
[data-test="invite-panel"] .inv-chip:hover { border-color: var(--color-primary); }
[data-test="invite-panel"] .inv-chip input { width: auto; margin: 0; flex: 0 0 auto; }
/* 平台首页地址配置行：名称 + 自适应输入 + 恢复默认。宽度按容器算，
   不要写通用 .env-sec input（历史上那条规则把"添加代理"的输入挤到 18px 并让右栏横向溢出） */
.plat-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; }
.plat-name { display: flex; align-items: center; gap: 5px; width: 96px; flex: 0 0 96px; font-size: 12.5px; }
.plat-row input {
  flex: 1 1 auto; min-width: 0; box-sizing: border-box;
  background: var(--color-bg-tertiary); color: var(--color-text-primary);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  padding: 6px 8px; font-size: 12px; outline: none;
}
.plat-row input:focus { border-color: var(--color-primary); }
/* AI 页签的超时是数字框，不该像地址那样占满整行（候选 .inv-num 只作用在邀约面板里） */
[data-test="settings-ai"] .inv-num { flex: 0 0 96px; width: 96px; }
/* 模型下拉与输入框同一行：允许收缩，否则 .modal select{width:100%} 会把行撑出横向溢出 */
[data-test="settings-ai"] .plat-row select { flex: 1 1 auto; min-width: 0; }
.about-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.about-logo { width: 40px; height: 40px; font-size: 20px; border-radius: 10px; }
.about-name { font-size: 15px; font-weight: 600; }
.about-row { display: flex; align-items: center; gap: 10px; font-size: 12.5px; padding: 4px 0; }
.about-row > span { width: 62px; flex: 0 0 62px; color: var(--color-text-secondary); }
.update-version { color: var(--color-text-secondary); font-size: 12px; margin: -8px 0 14px; }
.update-message { min-height: 34px; font-size: 13px; line-height: 1.6; }
.success-text { color: var(--color-success); }
.error-text { color: var(--color-error); }
.update-progress { height: 6px; border-radius: 3px; background: var(--color-bg-tertiary); overflow: hidden; margin: 8px 0 14px; }
.update-progress span { display: block; height: 100%; background: var(--color-primary); transition: width .2s ease; }
/* 通道一行、自动检查独立成行。原先两者挤在一个不换行的 flex 行里：
   "启动时自动检查"被压缩后 nowrap 文本溢出 84px（旧更新对话框就有，只是没人量过）。
   实测 flex-wrap:wrap 也压不住（auto margin + nowrap 的组合），改成两行结构最稳。 */
.update-channel-row { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 12px; color: var(--color-text-secondary); }
.update-channel-row select { width: 138px; }
.update-autocheck { display: flex; align-items: center; gap: 4px; margin: 0 0 12px; font-size: 12px; color: var(--color-text-secondary); white-space: nowrap; cursor: pointer; }
/* .modal input{width:100%} 会连复选框一起撑成整行宽：实测复选框 474px + 文字 84px = 558px，
   把设置弹窗顶出横向滚动条（旧更新对话框同样中招，只是没人量过）。与 .store-pick input 同一处修正。 */
.update-autocheck input[type="checkbox"] { width: auto; margin: 0; flex: 0 0 auto; }

/* 店铺右键菜单 */
.ctx-menu {
  position: fixed; z-index: 300; min-width: 236px; padding: 4px;
  background: var(--color-bg-elevated); border: 1px solid var(--color-border);
  border-radius: var(--radius-sm); box-shadow: 0 10px 28px rgba(0, 0, 0, .5);
}
.ctx-item {
  display: block; width: 100%; text-align: left; background: none; border: 0;
  color: var(--color-text-primary); font-size: 12.5px; padding: 7px 10px;
  border-radius: 4px; cursor: pointer;
}
.ctx-item:hover:not(:disabled) { background: var(--color-bg-tertiary); }
.ctx-item:disabled { opacity: .45; cursor: default; }
.ctx-item.danger { color: var(--color-error); }
.ctx-sep { height: 1px; background: var(--color-border); margin: 4px 2px; }
.store-pick { display: flex; align-items: center; gap: 8px; padding: 5px 2px; font-size: 12.5px; cursor: pointer; }
.store-pick input { width: auto; margin: 0; }
</style>
