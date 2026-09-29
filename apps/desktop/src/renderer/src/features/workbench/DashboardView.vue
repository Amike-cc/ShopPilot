<template>
  <section :class="['dashboard-shell welcome', { 'picker-mode': taskPicking }]" data-test="dashboard-home">
    <aside class="dashboard-sidebar sidebar" :class="{ collapsed: leftSidebarCollapsed }" data-test="sidebar" aria-label="ShopPilot 主导航">
      <div v-if="leftSidebarCollapsed" class="sidebar-rail">
        <button type="button" class="rail-btn" data-test="sidebar-expand" title="展开左侧栏（Ctrl+Shift+E）" @click="setLeftSidebarOpen(true)">›</button>
        <button type="button" class="rail-btn btn-new" data-test="rail-new" title="添加店铺" @click="openStoreCreate">＋</button>
        <button type="button" class="rail-btn" data-test="rail-tasks" title="任务中心" @click="openTasks(false)">☑</button>
        <button type="button" class="rail-btn" data-test="rail-trash" title="回收站" @click="openTrash">
          ♧
          <span v-if="ws.trashStores.length" class="rail-badge" data-test="rail-trash-badge"></span>
        </button>
        <button type="button" class="rail-btn" data-test="rail-settings" title="设置中心" @click="navigateTo('settings')">⚙</button>
      </div>
      <template v-else>
      <div class="dashboard-brand">
        <div class="dashboard-brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 8h16l-1.2 11.2a1.6 1.6 0 0 1-1.6 1.4H6.8a1.6 1.6 0 0 1-1.6-1.4Z" />
            <path d="M8.6 8V6.4a3.4 3.4 0 0 1 6.8 0V8" />
          </svg>
        </div>
        <div class="dashboard-brand-copy">
          <strong>ShopPilot</strong>
          <span>多平台经营工作台</span>
        </div>
        <button type="button" class="sidebar-collapse" data-test="sidebar-collapse" title="收起左侧栏（Ctrl+Shift+E）" @click="setLeftSidebarOpen(false)">‹</button>
      </div>

      <nav class="dashboard-nav" aria-label="主功能导航">
        <template v-for="group in navGroups" :key="group.key">
          <div v-if="group.title" class="nav-group-title">{{ group.title }}</div>
          <button
            v-for="item in group.items"
            :key="item.label"
            type="button"
            :class="['dashboard-nav-item', { active: activeNav === item.label }]"
            :aria-current="activeNav === item.label ? 'page' : undefined"
            @click="handleNav(item)"
          >
            <span class="nav-glyph" aria-hidden="true">{{ item.glyph }}</span>
            <span class="nav-label">{{ item.label }}</span>
          </button>
        </template>
      </nav>

      <div class="dashboard-store-area">
        <div class="store-area-title">
          <span>我的店铺</span>
          <span class="store-count">{{ ws.stores.length }}</span>
          <button type="button" class="add-store-button btn-new" title="添加店铺" @click="openStoreCreate">＋</button>
        </div>
        <div class="store-area-body">
          <div v-if="!ws.ready" class="sidebar-state">正在读取店铺…</div>
          <div v-else-if="!ws.stores.length" class="sidebar-state">
            <span>暂无店铺</span>
            <button type="button" class="inline-link" @click="navigateTo('stores')">添加第一家店铺</button>
          </div>
          <div v-else class="store-groups">
            <button
              v-for="store in ws.stores"
              :key="store.id"
              type="button"
              :class="['dashboard-store-row', 'store-card', { displayed: ws.displayedStoreId === store.id }]"
              data-test="store-card"
              :data-store-id="store.id"
              :title="`打开 ${store.name}`"
              @click="openStoreFromPage(store.id)"
              @contextmenu.prevent="openStoreContext(store, $event)"
            >
              <PlatformIcon :name="store.platform" :size="22" />
              <span class="dashboard-store-name store-name">{{ store.name }}</span>
              <span class="store-online-label"><i :class="['store-status-dot', statusClass(store.status)]" aria-hidden="true"></i>{{ statusLabel(store.status) }}</span>
              <span
                class="store-action"
                role="button"
                tabindex="0"
                :title="`打开 ${store.name}`"
                aria-label="打开浏览器"
                @click.stop="openStoreFromPage(store.id)"
                @keydown.enter.stop.prevent="openStoreFromPage(store.id)"
                @keydown.space.stop.prevent="openStoreFromPage(store.id)"
              >▶</span>
            </button>
          </div>
        </div>
      </div>

      <div class="dashboard-sidebar-footer">
        <button type="button" class="pro-card" @click="navigateTo('settings')">
          <span class="pro-avatar" aria-hidden="true">SP</span>
          <span class="pro-copy"><strong>ShopPilot Pro</strong><span class="pro-badge">专业版</span></span>
          <span class="pro-arrow" aria-hidden="true">›</span>
        </button>
        <div class="foot-row">
          <button
            type="button"
            :class="['dashboard-nav-item', 'foot-btn', 'foot-settings', { active: activeNav === '设置中心' }]"
            data-test="settings-open-btn"
            @click="handleNav(settingsNav)"
          >
            <span class="nav-glyph" aria-hidden="true">⚙</span>
            <span class="nav-label">设置</span>
          </button>
          <button type="button" class="foot-btn foot-icon" data-test="trash-open" title="回收站" aria-label="回收站" @click="openTrash">
            🗑<span v-if="ws.trashStores.length" class="badge">{{ ws.trashStores.length }}</span>
          </button>
        </div>
      </div>
      </template>
    </aside>

    <main class="dashboard-main">
      <header class="dashboard-toolbar">
        <div class="toolbar-crumb" aria-label="当前位置">
          <span class="crumb-root">工作台</span>
          <span class="crumb-sep" aria-hidden="true">/</span>
          <span class="crumb-current">{{ pageTitle }}</span>
        </div>
        <div class="toolbar-actions">
          <button type="button" class="toolbar-datetime" title="时间取自本机系统时钟" @click="showNotice('时间取自本机系统时钟；采集周期与调用记录都以它为准')">
            <span class="dt-icon" aria-hidden="true">▦</span>{{ nowLabel }}<span class="dt-caret" aria-hidden="true">⌄</span>
          </button>
          <button type="button" class="toolbar-icon-button" title="通知" @click="showNotice('通知中心暂未接入独立页面')">
            <span aria-hidden="true">♧</span>
            <i v-if="activeTaskCount" class="notification-dot" aria-label="有进行中的任务"></i>
          </button>
          <button type="button" class="toolbar-icon-button" title="帮助（Ctrl+K 打开命令面板）" @click="showNotice('按 Ctrl+K 打开命令面板；店铺、任务与设置入口在左栏与各页面内')">?</button>
          <span class="toolbar-avatar" aria-hidden="true" title="ShopPilot Pro">SP</span>
        </div>
      </header>

      <!-- 店铺 guest 宿主：只要还有店铺处于打开状态就持续挂载，切到别的页面时只隐藏不销毁。
           销毁会连带销毁 webview 元素（也就是 guest 渲染进程），重开会丢掉页面状态、登录流程
           中间步骤与已选的达人分页；隐藏则只影响可见性与命中，页面继续活着。 -->
      <div
        v-if="browserHostMounted"
        :class="['dashboard-browser-host', { active: browserHostActive }]"
        data-test="dashboard-browser-host"
      >
        <DashboardBrowserSurface
          :picker-mode="taskPicking"
          :active="browserHostActive"
          @back-dashboard="goOverview"
          @open-tasks="openTasks"
        />
      </div>
      <UnifiedTaskPage
        v-if="activePage === 'browser' && taskOverlay"
        :auto-create="taskAutoCreate"
        :overlay="true"
        @picking-change="setTaskPicking"
        @close="closeTaskOverlay"
        @open-store="openStoreFromPage"
      />
      <UnifiedStorePage v-else-if="activePage === 'stores'" @open-store="openStoreFromPage" />
      <UnifiedDataPage v-else-if="activePage === 'analytics'" mode="analytics" @change-mode="changeDataPage" @open-store="openStoreFromPage" />
      <UnifiedDataPage v-else-if="activePage === 'orders'" mode="orders" @change-mode="changeDataPage" @open-store="openStoreFromPage" />
      <UnifiedDataPage v-else-if="activePage === 'invoices'" mode="invoices" @change-mode="changeDataPage" @open-store="openStoreFromPage" />
      <UnifiedTaskPage v-else-if="activePage === 'tasks'" :auto-create="taskAutoCreate" @open-store="openStoreFromPage" />
      <UnifiedSettingsPage v-else-if="activePage === 'settings'" :initial-tab="settingsTab" @close="closeSettings" />
      <UnifiedImageStudioPage v-else-if="activePage === 'image-studio'" @open-settings="openImageSettings" @open-assistant="openAssistant" />
      <UnifiedAppsPage v-else-if="activePage === 'products' || activePage === 'ai' || activePage === 'apps'" :mode="activePage" @navigate="navigateTo" @open-store="openStoreFromPage" @open-assistant="openAssistant" />
      <div v-else-if="activePage === 'overview'" class="overview-page">
        <div v-if="dataState === 'error'" class="dashboard-error" role="alert">
          <span class="state-icon">!</span>
          <span>{{ dataError || '首页数据暂时无法读取' }}</span>
          <button type="button" @click="loadDashboardData">重试</button>
        </div>

        <div class="ov-grid">
          <div class="ov-col-main">
            <section id="sales-trend" class="ov-card ov-card-dark">
              <div class="ov-card-head">
                <div class="ov-card-title">
                  <div class="ov-title-row">
                    <h2>销售概览</h2>
                    <button type="button" class="ov-refresh" data-test="overview-refresh" :disabled="collectState.running || dataState === 'loading'" @click="refreshData">
                      <span aria-hidden="true">⟳</span>{{ refreshLabel }}
                    </button>
                  </div>
                  <span>核心经营指标</span>
                </div>
                <div class="ov-card-tools">
                  <div class="period-tabs" role="tablist" aria-label="统计范围">
                    <button v-for="periodOption in periodOptions" :key="periodOption.key" type="button" :class="{ active: period === periodOption.key }" @click="period = periodOption.key">{{ periodOption.label }}</button>
                  </div>
                  <select v-model="selectedPlatform" class="platform-select" aria-label="平台筛选">
                    <option value="all">全部平台</option>
                    <option v-for="platform in platformOptions" :key="platform" :value="platform">{{ platform }}</option>
                  </select>
                </div>
              </div>

              <div class="ov-kpis">
                <div v-for="kpi in kpiRow" :key="kpi.key" :class="['ov-kpi', `tone-${kpi.tone}`]" :title="kpi.hint">
                  <span class="kpi-label">{{ kpi.label }}</span>
                  <strong class="kpi-value" :class="{ placeholder: kpi.value === '—' }">{{ kpi.value }}</strong>
                  <span v-if="kpi.delta !== null" :class="['kpi-delta', deltaClass(kpi)]">{{ kpi.delta >= 0 ? '↑' : '↓' }} {{ Math.abs(kpi.delta).toFixed(1) }}%</span>
                  <span v-else class="kpi-delta muted">{{ kpi.note }}</span>
                </div>
              </div>

              <div class="trend-chart-wrap">
                <div v-if="snapshotState === 'loading' || collectedState === 'loading'" class="section-state chart-state"><span class="loader"></span> 正在读取趋势数据…</div>
                <div v-else-if="snapshotState === 'error' && collectedState === 'error'" class="section-state chart-state error-state">趋势数据读取失败 <button type="button" @click="loadSnapshots(); loadCollectedMetrics()">重试</button></div>
                <div v-else-if="!trendPlot.length" class="section-state chart-state"><span class="empty-chart-icon">⌁</span><strong>暂无可用趋势数据</strong><span>{{ trendEmptyHint }}</span></div>
                <template v-else>
                  <svg class="trend-chart" viewBox="0 0 900 260" role="img" aria-label="销售额和订单数趋势图" @mouseleave="hoveredPoint = null">
                    <defs>
                      <linearGradient id="gmv-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8b6cff" stop-opacity=".38" /><stop offset="1" stop-color="#8b6cff" stop-opacity="0" /></linearGradient>
                    </defs>
                    <g class="chart-grid">
                      <template v-for="tick in chartYAxis" :key="tick.value">
                        <line x1="62" :y1="tick.y" x2="874" :y2="tick.y" />
                        <text class="chart-y-label" x="48" :y="tick.y + 4" text-anchor="end">{{ tick.label }}</text>
                      </template>
                      <line v-for="point in trendPlot" :key="`v-${point.key}`" class="chart-grid-v" :x1="point.x" y1="18" :x2="point.x" y2="216" />
                    </g>
                    <path v-if="gmvAreaPath" :d="gmvAreaPath" class="chart-area gmv-area" />
                    <path v-if="orderPath" :d="orderPath" class="chart-line order-line" />
                    <path v-if="gmvPath" :d="gmvPath" class="chart-line gmv-line" />
                    <g v-for="point in trendPlot" :key="point.key">
                      <text class="chart-x-label" :x="point.x" y="244" text-anchor="middle">{{ point.label }}</text>
                      <circle v-if="point.gmvY !== null" class="chart-point gmv-point" :cx="point.x" :cy="point.gmvY" r="3.5" @mouseenter="hoveredPoint = point" />
                      <circle v-if="point.ordersY !== null" class="chart-point order-point" :cx="point.x" :cy="point.ordersY" r="3" @mouseenter="hoveredPoint = point" />
                    </g>
                    <line v-if="hoveredPoint" class="chart-guide" :x1="hoveredPoint.x" y1="14" :x2="hoveredPoint.x" y2="216" />
                    <circle v-if="hoveredPoint && hoveredPoint.gmvY !== null" class="chart-hover-dot gmv" :cx="hoveredPoint.x" :cy="hoveredPoint.gmvY" r="4.5" />
                    <circle v-if="hoveredPoint && hoveredPoint.ordersY !== null" class="chart-hover-dot orders" :cx="hoveredPoint.x" :cy="hoveredPoint.ordersY" r="4.5" />
                  </svg>
                  <div v-if="hoveredPoint" class="trend-tooltip" :style="tooltipStyle">
                    <strong>{{ hoveredPoint.fullLabel }}</strong>
                    <span v-if="hoveredPoint.gmv !== null"><i class="tooltip-dot gmv"></i>销售额 <b>{{ formatNumber(hoveredPoint.gmv) }}</b></span>
                    <span v-if="hoveredPoint.orders !== null"><i class="tooltip-dot orders"></i>订单数 <b>{{ formatNumber(hoveredPoint.orders) }}</b></span>
                  </div>
                  <div class="chart-legend">
                    <span><i class="legend-dot gmv"></i>销售额</span>
                    <span><i class="legend-dot orders"></i>订单数</span>
                  </div>
                </template>
              </div>
              <p class="ov-card-caption">{{ trendCaption }}</p>
            </section>

            <section id="quick-start" class="ov-card">
              <div class="ov-card-head"><div class="ov-card-title"><h2>快捷操作</h2><span>常用能力一键直达</span></div></div>
              <div class="shortcut-grid">
                <article v-for="tile in quickActions" :key="tile.key" :class="['shortcut-tile', `tone-${tile.tone}`, { disabled: !tile.available }]">
                  <span class="tile-icon" aria-hidden="true">{{ tile.icon }}</span>
                  <div class="tile-copy"><strong>{{ tile.label }}</strong><small>{{ tile.description }}</small></div>
                  <button type="button" class="tile-action" :disabled="!tile.available" @click="handleQuickAction(tile)">{{ tile.available ? `${tile.actionLabel} →` : '待接入' }}</button>
                </article>
              </div>
            </section>
          </div>

          <aside class="ov-col-rail">
            <section id="platform-sync" class="ov-card ov-sync">
              <div class="ov-card-head">
                <div class="ov-card-title"><h2>平台同步状态</h2></div>
                <span class="ov-pill success">{{ platformOnlineSummary }}</span>
              </div>
              <div v-if="!platformSyncRows.length" class="ov-empty">暂无店铺连接</div>
              <div v-for="row in platformSyncRows" :key="row.name" class="sync-row">
                <PlatformIcon :name="row.name" :size="34" />
                <div class="sync-copy"><strong>{{ row.name }}</strong><span>{{ row.count }} 家店铺</span></div>
                <div class="sync-meta"><span :class="['sync-dot', row.state]"></span><strong>{{ row.stateLabel }}</strong><small>{{ row.lastSync }}</small></div>
              </div>
              <button type="button" class="ov-link" @click="navigateTo('stores')">管理店铺 <span aria-hidden="true">→</span></button>
            </section>

            <section id="ai-assistant" class="ov-card ov-ai">
              <div class="ov-ai-glow" aria-hidden="true"></div>
              <div class="ov-ai-copy">
                <h2><span aria-hidden="true">✦</span> AI 电商助手</h2>
                <p>创作、优化、分析，一站完成</p>
                <button type="button" class="ov-ai-button" @click="openAssistant">开始对话 <span aria-hidden="true">→</span></button>
              </div>
            </section>

            <section id="ai-tasks" class="ov-card ov-todo">
              <div class="ov-card-head">
                <div class="ov-card-title"><h2>待办任务</h2></div>
                <span class="ov-pill info">{{ pendingTasks.length }} 项待处理</span>
                <button type="button" class="ov-link inline" @click="navigateTo('tasks')">查看全部 <span aria-hidden="true">→</span></button>
              </div>
              <div v-if="taskState === 'loading'" class="ov-empty"><span class="loader"></span> 正在读取任务…</div>
              <div v-else-if="!pendingTasks.length" class="ov-empty">暂无待办：没有等待确认、失败或进行中的任务</div>
              <ul v-else class="todo-list">
                <li v-for="item in pendingTasks" :key="item.id" class="todo-item">
                  <span class="todo-check" aria-hidden="true"></span>
                  <span class="todo-title" :title="item.name">{{ item.name }}</span>
                  <span :class="['todo-chip', item.tone]">{{ item.badge }}</span>
                </li>
              </ul>
              <button type="button" class="todo-add" @click="openTasks(true)">＋ 新建任务</button>
            </section>
          </aside>
        </div>
      </div>
    </main>

    <div v-if="storeContext.open && storeContext.store" class="dashboard-context-menu" data-test="store-ctx" :style="{ left: `${storeContext.x}px`, top: `${storeContext.y}px` }" @click.stop>
      <button type="button" class="ctx-item" data-test="ctx-toggle" @click="storeContextAction('toggle')">{{ ws.openStoreIds.includes(storeContext.store.id) ? '关闭浏览器' : '打开浏览器' }}</button>
      <button type="button" class="ctx-item" data-test="ctx-standalone" :disabled="!canOpenStandalone" @click="storeContextAction('standalone')">在独立窗口打开当前标签页</button>
      <div class="ctx-sep"></div>
      <button type="button" class="ctx-item" data-test="ctx-rename" @click="storeContextAction('rename')">重命名…</button>
      <button type="button" class="ctx-item" data-test="ctx-copycfg" :disabled="otherStoreOptions.length === 0" @click="storeContextAction('copycfg')">复制环境配置到其他店铺…</button>
      <button type="button" class="ctx-item" data-test="ctx-copyid" @click="storeContextAction('copyid')">复制店铺 ID</button>
      <div class="ctx-sep"></div>
      <button type="button" class="ctx-item danger" data-test="ctx-trash" @click="storeContextAction('trash')">移入回收站</button>
    </div>

    <div v-if="renameDialog.open" class="dashboard-overlay" data-test="rename-dialog" @click.self="renameDialog.open = false">
      <section class="dashboard-dialog" role="dialog" aria-modal="true" aria-label="重命名店铺">
        <h2>重命名店铺</h2>
        <input v-model="renameDialog.value" data-test="rename-input" maxlength="60" placeholder="店铺名称" @keydown.enter="saveStoreRename" />
        <div class="dashboard-dialog-actions"><button type="button" class="unified-button" @click="renameDialog.open = false">取消</button><button type="button" class="unified-button primary" data-test="rename-save" :disabled="!renameDialog.value.trim()" @click="saveStoreRename">保存</button></div>
      </section>
    </div>

    <div v-if="copyConfigDialog.open" class="dashboard-overlay" data-test="copy-config-dialog" @click.self="copyConfigDialog.open = false">
      <section class="dashboard-dialog" role="dialog" aria-modal="true" aria-label="复制环境配置">
        <h2>复制环境配置</h2>
        <p class="dashboard-dialog-note">只复制环境指纹配置，不含 Cookie 会话和代理凭据。</p>
        <label v-for="store in otherStoreOptions" :key="store.id" class="store-pick"><input v-model="copyConfigDialog.targets" type="checkbox" :value="store.id" data-test="pick-target" /><span>{{ store.name }}</span></label>
        <div class="dashboard-dialog-actions"><button type="button" class="unified-button" @click="copyConfigDialog.open = false">取消</button><button type="button" class="unified-button primary" data-test="copy-apply" :disabled="!copyConfigDialog.targets.length" @click="applyStoreConfigCopy">复制到选中店铺</button></div>
      </section>
    </div>

    <div v-if="confirmDialog.open" class="dashboard-overlay" data-test="confirm-dialog" @click.self="confirmDialog.open = false">
      <section class="dashboard-dialog" role="dialog" aria-modal="true" aria-label="确认操作">
        <h2>{{ confirmDialog.title }}</h2><p class="dashboard-dialog-note">{{ confirmDialog.message }}</p>
        <div class="dashboard-dialog-actions"><button type="button" class="unified-button" @click="confirmDialog.open = false">取消</button><button type="button" class="unified-button danger" data-test="confirm-ok" @click="runConfirmDialog">确认</button></div>
      </section>
    </div>

    <div v-if="createStoreDialog.open" class="modal-mask" data-test="store-create-dialog" @click.self="createStoreDialog.open = false">
      <form class="modal store-create-modal" @submit.prevent="submitStoreCreate">
        <h2>添加店铺</h2>
        <label class="modal-field">店铺名称<input v-model="createStoreDialog.name" data-test="store-name" required placeholder="例如：美国主站" /></label>
        <label class="modal-field">平台<select v-model="createStoreDialog.platform" data-test="platform-select" data-unified-test="store-platform" @change="onCreatePlatformChange"><option v-for="platform in availablePlatforms" :key="platform.name" :value="platform.name">{{ platform.name }}</option><option value="其他">其他（自定义平台）</option></select></label>
        <label class="modal-field">后台地址<input v-model="createStoreDialog.adminUrl" data-test="admin-url" required placeholder="https://…" /><span v-if="createStoreDialog.adminUrl" class="field-note">已按所选平台填入默认后台地址，可自行修改</span></label>
        <div v-if="createStoreError" class="dashboard-dialog-note error-state">{{ createStoreError }}</div>
        <div class="modal-actions"><button type="button" class="btn-ghost" @click="createStoreDialog.open = false">取消</button><button type="submit" class="btn-primary" :disabled="createStoreBusy || !createStoreDialog.name.trim() || !createStoreDialog.adminUrl.trim()">{{ createStoreBusy ? '创建中…' : '创建' }}</button></div>
      </form>
    </div>

    <div v-if="ws.trashOpen" class="modal-mask" data-test="trash-dialog" @click.self="closeTrash">
      <div class="modal" role="dialog" aria-modal="true" aria-label="回收站">
        <h2>回收站</h2>
        <div v-if="!ws.trashStores.length" class="empty-hint">回收站是空的</div>
        <div v-for="trashStore in ws.trashStores" :key="trashStore.id" class="trash-row">
          <PlatformIcon :name="trashStore.platform" :size="28" />
          <div class="trash-meta"><div>{{ trashStore.name }}</div><div class="row-sub">{{ trashStore.platform }}</div></div>
          <button type="button" class="btn-ghost sm" @click="ws.restoreStore(trashStore.id)">恢复</button>
          <button type="button" class="btn-danger sm" @click="confirmPurge(trashStore)">彻底删除</button>
        </div>
        <div class="modal-actions"><button type="button" class="btn-ghost" @click="closeTrash">关闭</button></div>
      </div>
    </div>

    <div v-if="notice" class="dashboard-notice" role="status">{{ notice }}</div>
    <div class="dashboard-toast-host" aria-live="polite" aria-atomic="false">
      <div v-for="toast in ws.toasts" :key="toast.id" :class="['dashboard-toast', 'toast', toast.kind]">{{ toast.text }}</div>
    </div>

    <div v-if="commandOpen" class="command-backdrop" @click.self="commandOpen = false">
      <section class="command-palette" role="dialog" aria-modal="true" aria-label="全局搜索">
        <div class="command-search"><span aria-hidden="true">⌕</span><input ref="commandInput" v-model="globalQuery" autofocus placeholder="搜索功能、店铺或任务…" @keydown.esc="commandOpen = false" /></div>
        <div v-if="commandResults.length" class="command-results"><button v-for="result in commandResults" :key="result.key" type="button" @click="runCommand(result)"><span class="command-result-icon">{{ result.icon }}</span><span><strong>{{ result.label }}</strong><small>{{ result.description }}</small></span><kbd>↵</kbd></button></div>
        <div v-else class="command-empty">没有匹配的功能或店铺</div>
      </section>
    </div>

    <AgentDock
      :store-name="''"
      :tab-title="'首页 Dashboard'"
      :current-url="''"
      :locked="ws.appLocked"
      @view-tasks="navigateTo('tasks')"
      @view-task="navigateTo('tasks')"
      @view-agents="openAgentSettings"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import PlatformIcon from '../../components/PlatformIcon.vue'
import AgentDock from '../agent/AgentDock.vue'
import DashboardBrowserSurface from './DashboardBrowserSurface.vue'
import UnifiedImageStudioPage from './UnifiedImageStudioPage.vue'
import UnifiedAppsPage from './UnifiedAppsPage.vue'
import UnifiedDataPage from './UnifiedDataPage.vue'
import UnifiedSettingsPage from './UnifiedSettingsPage.vue'
import UnifiedStorePage from './UnifiedStorePage.vue'
import UnifiedTaskPage from './UnifiedTaskPage.vue'
import { useAgentStore } from '../../stores/agent'
import { useWorkspaceStore, type StoreRow } from '../../stores/workspace'
import type { SalesMetrics, SalesMetricsPlanView } from '@shared/contracts/sales-metrics'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'

type LoadState = 'loading' | 'ready' | 'empty' | 'error'
type PeriodKey = 'today' | 'yesterday' | '7d' | '30d' | 'custom'

interface SnapshotRow {
  id: string
  metric: string
  value: unknown
  sourceRunId?: string | null
  capturedAt: number
  storeId: string
  storeName: string
  platform: string
}

const emit = defineEmits<{
  'open-store': [storeId: string]
}>()

const ws = useWorkspaceStore()
const agent = useAgentStore()
const navItems = [
  { label: '经营总览', glyph: '⌂' },
  { label: '商品管理', glyph: '◈' },
  // 订单管理不在侧栏（设计稿只有 经营总览/商品管理/店铺管理 三项）：
  // 页面本身保留，入口是命令面板（Ctrl+K → 最近订单）与「数据分析 → 订单明细」。
  { label: '店铺管理', glyph: '▣' },
  { label: 'AI 创作', glyph: '✦' },
  { label: '数据分析', glyph: '◫' },
  { label: '应用中心', glyph: '⊞' }
]
const activeNav = ref('经营总览')
/** 侧栏导航分组（设计稿：主功能区三项 + 「智能运营」三项；设置单独落在左下角） */
const navGroups = computed(() => [
  { key: 'main', title: '', items: navItems.filter(item => ['经营总览', '商品管理', '店铺管理'].includes(item.label)) },
  { key: 'smart', title: '智能运营', items: navItems.filter(item => ['AI 创作', '数据分析', '应用中心'].includes(item.label)) }
])
/** 左下角「设置」入口（设计稿放在侧栏底部，不在主分组里；仍用 .dashboard-nav-item 语义保证高亮与跳转一致） */
const settingsNav = { label: '设置中心', glyph: '⚙' }
/** 顶栏面包屑右侧的当前页名（与导航标签同源，不另造一套文案） */
const PAGE_TITLES: Record<string, string> = {
  overview: '经营总览', browser: '店铺工作台', products: '商品管理', orders: '订单管理', stores: '店铺管理',
  ai: 'AI 创作', analytics: '数据分析', invoices: '发票中心', apps: '应用中心', settings: '设置中心',
  tasks: '任务中心', 'image-studio': '图片工作台'
}
const pageTitle = computed(() => PAGE_TITLES[activePage.value] || '经营总览')
/** 顶栏时间（设计稿里是实时时钟；每秒走一格，和系统时间一致） */
const nowLabel = ref('')
let clockTimer: number | undefined
function tickClock() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  nowLabel.value = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
type DashboardPage = 'overview' | 'browser' | 'products' | 'orders' | 'stores' | 'ai' | 'analytics' | 'apps' | 'settings' | 'tasks' | 'invoices' | 'image-studio'
type SettingsTab = 'config' | 'square' | 'ai' | 'agents' | 'skills' | 'plugins' | 'about'
const activePage = ref<DashboardPage>('overview')
const settingsReturnPage = ref<DashboardPage>('overview')
const settingsReturnStoreId = ref<string | null>(null)
const settingsTab = ref<SettingsTab>('config')
const taskAutoCreate = ref(false)
const taskOverlay = ref(false)
const taskPicking = ref(false)
/** 有店铺处于打开状态 → guest 宿主常驻（页面状态不因切页丢失）。 */
const browserHostMounted = computed(() => ws.openStoreIds.length > 0)
/** 宿主是否真的显示给用户：在浏览器页且确实显示着某家店铺。 */
const browserHostActive = computed(() => activePage.value === 'browser' && !!ws.displayedStoreId)
/** 采集数据的定时刷新只在总览页有意义（别的页面不显示这些卡片，白刷就是白耗） */
const isOnOverview = computed(() => activePage.value === 'overview')
const storeContext = reactive({ open: false, x: 0, y: 0, store: null as StoreRow | null })
const renameDialog = reactive({ open: false, value: '' })
const copyConfigDialog = reactive({ open: false, sourceId: '', sourceName: '', targets: [] as string[] })
const confirmDialog = reactive({ open: false, title: '', message: '', action: null as null | (() => Promise<void>) })
const createStoreDialog = reactive({ open: false, name: '', platform: '拼多多', adminUrl: '' })
const createStoreError = ref('')
const createStoreBusy = ref(false)
const availablePlatforms = ((window.shopilot.platforms || []) as Array<{ name: string; adminUrl: string }>)
const leftSidebarCollapsed = ref(false)
const globalQuery = ref('')
const commandOpen = ref(false)
const commandInput = ref<HTMLInputElement | null>(null)
const notice = ref('')
const period = ref<PeriodKey>('7d')
const selectedPlatform = ref('all')
const dataState = ref<LoadState>('loading')
const dataError = ref('')
const taskState = ref<LoadState>('loading')
const snapshotState = ref<LoadState>('loading')
const snapshotPartial = ref(false)
const snapshots = ref<SnapshotRow[]>([])
const hoveredPoint = ref<any | null>(null)
let noticeTimer: number | undefined
let loadingSnapshots = false
let stopStoreWatch: (() => void) | null = null

// 设计稿的周期页签顺序：今日 / 昨日 / 近 7 天(默认) / 近 30 天 / 自定义日期
const periodOptions: Array<{ key: PeriodKey; label: string }> = [
  { key: 'today', label: '今日' }, { key: 'yesterday', label: '昨日' }, { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' }, { key: 'custom', label: '自定义日期' }
]
const quickActions = [
  { key: 'image', label: 'AI 生成商品图', description: '一键生成专业商品图', icon: '▣', tone: 'purple', available: true, actionLabel: '立即创作' },
  { key: 'publish', label: '批量发布商品', description: '高效上架多平台商品', icon: '▤', tone: 'blue', available: false, actionLabel: '待接入' },
  { key: 'dedupe', label: '短视频去重', description: '检测相似视频内容', icon: '▶', tone: 'teal', available: false, actionLabel: '待接入' },
  { key: 'interference', label: '影像级干扰', description: '智能处理商品图片', icon: '▧', tone: 'rose', available: false, actionLabel: '待接入' }
]

const platformOptions = computed(() => [...new Set(snapshots.value.map(item => item.platform))].sort((a, b) => a.localeCompare(b, 'zh-CN')))
const activeTaskCount = computed(() => ws.tasks.filter((task: any) => task.latestRun && isTaskActive(task)).length)
const otherStoreOptions = computed(() => ws.stores.filter(store => store.id !== storeContext.store?.id))
const canOpenStandalone = computed(() => !!storeContext.store && ws.displayedStoreId === storeContext.store.id && !!ws.activeTab)

const numeric = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[￥¥,\s]/g, ''))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
const formatNumber = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value)
const formatTime = (value: number | null | undefined) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '尚未同步'

/** 任务快照（store_snapshots）里的指标合计：自动采集缺该字段时的兜底来源 */
function metricAggregate(metric: string, platform = 'all') {
  const rows = snapshots.value.filter(row => row.metric === metric && (platform === 'all' || row.platform === platform))
  const latest = rows.reduce((sum, row) => sum + (numeric(row.value) || 0), 0)
  return rows.length && rows.some(row => numeric(row.value) !== null) ? latest : null
}

// ---------- 自动采集的经营指标（每 10 分钟一次，落 sales_metrics） ----------
// 经营总览过去只读 store_snapshots，而那张表只由「带 metric 的任务步骤」和手动录入写入：
// 自动采集跑得再勤，页面上的数字也不动（2026-09-28 用户实报"数据还是没有正常更新到软件"，
// 实测卡片显示的是 9/13 的旧快照值）。现在卡片与趋势优先用采集数据，规则如下：
//   · 只在**同一口径**（periodType）内相加：今日累计 / 近 7 天滚动 / 近 30 天滚动不能混加；
//   · 采集数据缺失时才回落到任务快照，并在卡片上标明来源（数字必须能说清"从哪来、什么时候"）；
//   · 订单数取 paidOrderCount（平台页面上的"成交订单"），无值时如实显示"该口径未提供"。
type CollectedPeriodType = 'TODAY' | 'LAST_7_DAYS' | 'LAST_30_DAYS'
const PERIOD_TO_TYPE: Record<PeriodKey, CollectedPeriodType> = { today: 'TODAY', yesterday: 'YESTERDAY', '7d': 'LAST_7_DAYS', '30d': 'LAST_30_DAYS', custom: 'LAST_30_DAYS' }
const PERIOD_CAPTION: Record<PeriodKey, string> = { today: '今日累计', yesterday: '昨日', '7d': '近 7 天滚动', '30d': '近 30 天滚动', custom: '近 30 天滚动' }

interface CollectedStore { storeId: string; storeName: string; platform: string; plan: SalesMetricsPlanView; series: SalesMetrics[] }
const collectedStores = ref<CollectedStore[]>([])
const collectedState = ref<LoadState>('loading')
const collectedFetchedAt = ref<number | null>(null)

/** 相对时间：让"数据有多新"一眼可见（采集是最多 10 分钟一轮） */
function relativeTime(ts: number | null | undefined): string {
  if (!ts) return '尚未采集'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86400_000)} 天前`
}

async function loadCollectedMetrics() {
  collectedState.value = 'loading'
  try {
    await waitForWorkspace()
    const periodType = PERIOD_TO_TYPE[period.value]
    // 计划列表带每店的采集状态/原因（拼多多=来源未验证就是从这里来的），一次调用即可
    const plansRes = await window.shopilot.salesMetrics.plans()
    const plans = (plansRes.ok ? (plansRes.data?.items || []) : []) as SalesMetricsPlanView[]
    const settled = await Promise.allSettled(plans.map(async plan => {
      const listRes = await window.shopilot.salesMetrics.list({ storeId: plan.storeId, periodType, pageSize: 120 })
      const series = (listRes.ok ? (listRes.data?.items || []) : []) as SalesMetrics[]
      return { storeId: plan.storeId, storeName: plan.storeName, platform: plan.platform, plan, series } as CollectedStore
    }))
    collectedStores.value = settled.filter((r): r is PromiseFulfilledResult<CollectedStore> => r.status === 'fulfilled').map(r => r.value)
    collectedFetchedAt.value = Date.now()
    collectedState.value = collectedStores.value.some(row => row.series.length) ? 'ready' : 'empty'
  } catch {
    collectedState.value = 'error'
  }
}

const collectedRows = computed(() => collectedStores.value.filter(row => selectedPlatform.value === 'all' || row.platform === selectedPlatform.value))
/** 每店在该口径下的最新一条（列表按 period_end/collected_at 倒序） */
const collectedLatest = computed(() => collectedRows.value
  .map(row => ({ row, metric: row.series[0] as SalesMetrics | undefined }))
  .filter((item): item is { row: CollectedStore; metric: SalesMetrics } => !!item.metric))

function collectedSum(pick: (metric: SalesMetrics) => number | null, scale = 1): { value: number | null; covered: number; total: number; partial: boolean } {
  const rows = collectedLatest.value
  let sum = 0
  let covered = 0
  let partial = false
  for (const item of rows) {
    const raw = pick(item.metric)
    if (raw === null || raw === undefined) { partial = true; continue }
    sum += raw * scale
    covered++
  }
  return { value: covered ? sum : null, covered, total: collectedRows.value.length, partial }
}
/**
 * 与"上一个采集日"比：采集是按天原地更新，同一天多次采集之间比没有意义（差值为 0 会被误读成"没变化"）。
 * 因此每店只找**日历日不同**的上一条；没有跨天数据就返回 null，卡片改显示采集覆盖度说明。
 */
function collectedDelta(pick: (metric: SalesMetrics) => number | null, scale = 1): number | null {
  const dayKeyOf = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }
  let current = 0
  let previous = 0
  let hasCurrent = false
  let hasPrevious = false
  for (const row of collectedRows.value) {
    const newest = row.series[0]
    if (!newest) continue
    const newestDay = dayKeyOf(newest.collectedAt)
    const older = row.series.find(metric => dayKeyOf(metric.collectedAt) !== newestDay)
    const cur = pick(newest)
    const prev = older ? pick(older) : null
    if (cur !== null) { current += cur * scale; hasCurrent = true }
    if (prev !== null) { previous += prev * scale; hasPrevious = true }
  }
  if (!hasCurrent || !hasPrevious || previous === 0) return null
  return ((current - previous) / Math.abs(previous)) * 100
}
function collectedNote(stat: { covered: number; total: number; partial: boolean }): string {
  if (!stat.total) return '尚无采集计划'
  if (!stat.covered) return `${PERIOD_CAPTION[period.value]}未采集到该字段`
  return `${stat.covered}/${stat.total} 家 · ${relativeTime(collectedFreshestAt.value)}${stat.partial ? ' · 部分字段' : ''}`
}
const collectedFreshestAt = computed(() => {
  const times = collectedLatest.value.map(item => item.metric.collectedAt).filter((ts): ts is number => Number.isFinite(ts))
  return times.length ? Math.max(...times) : null
})
const collectedMoney = computed(() => collectedSum(m => m.grossSalesAmountMinor, 0.01))
const collectedOrders = computed(() => collectedSum(m => m.paidOrderCount))

const legacyOrders = computed(() => metricAggregate('biz.orders'))
const legacyGmv = computed(() => metricAggregate('biz.gmv'))

/**
 * 销售概览 KPI 行（设计稿的六项）。
 *
 * 数据规则与页面其余部分一致：**优先自动采集**，采集缺该字段时回落到任务快照并标注来源。
 * 「投放花费」只有抖店（「投放消耗」）与拼多多（「推广花费」）有可读来源，其余平台留空并如实标注；
 * 「投产比 ROI」只拿**同一批既报了成交额又报了投放花费的店铺**相除——不把没有花费来源的店铺的
 * 成交额算进分子，否则 ROI 会凭空变好（分母缺项而分子齐全，是这类指标最常见的造假方式）。
 */
interface KpiRowItem { key: string; label: string; tone: string; value: string; delta: number | null; note: string; hint: string; inverse?: boolean }
const formatMoneyCompact = (value: number | null) => value === null ? '—' : `¥ ${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value)}`
const collectedRefundAmount = computed(() => collectedSum(m => m.refundAmountMinor, 0.01))
const collectedRefundOrders = computed(() => collectedSum(m => m.refundOrderCount))
const collectedAdSpend = computed(() => collectedSum(m => m.adSpendMinor, 0.01))
/** 投产比只用"有花费也有成交额"的店铺，分子分母同源 */
const collectedRoi = computed(() => {
  let gross = 0
  let spend = 0
  let covered = 0
  for (const item of collectedLatest.value) {
    const gmv = item.metric.grossSalesAmountMinor
    const adSpend = item.metric.adSpendMinor
    if (gmv == null || adSpend == null) continue
    gross += gmv
    spend += adSpend
    covered++
  }
  return { value: covered && spend > 0 ? gross / spend : null, covered, total: collectedRows.value.length }
})
const legacyRefundAmount = computed(() => metricAggregate('biz.refundAmount'))
const legacyRefundOrders = computed(() => metricAggregate('biz.refundOrders'))

const kpiRow = computed<KpiRowItem[]>(() => {
  const build = (
    key: string, label: string, tone: string,
    stat: { value: number | null; covered: number; total: number; partial: boolean },
    legacy: number | null, formatter: (value: number | null) => string,
    delta: number | null, hint: string, inverse = false
  ): KpiRowItem => {
    const fromCollected = stat.value !== null
    return {
      key, label, tone,
      value: formatter(fromCollected ? stat.value : legacy),
      delta: fromCollected ? delta : null,
      note: fromCollected ? collectedNote(stat) : (legacy !== null ? '任务快照' : '未采集'),
      hint: `${hint}｜${fromCollected ? `自动采集 ${stat.covered}/${stat.total} 家店铺有值` : '自动采集暂无数据'}`,
      inverse
    }
  }
  return [
    build('gmv', '销售金额', 'purple', collectedMoney.value, legacyGmv.value, formatMoneyCompact,
      collectedDelta(m => m.grossSalesAmountMinor, 0.01), `销售额（${PERIOD_CAPTION[period.value]}，成交金额）`),
    build('orders', '订单数', 'blue', collectedOrders.value, legacyOrders.value, formatNumber,
      collectedDelta(m => m.paidOrderCount), `成交订单数（${PERIOD_CAPTION[period.value]}）`),
    build('refundAmount', '退款金额', 'red', collectedRefundAmount.value, legacyRefundAmount.value, formatMoneyCompact,
      collectedDelta(m => m.refundAmountMinor, 0.01), '退款金额（退款日口径）', true),
    build('refundOrders', '退款订单', 'amber', collectedRefundOrders.value, legacyRefundOrders.value, formatNumber,
      collectedDelta(m => m.refundOrderCount), '成交退款订单数', true),
    // 投放花费与 ROI 都不做跨日涨跌配色：花费涨不等于好、跌也不等于坏，给数字配上红绿
    // 等于替用户下判断。这里只报数值与覆盖度。
    build('adSpend', '投放花费', 'yellow', collectedAdSpend.value, null, formatMoneyCompact,
      null, '投放花费（平台口径：抖店「投放消耗」、拼多多「推广花费」；快手/微信没有可读来源）'),
    buildRoi()
  ]
})
function buildRoi(): KpiRowItem {
  const roi = collectedRoi.value
  const value = roi.covered > 0 ? roi.value : null
  return {
    key: 'roi',
    label: '投产比 ROI',
    tone: 'green',
    value: value === null ? '—' : value.toFixed(2),
    delta: null,
    note: value === null
      ? (roi.total ? `${PERIOD_CAPTION[period.value]}缺投放花费` : '尚无采集计划')
      : `${roi.covered}/${roi.total} 家（有花费也有成交额）`,
    hint: '投产比 ROI = 成交金额 ÷ 投放花费，只用**同时**报了这两个字段的店铺计算（分子分母同源，不拿没有花费来源的店铺的成交额充分子）'
  }
}
function deltaClass(kpi: KpiRowItem): string {
  if (kpi.delta === null) return 'muted'
  const good = kpi.inverse ? kpi.delta < 0 : kpi.delta >= 0
  return good ? 'up' : 'down'
}

const trendWindowStart = computed(() => {
  const days = period.value === 'today' || period.value === 'yesterday' ? 1 : period.value === '30d' || period.value === 'custom' ? 30 : 7
  return Date.now() - days * 86400000
})
/**
 * 自动采集的按天曲线：每店每天取"当天最后一条"（采集是原地更新，一天一条，跨天才连成线）。
 * 只取选中口径的行——今日累计与近 7 天滚动不能画在同一根线上。
 */
const collectedTrendPoints = computed(() => {
  const groups = new Map<string, { key: string; timestamp: number; label: string; fullLabel: string; gmv: number | null; orders: number | null }>()
  const windowStart = trendWindowStart.value
  for (const row of collectedRows.value) {
    const lastOfDay = new Map<string, SalesMetrics>()
    for (const metric of row.series) {
      if (metric.collectedAt < windowStart) continue
      const when = new Date(metric.collectedAt)
      const dayKey = `${when.getFullYear()}-${when.getMonth() + 1}-${when.getDate()}`
      const kept = lastOfDay.get(dayKey)
      if (!kept || metric.collectedAt > kept.collectedAt) lastOfDay.set(dayKey, metric)
    }
    for (const metric of lastOfDay.values()) {
      const when = new Date(metric.collectedAt)
      const key = `${when.getFullYear()}-${when.getMonth() + 1}-${when.getDate()}`
      const item = groups.get(key) || { key, timestamp: new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime(), label: `${when.getMonth() + 1}/${when.getDate()}`, fullLabel: when.toLocaleDateString('zh-CN'), gmv: null, orders: null }
      if (metric.grossSalesAmountMinor !== null) item.gmv = (item.gmv || 0) + metric.grossSalesAmountMinor / 100
      if (metric.paidOrderCount !== null) item.orders = (item.orders || 0) + metric.paidOrderCount
      groups.set(key, item)
    }
  }
  return [...groups.values()].sort((a, b) => a.timestamp - b.timestamp)
})
const snapshotTrendPoints = computed(() => {
  const groups = new Map<string, { key: string; timestamp: number; label: string; fullLabel: string; gmv: number | null; orders: number | null }>()
  const relevant = snapshots.value.filter(row => row.capturedAt >= trendWindowStart.value && (selectedPlatform.value === 'all' || row.platform === selectedPlatform.value))
  for (const row of relevant) {
    if (row.metric !== 'biz.gmv' && row.metric !== 'biz.orders') continue
    const date = new Date(row.capturedAt)
    const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
    const item = groups.get(key) || { key, timestamp: new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(), label: `${date.getMonth() + 1}/${date.getDate()}`, fullLabel: date.toLocaleDateString('zh-CN'), gmv: null, orders: null }
    const value = numeric(row.value)
    if (value !== null) item[row.metric === 'biz.gmv' ? 'gmv' : 'orders'] = (item[row.metric === 'biz.gmv' ? 'gmv' : 'orders'] || 0) + value
    groups.set(key, item)
  }
  return [...groups.values()].sort((a, b) => a.timestamp - b.timestamp)
})
/** 采集数据优先；没有该口径的采集点时才回落到任务指标快照（并如实标注来源） */
const trendSource = computed<'collected' | 'snapshot' | 'none'>(() => collectedTrendPoints.value.length ? 'collected' : (snapshotTrendPoints.value.length ? 'snapshot' : 'none'))
const trendPoints = computed(() => trendSource.value === 'collected' ? collectedTrendPoints.value : snapshotTrendPoints.value)
const collectedUnverifiedPlatforms = computed(() => [...new Set(collectedRows.value
  // 从未采到过任何数据 + 最近一次明确报"来源未验证" → 才是真的未验证；
  // 采到过数据的平台不在这里出现（否则会拿历史状态盖住已经到手的数据）
  .filter(row => row.plan.lastSuccessAt == null
    && (row.plan.lastReasonCode === 'DATA_SOURCE_NOT_VERIFIED' || row.plan.lastStatus === 'DATA_SOURCE_NOT_VERIFIED'))
  .map(row => row.platform))])
const trendCaption = computed(() => {
  if (trendSource.value === 'collected') {
    const covered = collectedRows.value.filter(row => row.series.length).length
    const unverified = collectedUnverifiedPlatforms.value
    return `${PERIOD_CAPTION[period.value]} · 自动采集 ${covered}/${collectedRows.value.length} 家 · ${relativeTime(collectedFreshestAt.value)}${unverified.length ? ` · ${unverified.join('、')}数据源未验证` : ''}`
  }
  if (trendSource.value === 'snapshot') return `${snapshotPartial.value ? '部分店铺读取失败 · ' : ''}来自任务指标快照（自动采集在该口径下暂无数据）`
  return snapshotPartial.value ? '部分店铺读取失败，其余快照仍展示' : '仅展示已采集的经营快照'
})
const trendEmptyHint = computed(() => {
  const unverified = collectedUnverifiedPlatforms.value
  const base = `自动采集每 10 分钟一次，可在「数据分析」查看采集状态；当前口径（${PERIOD_CAPTION[period.value]}）还没有采到数据`
  return unverified.length ? `${base}。${unverified.join('、')}：数据源未验证` : base
})
// 图表几何：viewBox 900×260（左侧留 y 轴刻度，底部留日期标签）
const CHART = { left: 62, right: 874, top: 18, bottom: 216 }
/**
 * 以 0 为基线做纵向映射（0 → 画布底部，最大值 → 顶部）。
 *
 * 为什么不用 min-max 拉伸：只有两天数据时，min-max 会把「118.70 → 108.90」这种小幅回落
 * 拉成贯穿整个画布的断崖，看上去像数据崩了（实测踩过）。金额与件数都是非负量，从 0 起画
 * 既符合直觉（设计稿的 0/10万/20万… 也是从 0 起），也让差异如实呈现。
 */
const toY = (value: number | null, values: number[]) => {
  if (value === null || !values.length) return null
  const max = Math.max(...values, 0) || 1
  return CHART.bottom - (value / max) * (CHART.bottom - CHART.top)
}
const trendPlot = computed(() => {
  const points = trendPoints.value
  const gmvValues = points.map(point => point.gmv).filter((value): value is number => value !== null)
  const orderValues = points.map(point => point.orders).filter((value): value is number => value !== null)
  const span = CHART.right - CHART.left
  return points.map((point, index) => ({
    ...point,
    x: points.length <= 1 ? (CHART.left + CHART.right) / 2 : CHART.left + (index / (points.length - 1)) * span,
    gmvY: toY(point.gmv, gmvValues),
    ordersY: toY(point.orders, orderValues)
  }))
})
const pathFor = (key: 'gmvY' | 'ordersY') => trendPlot.value.filter(point => point[key] !== null).map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point[key]}`).join(' ')
const gmvPath = computed(() => pathFor('gmvY'))
const orderPath = computed(() => pathFor('ordersY'))
const areaFor = (path: string) => path ? `${path} L ${CHART.right} ${CHART.bottom} L ${CHART.left} ${CHART.bottom} Z` : ''
const gmvAreaPath = computed(() => areaFor(gmvPath.value))
const tooltipStyle = computed(() => hoveredPoint.value ? { left: `${Math.min(80, Math.max(8, (hoveredPoint.value.x / 900) * 100))}%` } : {})
/** Y 轴刻度按销售额取整成 4 档（1/2/2.5/5×10ⁿ），与设计稿的「0/10万/20万…」同一读法 */
function niceStep(raw: number): number {
  const base = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))))
  const n = Math.max(raw / base, 1)
  const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10
  return mult * base
}
function formatAxisMoney(value: number): string {
  if (!value) return '0'
  if (value >= 10000) return `${(value / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}万`
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}
const chartYAxis = computed(() => {
  const values = trendPlot.value.map(point => point.gmv).filter((value): value is number => value !== null)
  const step = niceStep((values.length ? Math.max(...values) : 1) / 4)
  return Array.from({ length: 5 }, (_, index) => ({
    value: step * index,
    // index 0 → 画布底部（值 0），index 4 → 顶部（值 4×step）：与 toY 的方向一致
    y: CHART.bottom - (index / 4) * (CHART.bottom - CHART.top),
    label: formatAxisMoney(step * index)
  }))
})

/** 平台在线汇总（设计稿右上角的「N / M 在线」胶囊） */
const platformOnlineSummary = computed(() => {
  const rows = platformSyncRows.value
  return `${rows.filter(row => row.state === 'online').length} / ${rows.length} 在线`
})
/**
 * 待办任务（设计稿右栏第三张卡）：只列**需要人管**的任务，标签用真实状态而不是编出来的时间。
 * 等待确认/执行失败 = 较紧急；进行中/已暂停 = 进行中。
 */
const pendingTasks = computed(() => ws.tasks
  .map((task: any) => {
    const run = task.latestRun
    const status = run?.id ? (ws.runLive[run.id]?.status || run.status) : run?.status
    return { id: task.id as string, name: String(task.name || '未命名任务'), status: String(status || '') }
  })
  .filter(item => ['waiting_confirmation', 'failed', 'running', 'queued', 'paused'].includes(item.status))
  .slice(0, 3)
  .map(item => ({
    id: item.id,
    name: item.name,
    badge: item.status === 'waiting_confirmation' ? '待确认' : item.status === 'failed' ? '较紧急' : item.status === 'paused' ? '已暂停' : '进行中',
    tone: ['waiting_confirmation', 'failed'].includes(item.status) ? 'urgent' : 'info'
  }))
)

const platformSyncRows = computed(() => {
  const names = [...new Set([...((window.shopilot.platforms || []).map(platform => platform.name)), ...ws.stores.map(store => store.platform)])]
  return names.map(name => {
    const stores = ws.stores.filter(store => store.platform === name)
    // "最近同步"优先取**自动采集**的时间：那才是这个平台真正的同步动作。
    // 用 plan.lastSuccessAt（最近一次成功采集，**不限口径**）—— 否则抖店只采"今日"、
    // 用户选了"近 7 天"时就查不到采集数据，界面会退回显示 9 月的旧任务快照，看起来像"没在同步"。
    const collectedTimes = collectedStores.value
      .filter(row => row.platform === name)
      .map(row => row.plan.lastSuccessAt ?? row.series[0]?.collectedAt ?? null)
      .filter((ts): ts is number => Number.isFinite(ts as number))
    const latestSnapshot = snapshots.value.filter(snapshot => snapshot.platform === name).sort((a, b) => b.capturedAt - a.capturedAt)[0]
    const hasLoginIssue = stores.some(store => store.status === 'needs_login')
    const hasOffline = stores.some(store => ['offline', 'proxy_error', 'incomplete'].includes(store.status))
    const state = hasLoginIssue ? 'login' : hasOffline ? 'offline' : stores.length ? 'online' : 'empty'
    // 来源未验证的平台：**只在这家平台一份数据都没有时**才这么说。
    // 一旦采到过（lastSuccessAt 有值），"最近同步"就该显示真实时间——不能拿一个历史状态
    // 盖住已经到手的数据（拼多多就是这么从"未验证"变成"有数据"的）。
    const unverified = !collectedTimes.length && collectedStores.value.some(row => row.platform === name
      && (row.plan.lastReasonCode === 'DATA_SOURCE_NOT_VERIFIED' || row.plan.lastStatus === 'DATA_SOURCE_NOT_VERIFIED'))
    const lastSync = unverified
      ? '数据源未验证'
      : (collectedTimes.length
        ? `自动采集 ${relativeTime(Math.max(...collectedTimes))}`
        : (latestSnapshot ? `任务快照 ${formatTime(latestSnapshot.capturedAt)}` : '尚未同步'))
    return { name, count: stores.length, state, stateLabel: state === 'login' ? '登录失效' : state === 'offline' ? '部分离线' : state === 'online' ? '正常运行' : '未连接', lastSync }
  }).filter(row => row.count > 0 || ws.stores.length === 0)
})

function statusClass(status: string) { return status === 'online' ? 'online' : ['needs_login', 'proxy_error'].includes(status) ? 'warning' : 'offline' }
function statusLabel(status: string) { return status === 'online' ? '在线' : status === 'needs_login' ? '登录失效' : status === 'launching' ? '启动中' : '离线' }
function isTaskActive(task: any) {
  const run = task.latestRun
  const liveStatus = run?.id ? ws.runLive[run.id]?.status : null
  return ['queued', 'running', 'waiting_confirmation', 'paused'].includes(liveStatus || run?.status)
}

async function waitForWorkspace() {
  if (ws.ready) return
  await new Promise<void>(resolve => {
    const stop = watch(() => ws.ready, ready => { if (ready) { stop(); resolve() } })
  })
}
async function loadDashboardData() {
  dataState.value = 'loading'; dataError.value = ''
  await loadTasks()
  try {
    await waitForWorkspace()
    await Promise.all([loadSnapshots(), loadCollectedMetrics()])
    dataState.value = ws.stores.length || snapshots.value.length || collectedStores.value.length ? 'ready' : 'empty'
  } catch (error: any) {
    dataState.value = 'error'; dataError.value = error?.message || '概览数据读取失败'
  }
}

/**
 * 「刷新数据」= **真的去采一轮**，不是重读本地库。
 *
 * 为什么必须去采：卡片上的数字来自每 10 分钟一次的自动采集，重读本地库只会把同一份旧数据
 * 再画一遍——用户按了按钮看到数字没变，会以为"采集坏了"。所以这里对**当前筛选范围内**的店铺
 * 逐个入队「立即采集」（走调度器：有运行记录、有并发上限、失败退避都在），等它们跑完再读库。
 *
 * 等待期间按钮显示进度（采集中 2/4），完成后弹一条汇总：成功的多少家、失败的分别是什么原因
 * （原因码直接来自运行记录，不编中文猜测）。
 */
const collectState = reactive({ running: false, done: 0, total: 0 })
const refreshLabel = computed(() => {
  if (collectState.running) return `采集中 ${collectState.done}/${collectState.total}`
  return dataState.value === 'loading' ? '读取中…' : '刷新数据'
})
const COLLECT_REASON_TEXT: Record<string, string> = {
  QUEUED: '已入队',
  ALREADY_RUNNING: '已在采集中',
  PLAN_NOT_FOUND: '没有采集计划',
  PLATFORM_PROFILE_NOT_MEASURED: '该平台未实测采集档案',
  STORE_NOT_FOUND: '店铺不存在',
  PAGE_NOT_READY: '店铺页面打不开',
  PAGE_NOT_RENDERED: '页面没渲染出来',
  PERIOD_NOT_APPLIED: '统计周期没切换成功',
  PERIOD_CONTROL_NOT_FOUND: '找不到周期控件',
  LOGIN_REQUIRED: '登录态已失效',
  NETWORK_ERROR: '网络/加载失败',
  SALES_METRICS_PARTIAL: '只采到部分指标',
  NO_METRICS_FOUND: '页面当前没有数值',
  COLLECTION_TIMEOUT: '超时',
  CIRCUIT_OPEN: '连续失败已停机'
}
async function refreshData() {
  if (collectState.running) return
  await waitForWorkspace()
  const targets = ws.stores.filter(store => selectedPlatform.value === 'all' || store.platform === selectedPlatform.value)
  if (!targets.length) { await loadDashboardData(); return }

  collectState.running = true
  collectState.total = targets.length
  collectState.done = 0
  const pending = new Map(targets.map(store => [store.id, store.name]))
  const failed: string[] = []
  const finished = (payload: any) => {
    const storeId = payload?.storeId
    if (!pending.has(storeId)) return
    pending.delete(storeId)
    collectState.done = collectState.total - pending.size
    if (payload.status !== 'SUCCEEDED' && payload.status !== 'PARTIAL') {
      failed.push(`${pending.get(storeId) || storeId}：${COLLECT_REASON_TEXT[payload.reasonCode] || payload.reasonCode || payload.status}`)
    }
  }
  window.shopilot.on(EVENT_CHANNELS.SALES_METRICS_RUN_FINISHED, finished)
  try {
    for (const store of targets) {
      const response = await window.shopilot.salesMetrics.planRunNow(store.id)
      if (!response.ok || !(response.data as any)?.accepted) {
        pending.delete(store.id)
        collectState.done = collectState.total - pending.size
        const reason = response.ok ? (response.data as any)?.reasonCode : response.error?.message
        failed.push(`${store.name}：${COLLECT_REASON_TEXT[String(reason)] || reason || '未能入队'}`)
      }
    }
    // 等入队的跑完：并发上限内四家店约一分钟；给 6 分钟上限以免页面卡住时按钮永远转圈。
    const deadline = Date.now() + 6 * 60 * 1000
    while (pending.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 700))
    if (pending.size) for (const name of pending.values()) failed.push(`${name}：等待超时`)
  } finally {
    window.shopilot.off(EVENT_CHANNELS.SALES_METRICS_RUN_FINISHED, finished)
    collectState.running = false
  }

  await loadDashboardData()
  const okCount = targets.length - failed.length
  showNotice(failed.length
    ? `已采集 ${okCount}/${targets.length} 家；${failed.join('；')}`
    : `已按当前口径采集 ${okCount} 家店铺的最新数据`)
}
async function loadTasks() {
  taskState.value = 'loading'
  try { await waitForWorkspace(); await ws.refreshTasks(); taskState.value = ws.tasks.length ? 'ready' : 'empty' } catch { taskState.value = 'error' }
}
async function loadSnapshots() {
  if (loadingSnapshots) return
  loadingSnapshots = true; snapshotState.value = 'loading'
  try {
    await waitForWorkspace()
    const settled = await Promise.allSettled(ws.stores.map(async store => {
      const response = await window.shopilot.snapshot.list(store.id, 60)
      if (!response.ok) throw new Error(response.error.message)
      return (response.data || []).map((item: any) => ({ ...item, storeId: store.id, storeName: store.name, platform: store.platform })) as SnapshotRow[]
    }))
    const succeeded = settled.filter((item): item is PromiseFulfilledResult<SnapshotRow[]> => item.status === 'fulfilled')
    const failed = settled.filter(item => item.status === 'rejected')
    snapshots.value = succeeded.flatMap(item => item.value)
    snapshotPartial.value = succeeded.length > 0 && failed.length > 0
    snapshotState.value = failed.length === settled.length && settled.length > 0 ? 'error' : snapshots.value.length ? 'ready' : 'empty'
  } catch { snapshotState.value = 'error' } finally { loadingSnapshots = false }
}
function showNotice(message: string) { notice.value = message; if (noticeTimer) window.clearTimeout(noticeTimer); noticeTimer = window.setTimeout(() => { notice.value = '' }, 3600) }
function handleQuickAction(action: any) {
  if (action.key === 'image') { navigateTo('image-studio'); return }
  if (!action.available) showNotice(`${action.label}：${action.description}`)
}
function handleNav(item: { label: string }) {
  activeNav.value = item.label
  const pageByLabel: Record<string, DashboardPage> = {
    '经营总览': 'overview', '商品管理': 'products', '订单管理': 'orders', '店铺管理': 'stores',
    'AI 创作': 'ai', '数据分析': 'analytics', '应用中心': 'apps', '设置中心': 'settings'
  }
  navigateTo(pageByLabel[item.label] || 'overview')
}
function navigateTo(page: DashboardPage) {
  if (page === 'settings' && activePage.value !== 'settings') {
    settingsReturnPage.value = activePage.value
    settingsReturnStoreId.value = ws.displayedStoreId
  }
  if (page !== 'tasks') taskAutoCreate.value = false
  taskOverlay.value = false
  taskPicking.value = false
  if (page === 'settings') {
    activePage.value = page
    activeNav.value = '设置中心'
    // 进设置**摘除视图**（display(null)）而不是只置遮挡标志 `setViewsObscured(true)`：
    // 标志是粘性的——只要有一条回到浏览器页的路径忘了复位（实测左栏店铺卡片那条就忘了），
    // 就变成"地址栏与标签都在、中栏全白"，用户只能靠碰运气打开某个弹层或重启恢复
    // （2026-09-28 审查确认）。摘除是自解释的：视图不在就没有遮挡；
    // 返回时 closeSettings 会重新 openStore 把它挂回来（settingsReturnStoreId 已记住）。
    if (ws.displayedStoreId) {
      ws.displayedStoreId = null
      void window.shopilot.browser.display(null)
    }
    return
  }
  if (ws.displayedStoreId && page !== 'browser') {
    ws.displayedStoreId = null
    void window.shopilot.browser.display(null)
  }
  activePage.value = page
  if (page === 'overview') activeNav.value = '经营总览'
  else if (page === 'products') activeNav.value = '商品管理'
  else if (page === 'orders') activeNav.value = '订单管理'
  else if (page === 'stores') activeNav.value = '店铺管理'
  else if (page === 'ai') activeNav.value = 'AI 创作'
  else if (page === 'analytics' || page === 'invoices') activeNav.value = '数据分析'
  else if (page === 'apps') activeNav.value = '应用中心'
  else if (page === 'image-studio') activeNav.value = 'AI 创作'
  else if (page === 'settings') activeNav.value = '设置中心'
}
function openTasks(create = false) {
  if (create && activePage.value === 'browser' && ws.displayedStoreId) {
    taskAutoCreate.value = true
    taskOverlay.value = true
    return
  }
  taskOverlay.value = false
  taskPicking.value = false
  taskAutoCreate.value = create
  navigateTo('tasks')
}
function closeTaskOverlay() {
  taskOverlay.value = false
  taskPicking.value = false
  taskAutoCreate.value = false
  void window.shopilot.browser.setViewsObscured(false)
}
async function closeSettings() {
  const returnPage = settingsReturnPage.value
  const storeId = settingsReturnStoreId.value
  settingsReturnPage.value = 'overview'
  settingsReturnStoreId.value = null
  if (returnPage === 'browser' && storeId) {
    activePage.value = 'browser'
    activeNav.value = '经营总览'
    await nextTick()
    await window.shopilot.browser.setViewsObscured(false)
    await ws.openStore(storeId)
    emit('open-store', storeId)
    return
  }
  navigateTo('overview')
}
function setTaskPicking(value: boolean) { taskPicking.value = value }
function changeDataPage(page: 'analytics' | 'orders' | 'invoices') { navigateTo(page) }
async function openStoreFromPage(storeId: string) {
  taskOverlay.value = false
  taskPicking.value = false
  // 从"设置页进入的店铺"不算设置页业务：把返回目标清掉，否则之后点关闭设置会把用户拽回旧状态
  settingsReturnPage.value = 'overview'
  settingsReturnStoreId.value = null
  activePage.value = 'browser'
  activeNav.value = '经营总览'
  // 保险：清掉可能残留的弹层遮挡标志。它一旦为真，mountTab 会被 viewsHiddenForOverlay 拦住，
  // 页面表现就是"标签栏在、中栏全白"（这条路径正是 2026-09-28 审查实测到的复现步骤）。
  void window.shopilot.browser.setViewsObscured(false)
  if (ws.displayedStoreId !== storeId || !ws.openStoreIds.includes(storeId)) await ws.openStore(storeId)
  emit('open-store', storeId)
}
function setLeftSidebarOpen(open: boolean) {
  leftSidebarCollapsed.value = !open
  void window.shopilot.settings.set('ui.leftSidebarCollapsed', !open)
}
function openStoreCreate() {
  createStoreError.value = ''
  createStoreDialog.name = ''
  createStoreDialog.platform = availablePlatforms[0]?.name || '拼多多'
  createStoreDialog.adminUrl = availablePlatforms[0]?.adminUrl || ''
  createStoreDialog.open = true
}
function onCreatePlatformChange() {
  const platform = availablePlatforms.find(item => item.name === createStoreDialog.platform)
  if (platform) createStoreDialog.adminUrl = platform.adminUrl
}
async function submitStoreCreate() {
  if (!createStoreDialog.name.trim() || !createStoreDialog.adminUrl.trim()) return
  createStoreBusy.value = true
  createStoreError.value = ''
  const result = await ws.createStore({ name: createStoreDialog.name.trim(), platform: createStoreDialog.platform, adminUrl: createStoreDialog.adminUrl.trim() })
  createStoreBusy.value = false
  if (!result.ok) { createStoreError.value = result.error?.message || '创建失败'; return }
  createStoreDialog.open = false
}
async function openTrash() {
  await ws.refreshTrash()
  ws.trashOpen = true
}
function closeTrash() { ws.trashOpen = false }
async function confirmPurge(store: StoreRow) {
  if (window.confirm(`彻底删除「${store.name}」？此操作不可撤销，将清除其环境、下载记录与缓存。`)) await ws.purgeStore(store.id)
}
function openStoreContext(store: StoreRow, event: MouseEvent) {
  storeContext.store = store
  const width = 252; const height = 306
  storeContext.x = Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))
  storeContext.y = Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))
  storeContext.open = true
}
function closeStoreContext() { storeContext.open = false }
async function storeContextAction(kind: 'toggle' | 'standalone' | 'rename' | 'copycfg' | 'copyid' | 'trash') {
  const store = storeContext.store
  closeStoreContext()
  if (!store) return
  if (kind === 'toggle') {
    if (ws.openStoreIds.includes(store.id)) await ws.closeStore(store.id)
    else openStoreFromPage(store.id)
    return
  }
  if (kind === 'standalone') {
    if (!ws.activeTab || ws.displayedStoreId !== store.id) { showNotice('请先打开该店铺并选中标签页'); return }
    const result = await window.shopilot.browser.openWindow(store.id, ws.activeTab.id)
    showNotice(result.ok ? '已在独立窗口打开当前标签页' : `打开失败：${result.error.message}`)
    return
  }
  if (kind === 'rename') { renameDialog.value = store.name; renameDialog.open = true; return }
  if (kind === 'copycfg') { copyConfigDialog.sourceId = store.id; copyConfigDialog.sourceName = store.name; copyConfigDialog.targets = []; copyConfigDialog.open = true; return }
  if (kind === 'copyid') {
    try { await navigator.clipboard.writeText(store.id); showNotice('已复制店铺 ID') } catch { showNotice(`复制失败：${store.id}`) }
    return
  }
  confirmDialog.title = '移入回收站'
  confirmDialog.message = `「${store.name}」将移入回收站，会话与环境配置保留，可在店铺管理中恢复。`
  confirmDialog.action = async () => { await ws.moveToTrash(store.id) }
  confirmDialog.open = true
}
async function saveStoreRename() {
  const store = storeContext.store
  const name = renameDialog.value.trim()
  if (!store || !name) return
  const result = await window.shopilot.store.update({ storeId: store.id, patch: { name } })
  if (!result.ok) { showNotice(`重命名失败：${result.error.message}`); return }
  renameDialog.open = false
  await ws.refreshStores()
  showNotice('已重命名')
}
async function applyStoreConfigCopy() {
  if (!copyConfigDialog.sourceId || !copyConfigDialog.targets.length) return
  const result = await window.shopilot.profile.copyConfig(copyConfigDialog.sourceId, [...copyConfigDialog.targets])
  if (!result.ok) { showNotice(`复制环境配置失败：${result.error.message}`); return }
  copyConfigDialog.open = false
  await ws.refreshStores()
  const skipped = result.data?.skipped || []
  showNotice(skipped.length ? `已复制 ${result.data?.copied || 0} 个，跳过 ${skipped.length} 个` : `已复制环境配置到 ${result.data?.copied || 0} 个店铺`)
}
async function runConfirmDialog() {
  const action = confirmDialog.action
  confirmDialog.open = false
  confirmDialog.action = null
  if (action) await action()
}
async function syncStoreContextOcclusion() {
  await nextTick()
  const menu = document.querySelector('[data-test="store-ctx"]') as HTMLElement | null
  const viewport = document.querySelector('[data-test="dashboard-browser-viewport"]') as HTMLElement | null
  if (!menu || !viewport) { await window.shopilot.browser.setViewsObscured(false); return }
  const m = menu.getBoundingClientRect(); const v = viewport.getBoundingClientRect()
  const sidebar = document.querySelector('.dashboard-sidebar')?.getBoundingClientRect()
  // 店铺列表位于固定左栏；右键点在左栏时菜单不会盖住原生店铺视图，即使浏览器布局尚未完成一次测量也不能误隐藏。
  if (storeContext.x < (sidebar?.right || 268)) { await window.shopilot.browser.setViewsObscured(false); return }
  const overlap = !(m.right <= v.left || m.left >= v.right || m.bottom <= v.top || m.top >= v.bottom)
  await window.shopilot.browser.setViewsObscured(overlap)
}
function goOverview() { navigateTo('overview') }
function openAgentSettings() { settingsTab.value = 'agents'; navigateTo('settings') }
function openImageSettings() { settingsTab.value = 'ai'; navigateTo('settings') }
/**
 * Agent 的软件级 openPanel 动作走 Main 事件；统一 Dashboard 也必须接住，
 * 否则旧工作台的事件监听会把导航写进隐藏的旧设置弹窗，用户看不到结果。
 */
function handleAgentPanelOpen(payload: any) {
  const panel = String(payload?.panel || '')
  if (panel === 'settings') { settingsTab.value = 'config'; navigateTo('settings') }
  else if (panel === 'agentTeam') { settingsTab.value = 'agents'; navigateTo('settings') }
  else if (panel === 'aiConfig') { settingsTab.value = 'ai'; navigateTo('settings') }
  else if (panel === 'tasks') navigateTo('tasks')
  else if (panel === 'invoiceCenter') navigateTo('invoices')
  else if (panel === 'dataCenter') navigateTo('analytics')
  if (panel) agent.setDrawerOpen(false)
}
async function openAssistant() {
  try { await agent.initialize(); await agent.refreshSoftwareContext(); agent.setDrawerOpen(true) } catch { showNotice('AI 助手暂时不可用，请检查模型配置') }
}
function openCommandPalette() { commandOpen.value = true; nextTick(() => commandInput.value?.focus()) }
const commandResults = computed(() => {
  const query = globalQuery.value.trim().toLowerCase()
  const results = [
    { key: 'home', icon: '⌂', label: '经营总览', description: '回到经营总览', action: () => navigateTo('overview') },
    { key: 'orders', icon: '▤', label: '最近订单', description: '打开订单管理页面', action: () => navigateTo('orders') },
    { key: 'trend', icon: '◫', label: '销售趋势', description: '打开数据分析页面', action: () => navigateTo('analytics') },
    { key: 'tasks', icon: '◎', label: 'AI 任务中心', description: '查看真实任务运行状态', action: () => navigateTo('tasks') },
    { key: 'settings', icon: '⚙', label: '设置中心', description: '打开统一设置页面', action: () => navigateTo('settings') },
    ...ws.stores.map(store => ({ key: `store-${store.id}`, icon: '▣', label: store.name, description: `${store.platform} · 打开店铺浏览器`, action: () => openStoreFromPage(store.id) }))
  ]
  return query ? results.filter(item => `${item.label} ${item.description}`.toLowerCase().includes(query)).slice(0, 8) : results.slice(0, 6)
})
function runCommand(result: any) { commandOpen.value = false; result.action() }
function onKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommandPalette() }
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'e') { event.preventDefault(); setLeftSidebarOpen(leftSidebarCollapsed.value); return }
  if (event.key === 'Escape') {
    if (confirmDialog.open) { confirmDialog.open = false; event.preventDefault() }
    else if (renameDialog.open) { renameDialog.open = false; event.preventDefault() }
    else if (copyConfigDialog.open) { copyConfigDialog.open = false; event.preventDefault() }
    else if (storeContext.open) { closeStoreContext(); event.preventDefault() }
    else if (agent.ui.drawerOpen) { agent.setDrawerOpen(false); event.preventDefault() }
    commandOpen.value = false
  }
}
function onDocumentMouseDown(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (storeContext.open && !target?.closest('[data-test="store-ctx"]')) closeStoreContext()
}
watch(() => [storeContext.open, storeContext.x, storeContext.y], () => { void syncStoreContextOcclusion() })
watch(() => ws.trashOpen, open => { void window.shopilot.browser.setViewsObscured(!!open) })
// 口径（今日/近 7 天/近 30 天）与平台筛选变了就重新取采集数据：
// 不同口径的采集行不能混用（近 7 天滚动值当日增量相加会虚高），必须回主进程重查。
watch([period, selectedPlatform], () => { if (isOnOverview.value) void loadCollectedMetrics() })
// 采集每 10 分钟一轮：停在总览页时定时刷新一次，用户不用手动点"刷新数据"
let collectedTimer: number | undefined
function scheduleCollectedRefresh() {
  if (collectedTimer) window.clearInterval(collectedTimer)
  collectedTimer = window.setInterval(() => { if (isOnOverview.value && !document.hidden) void loadCollectedMetrics() }, 5 * 60 * 1000)
}
/**
 * 采集完成事件 → 立刻刷新总览。
 * 光靠定时器会滞后（采集 20:19 完成、界面可能 20:24 才更新），而这正是"数据没更新到软件"的观感来源。
 */
function onCollectedRunFinished() {
  if (isOnOverview.value) void loadCollectedMetrics()
}
// 主进程**单方面**显示店铺时（Agent 动作 / 开店后自动显示 → BROWSER_DISPLAY_CHANGED，
// workspace 已更新 displayedStoreId 与 displaySource）才把页面切过去：不切的话原生店铺视图
// 会盖住当前页（数据分析/设置…），而用户没有任何界面入口能纠正。
// 渲染层自己请求的显示（displaySource==='renderer'）不跟随——它本来就在正确的页上，
// 跟随会打断它自己的导航时序（实测会让"点店铺卡片进入"这类流程落空）。
watch([() => ws.displayedStoreId, () => ws.displaySource], ([storeId, source]) => {
  if (storeId && source === 'main' && activePage.value !== 'browser') {
    activePage.value = 'browser'
    activeNav.value = '经营总览'
    taskOverlay.value = false
    taskPicking.value = false
  }
})

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  document.addEventListener('mousedown', onDocumentMouseDown)
  window.shopilot.on(EVENT_CHANNELS.AGENT_PANEL_OPEN, handleAgentPanelOpen)
  window.shopilot.on(EVENT_CHANNELS.SALES_METRICS_RUN_FINISHED, onCollectedRunFinished)
  tickClock()
  clockTimer = window.setInterval(tickClock, 1000)
  // DashboardView 现在是应用的真实入口，必须自行完成工作区初始化，不能依赖旧 WorkbenchView 的生命周期。
  await ws.init()
  await waitForWorkspace()
  const savedSidebar = await window.shopilot.settings.get('ui.leftSidebarCollapsed')
  if (savedSidebar.ok && savedSidebar.data?.value === true) leftSidebarCollapsed.value = true
  if (ws.displayedStoreId) { activePage.value = 'browser'; activeNav.value = '经营总览' }
  await loadDashboardData()
  scheduleCollectedRefresh()
  stopStoreWatch = watch(() => ws.stores.map(store => `${store.id}:${store.status}`).join('|'), () => { void loadSnapshots(); void loadCollectedMetrics() })
})
onBeforeUnmount(() => { window.removeEventListener('keydown', onKeydown); document.removeEventListener('mousedown', onDocumentMouseDown); window.shopilot.off(EVENT_CHANNELS.AGENT_PANEL_OPEN, handleAgentPanelOpen); window.shopilot.off(EVENT_CHANNELS.SALES_METRICS_RUN_FINISHED, onCollectedRunFinished); stopStoreWatch?.(); if (noticeTimer) window.clearTimeout(noticeTimer); if (collectedTimer) window.clearInterval(collectedTimer); if (clockTimer) window.clearInterval(clockTimer); void window.shopilot.browser.setViewsObscured(false) })
</script>

<style scoped>
/* ============================================================================
   统一工作台 · 浅色主题（2026-09-28 按设计稿重制）
   设计令牌（--dash-*）在这一层定义：页面/卡片/描边/文字 + 品牌紫与语义色。
   子页面（店铺工作台、数据中心、设置…）沿用同一套令牌，改一处全站一致。
   ========================================================================== */
.dashboard-shell {
  --dash-bg: #f5f7fb;
  --dash-bg-soft: #ffffff;
  --dash-card: #ffffff;
  --dash-card-hover: #f7f9fd;
  --dash-border: #e9edf5;
  --dash-border-strong: #dbe2ee;
  --dash-text: #0f1729;
  --dash-text-soft: #4a5568;
  --dash-text-muted: #98a2b3;
  --dash-purple: #7c5cff;
  --dash-blue: #2e90fa;
  --dash-cyan: #06aed4;
  --dash-green: #12b76a;
  --dash-orange: #f79009;
  --dash-red: #f04438;
  --dash-shadow: 0 1px 2px rgba(16, 24, 40, .04), 0 10px 28px rgba(16, 24, 40, .06);
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: var(--dash-text);
  background: var(--dash-bg);
  font-size: 13px;
}
.dashboard-shell.welcome { align-items: stretch; justify-content: flex-start; -webkit-app-region: no-drag; }
.dashboard-shell button, .dashboard-shell input, .dashboard-shell select { font: inherit; }
/* 兜底文字色用 :where() 压低优先级：否则会把各按钮自己声明的颜色盖掉
   （例如 AI 卡的白底紫字按钮会变成白底白字，实测踩过） */
.dashboard-shell :where(button) { color: var(--dash-text-soft); }
.dashboard-shell h1, .dashboard-shell h2, .dashboard-shell h3 { font-weight: 700; letter-spacing: -.01em; }

/* ---------------- 左侧栏（设计稿是**深色**侧栏 + 浅色内容区） ---------------- */
.dashboard-sidebar {
  --side-bg: #0b1120;
  --side-surface: rgba(255, 255, 255, .05);
  --side-surface-hover: rgba(255, 255, 255, .09);
  --side-border: rgba(255, 255, 255, .07);
  --side-text: #e8edf7;
  --side-text-soft: #b6c0d4;
  --side-text-muted: #7c8aa3;
  width: 248px; min-width: 248px; display: flex; flex-direction: column;
  border-right: 1px solid var(--side-border); background: var(--side-bg); color: var(--side-text-soft);
  transition: width .18s ease, min-width .18s ease;
}
.dashboard-shell.picker-mode .dashboard-sidebar { width: 0; min-width: 0; overflow: hidden; border-right: 0; }
.dashboard-sidebar.collapsed { width: 60px; min-width: 60px; }
.sidebar-collapse { margin-left: auto; width: 24px; height: 24px; flex: 0 0 auto; border: 0; border-radius: 6px; background: transparent; color: var(--side-text-muted); cursor: pointer; font-size: 15px; line-height: 1; }
.sidebar-collapse:hover, .sidebar-collapse:focus-visible { background: var(--side-surface); color: #fff; outline: none; }
.sidebar-rail { display: flex; height: 100%; flex-direction: column; align-items: center; gap: 6px; padding: 14px 0 12px; -webkit-app-region: drag; }
.sidebar-rail .rail-btn { position: relative; display: inline-flex; width: 34px; height: 34px; align-items: center; justify-content: center; border: 0; border-radius: 9px; background: transparent; color: var(--side-text-soft); cursor: pointer; font-size: 16px; -webkit-app-region: no-drag; }
.sidebar-rail .rail-btn:hover, .sidebar-rail .rail-btn:focus-visible { background: var(--side-surface); color: #fff; outline: none; }
.sidebar-rail .rail-btn:first-child { margin-bottom: 4px; font-size: 19px; }
.rail-badge { position: absolute; top: 5px; right: 4px; width: 7px; height: 7px; border: 1px solid var(--side-bg); border-radius: 50%; background: #fb5470; }
.dashboard-brand { height: 74px; display: flex; align-items: center; gap: 11px; padding: 16px 16px 10px; }
.dashboard-brand-mark {
  display: flex; width: 40px; height: 40px; align-items: center; justify-content: center; flex: 0 0 40px;
  border-radius: 12px; background: var(--brand-gradient); box-shadow: 0 8px 18px rgba(124, 92, 255, .42);
  color: #fff; font-size: 19px; font-weight: 800;
}
.dashboard-brand-mark svg { width: 22px; height: 22px; }
.dashboard-brand-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.dashboard-brand-copy strong { color: #fff; font-size: 16px; letter-spacing: -.02em; }
.dashboard-brand-copy span { color: var(--side-text-muted); font-size: 10.5px; white-space: nowrap; }
.dashboard-nav { display: flex; flex-direction: column; gap: 2px; padding: 6px 12px 10px; }
.nav-group-title { padding: 12px 10px 6px; color: var(--side-text-muted); font-size: 10.5px; font-weight: 600; letter-spacing: .08em; }
.dashboard-nav-item {
  position: relative; display: flex; width: 100%; align-items: center; gap: 11px; height: 42px; padding: 0 12px;
  border: 0; border-radius: 11px; background: transparent; color: var(--side-text-soft); text-align: left; cursor: pointer;
  font-size: 13px; transition: background .16s, color .16s, box-shadow .16s;
}
.dashboard-nav-item:hover, .dashboard-nav-item:focus-visible { background: var(--side-surface); color: #fff; outline: none; }
.dashboard-nav-item.active { background: var(--brand-gradient); color: #fff; box-shadow: 0 10px 22px rgba(124, 92, 255, .38); }
.nav-glyph { width: 20px; flex: 0 0 20px; color: currentColor; font-size: 16px; line-height: 1; text-align: center; opacity: .95; }
.nav-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dashboard-store-area { min-height: 0; flex: 1; display: flex; flex-direction: column; border-top: 1px solid var(--side-border); margin-top: 4px; padding: 12px 12px 0; }
.store-area-title { display: flex; align-items: center; gap: 7px; padding: 2px 4px 10px; color: #cfd7e6; font-size: 12px; font-weight: 600; }
.store-count { display: inline-flex; min-width: 18px; height: 18px; align-items: center; justify-content: center; padding: 0 5px; border-radius: 6px; background: var(--side-surface); color: var(--side-text-soft); font-size: 10.5px; font-weight: 600; }
.add-store-button { margin-left: auto; width: 24px; height: 24px; flex: 0 0 auto; border: 0; border-radius: 7px; background: rgba(124, 92, 255, .22); color: #c3b2ff; font-size: 16px; line-height: 1; cursor: pointer; }
.add-store-button:hover, .add-store-button:focus-visible { background: rgba(124, 92, 255, .34); color: #fff; outline: none; }
.store-area-body { min-height: 0; flex: 1; display: flex; flex-direction: column; }
.sidebar-state { display: flex; flex-direction: column; align-items: center; gap: 7px; padding: 22px 8px; color: var(--side-text-muted); font-size: 11.5px; text-align: center; }
.inline-link { border: 0; background: transparent; color: #b9a6ff; cursor: pointer; font-size: 11.5px; }
.inline-link:hover { text-decoration: underline; }
.store-groups { min-height: 0; overflow-y: auto; padding: 0 0 10px; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, .16) transparent; }
.dashboard-store-row {
  display: flex; width: 100%; align-items: center; gap: 9px; height: 44px; padding: 0 8px;
  border: 0; border-radius: 11px; background: transparent; color: var(--side-text-soft); text-align: left; cursor: pointer;
}
.dashboard-store-row:hover, .dashboard-store-row:focus-visible { background: var(--side-surface); outline: none; }
.dashboard-store-row.displayed { background: rgba(124, 92, 255, .18); color: #fff; }
.dashboard-store-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--side-text); }
.store-online-label { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; color: #38d39f; font-size: 11px; }
.store-status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--side-text-muted); }
.store-status-dot.online { background: #38d39f; box-shadow: 0 0 0 3px rgba(56, 211, 159, .18); }
.store-status-dot.warning { background: #f5b457; }
.store-status-dot.offline { background: #ff7d8a; }
.store-online-label:has(.store-status-dot.warning) { color: #f5b457; }
.store-online-label:has(.store-status-dot.offline) { color: #ff7d8a; }
.store-action { display: inline-flex; width: 22px; height: 22px; align-items: center; justify-content: center; flex: 0 0 auto; border-radius: 6px; color: var(--side-text-muted); font-size: 9px; opacity: 0; transition: opacity .15s, background .15s, color .15s; }
.dashboard-store-row:hover .store-action, .dashboard-store-row:focus-within .store-action { opacity: 1; }
.store-action:hover, .store-action:focus-visible { background: rgba(124, 92, 255, .3); color: #fff; outline: none; }
.dashboard-sidebar-footer { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 14px; border-top: 1px solid var(--side-border); }
.pro-card { display: flex; width: 100%; align-items: center; gap: 9px; padding: 10px 11px; border: 0; border-radius: 12px; background: var(--side-surface); cursor: pointer; text-align: left; }
.pro-card:hover, .pro-card:focus-visible { background: var(--side-surface-hover); outline: none; }
.pro-avatar { display: inline-flex; width: 30px; height: 30px; flex: 0 0 30px; align-items: center; justify-content: center; border-radius: 50%; background: var(--brand-gradient); color: #fff; font-size: 10px; font-weight: 800; }
.pro-copy { display: flex; min-width: 0; flex: 1; align-items: center; gap: 6px; }
.pro-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #fff; font-size: 12.5px; }
.pro-badge { padding: 2px 6px; border-radius: 6px; background: #f5c451; color: #3a2c0c; font-size: 10px; font-weight: 600; }
.pro-arrow { color: var(--side-text-muted); font-size: 16px; }
.foot-btn { display: flex; width: 100%; align-items: center; gap: 8px; height: 34px; padding: 0 10px; border: 0; border-radius: 9px; background: transparent; color: var(--side-text-soft); cursor: pointer; font-size: 12.5px; text-align: left; }
.foot-btn:hover, .foot-btn:focus-visible { background: var(--side-surface); color: #fff; outline: none; }
.foot-btn.foot-settings.active { background: rgba(124, 92, 255, .24); color: #cbbcff; }
.foot-btn .badge { min-width: 16px; margin-left: auto; padding: 1px 6px; border-radius: 10px; background: rgba(240, 68, 56, .24); color: #ffb4ae; text-align: center; font-size: 10px; }
.foot-row { display: flex; align-items: center; gap: 6px; }
.foot-row .foot-settings { flex: 1; min-width: 0; }
.foot-icon { position: relative; width: 36px; flex: 0 0 36px; justify-content: center; padding: 0; font-size: 13px; }
.foot-icon .badge { position: absolute; top: 3px; right: 1px; min-width: 14px; margin: 0; padding: 0 4px; font-size: 9.5px; }
.storage-status.connected { color: #38d39f; }

/* ---------------- 主区域 + 顶栏 ---------------- */
.dashboard-main { position: relative; min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; overflow: hidden; background: var(--dash-bg); }
.dashboard-browser-host { min-width: 0; min-height: 0; flex: 1 1 auto; display: flex; }
/* 非当前页：脱离布局流并隐藏视觉/命中，但保留真实尺寸 —— guest 自认可见才会继续渲染，
   渲染层重进浏览器页时也就不需要重建页面（重建 = 丢状态 + 重新登录流程）。 */
.dashboard-browser-host:not(.active) { position: absolute; inset: 0; z-index: 0; opacity: 0; pointer-events: none; }
.dashboard-browser-host > :deep(.dashboard-browser-surface) { min-width: 0; min-height: 0; flex: 1 1 auto; }
/* 顶部栏与右上角原生窗口按钮（WCO，高 38px）共存：
   · 右侧留出 148px：原生按钮是画在页面之上的覆盖层，不留白就会压住头像；
   · 底色固定为 #ffffff，且与 App.vue 的 TOOLBAR_BG 保持同一色值（overlay 是不透明覆盖层）。 */
.dashboard-toolbar {
  display: flex; align-items: center; gap: 16px; height: 64px; flex: 0 0 64px;
  padding: 0 148px 0 22px; border-bottom: 1px solid var(--dash-border); background: #ffffff;
  -webkit-app-region: drag;
}
.toolbar-crumb { display: flex; align-items: center; gap: 8px; color: var(--dash-text-muted); font-size: 13px; }
.crumb-current { color: var(--dash-text); font-weight: 600; }
.crumb-sep { color: #cbd5e1; }
.toolbar-actions { display: flex; min-width: 0; align-items: center; gap: 10px; margin-left: auto; -webkit-app-region: no-drag; }
.toolbar-datetime { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border: 1px solid var(--dash-border); border-radius: 11px; background: #fff; color: var(--dash-text-soft); font-size: 12.5px; }
.dt-icon { color: var(--dash-text-muted); font-size: 13px; }
.dt-caret { margin-left: 1px; color: var(--dash-text-muted); font-size: 12px; }
.toolbar-icon-button { position: relative; width: 34px; height: 34px; border: 0; border-radius: 10px; background: transparent; color: var(--dash-text-soft); font-size: 16px; cursor: pointer; }
.toolbar-icon-button:hover, .toolbar-icon-button:focus-visible { background: #f2f4f8; color: var(--dash-text); outline: none; }
.notification-dot { position: absolute; top: 5px; right: 5px; width: 7px; height: 7px; border: 1.5px solid #fff; border-radius: 50%; background: #fb5470; }
.toolbar-avatar { display: inline-flex; width: 34px; height: 34px; align-items: center; justify-content: center; border-radius: 50%; background: var(--brand-gradient); color: #fff; font-size: 11px; font-weight: 800; }

/* ---------------- 经营总览 ---------------- */
.overview-page { min-height: 0; flex: 1 1 auto; overflow-y: auto; padding: 20px 22px 26px; scrollbar-width: thin; scrollbar-color: #d8dfea transparent; }
.dashboard-eyebrow { color: var(--dash-text-muted); font-size: 10.5px; font-weight: 600; letter-spacing: .16em; }
.ov-title-row { display: flex; align-items: center; gap: 12px; }
/* 刷新按钮挂在「销售概览」标题后面，直接挨着它要刷新的那张卡，不再占页面头部一行。 */
.ov-refresh { display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 14px; border: 0; border-radius: 10px; background: var(--brand-gradient); color: #fff; cursor: pointer; font-size: 12px; font-weight: 600; box-shadow: 0 8px 18px rgba(124, 92, 255, .34); }
.ov-refresh:hover:not(:disabled), .ov-refresh:focus-visible { filter: brightness(1.05); outline: none; }
.ov-refresh:disabled { cursor: wait; opacity: .72; }
.dashboard-error { display: flex; align-items: center; gap: 9px; margin-bottom: 14px; padding: 10px 13px; border: 1px solid rgba(240, 68, 56, .28); border-radius: 12px; background: #fef3f2; color: #b42318; font-size: 12px; }
.dashboard-error .state-icon { display: inline-flex; width: 18px; height: 18px; align-items: center; justify-content: center; border-radius: 50%; background: var(--dash-red); color: #fff; font-weight: 700; }
.dashboard-error button, .error-state button { margin-left: auto; border: 0; background: transparent; color: #b42318; text-decoration: underline; cursor: pointer; }

.ov-grid { display: grid; grid-template-columns: minmax(0, 1fr) 336px; gap: 16px; align-items: start; }
.ov-col-main, .ov-col-rail { display: flex; min-width: 0; flex-direction: column; gap: 16px; }
.ov-card { position: relative; padding: 18px; border: 1px solid var(--dash-border); border-radius: 18px; background: var(--dash-card); box-shadow: var(--dash-shadow); }
.ov-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.ov-card-title { display: flex; flex-direction: column; gap: 3px; }
.ov-card-title h2 { font-size: 15.5px; }
.ov-card-title span { color: var(--dash-text-muted); font-size: 11.5px; }
.ov-card-tools { display: flex; align-items: center; gap: 10px; }
.ov-card-caption { margin: 12px 0 0; color: var(--dash-text-muted); font-size: 11.5px; line-height: 1.5; }
.period-tabs { display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 11px; background: #f2f4f8; }
.period-tabs button { height: 30px; padding: 0 13px; border: 0; border-radius: 9px; background: transparent; color: var(--dash-text-soft); cursor: pointer; font-size: 12px; }
.period-tabs button:hover, .period-tabs button:focus-visible { color: var(--dash-text); outline: none; }
.period-tabs button.active { background: var(--brand-gradient); color: #fff; box-shadow: 0 6px 14px rgba(124, 92, 255, .3); }
.platform-select { height: 36px; padding: 0 12px; border: 1px solid var(--dash-border); border-radius: 11px; outline: none; background: #fff; color: var(--dash-text-soft); font-size: 12px; cursor: pointer; }
.platform-select:focus { border-color: rgba(124, 92, 255, .6); box-shadow: 0 0 0 3px rgba(124, 92, 255, .1); }

.ov-kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; padding-bottom: 6px; }
.ov-kpi { display: flex; min-width: 0; flex-direction: column; gap: 6px; padding: 2px 8px 2px 12px; border-left: 3px solid var(--dash-border-strong); border-radius: 3px; }
.ov-kpi.tone-purple { border-left-color: var(--dash-purple); }
.ov-kpi.tone-blue { border-left-color: var(--dash-blue); }
.ov-kpi.tone-red { border-left-color: var(--dash-red); }
.ov-kpi.tone-amber { border-left-color: #fda29b; }
.ov-kpi.tone-yellow { border-left-color: var(--dash-orange); }
.ov-kpi.tone-green { border-left-color: var(--dash-green); }
.kpi-label { color: var(--dash-text-muted); font-size: 12px; }
.kpi-value { overflow: hidden; color: var(--dash-text); font-size: 25px; font-weight: 750; letter-spacing: -.03em; text-overflow: ellipsis; white-space: nowrap; }
.kpi-value.placeholder { color: var(--dash-text-muted); font-weight: 500; }
.kpi-delta { font-size: 11.5px; font-weight: 600; }
.kpi-delta.up { color: var(--dash-green); }
.kpi-delta.down { color: var(--dash-red); }
.kpi-delta.muted { color: var(--dash-text-muted); font-weight: 400; }

.trend-chart-wrap { position: relative; margin-top: 8px; }
.trend-chart { display: block; width: 100%; height: 268px; overflow: visible; }
.chart-grid line { stroke: #eef1f7; stroke-width: 1; }
.chart-y-label, .chart-x-label { fill: var(--dash-text-muted); font-size: 11px; }
.chart-line { fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.gmv-line { stroke: var(--dash-purple); }
.order-line { stroke: var(--dash-blue); }
.chart-area { opacity: .9; }
.gmv-area { fill: url(#gmv-fill); }
.chart-point { stroke: #fff; stroke-width: 2; cursor: crosshair; }
.gmv-point { fill: var(--dash-purple); }
.order-point { fill: var(--dash-blue); }
.chart-guide { stroke: #cbd5e1; stroke-width: 1; stroke-dasharray: 4 4; }
.chart-hover-dot { stroke: #fff; stroke-width: 2; }
.chart-hover-dot.gmv { fill: var(--dash-purple); }
.chart-hover-dot.orders { fill: var(--dash-blue); }
.chart-legend { display: flex; align-items: center; justify-content: center; gap: 22px; padding: 12px 4px 0; color: var(--dash-text-soft); font-size: 12px; }
.chart-legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend-dot, .tooltip-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.legend-dot.gmv, .tooltip-dot.gmv { background: var(--dash-purple); }
.legend-dot.orders, .tooltip-dot.orders { background: var(--dash-blue); }
.trend-tooltip { position: absolute; top: 12px; transform: translateX(-50%); min-width: 186px; padding: 12px 14px; border: 1px solid rgba(255, 255, 255, .16); border-radius: 12px; background: #1b2740; box-shadow: 0 18px 40px rgba(6, 11, 22, .5); pointer-events: none; z-index: 3; }
.trend-tooltip strong { display: block; padding-bottom: 8px; border-bottom: 1px solid rgba(255, 255, 255, .1); color: #fff; font-size: 11.5px; }
.trend-tooltip span { display: flex; align-items: center; gap: 8px; padding-top: 6px; color: rgba(232, 237, 247, .78); font-size: 11.5px; }
.trend-tooltip b { margin-left: auto; color: #fff; font-size: 12px; }

/* 销售概览是设计稿里的深色 hero 卡：在浅色页面上单独反色。这里就地覆盖 --dash-* 变量，
   卡片内部的标题、KPI、图表、图例、悬浮卡都跟着翻成浅色字，不需要逐个选择器改色。 */
.ov-card-dark {
  --dash-card: #131d33;
  --dash-text: #ffffff;
  --dash-text-soft: rgba(232, 237, 247, .78);
  --dash-text-muted: rgba(232, 237, 247, .56);
  --dash-border: rgba(255, 255, 255, .1);
  --dash-border-strong: rgba(255, 255, 255, .18);
  --dash-green: #34d399;
  --dash-red: #ff8a80;
  /* 标题颜色是外层（.dashboard-shell / body）算好的「近黑」继承下来的，卡内改 --dash-text
     影响不到已经解析过的继承值，所以这里直接给标题和卡片本体重新指定一次。 */
  --color-text-primary: #ffffff;
  --color-text-secondary: rgba(232, 237, 247, .78);
  --color-text-muted: rgba(232, 237, 247, .56);
  color: var(--dash-text);
  border-color: rgba(255, 255, 255, .07);
  background: linear-gradient(158deg, #16203a 0%, #111a2e 55%, #0e1626 100%);
  box-shadow: 0 22px 48px rgba(11, 17, 32, .26);
}
/* 卡片本体的 color 用了 var(--dash-text)，但标题是从外层继承下来的「近黑」，得单独覆盖一次。 */
.ov-card-dark h1, .ov-card-dark h2, .ov-card-dark h3 { color: var(--dash-text); }
.ov-card-dark .period-tabs { background: rgba(255, 255, 255, .07); }
.ov-card-dark .period-tabs button { color: rgba(232, 237, 247, .72); }
.ov-card-dark .period-tabs button:hover, .ov-card-dark .period-tabs button:focus-visible { color: #fff; }
.ov-card-dark .period-tabs button.active { color: #fff; }
.ov-card-dark .platform-select { border-color: rgba(255, 255, 255, .12); background: rgba(255, 255, 255, .07); color: #e8edf7; }
.ov-card-dark .platform-select option { color: #0f1729; }
.ov-card-dark .chart-grid line { stroke: rgba(255, 255, 255, .07); }
.ov-card-dark .chart-grid-v { stroke: rgba(255, 255, 255, .05); stroke-width: 1; }
.ov-card-dark .chart-point, .ov-card-dark .chart-hover-dot { stroke: #111a2e; }
.ov-card-dark .chart-guide { stroke: rgba(255, 255, 255, .3); }
.ov-card-dark .gmv-line { stroke: #9b7cff; }
.ov-card-dark .order-line { stroke: #4d9bff; }
.ov-card-dark .gmv-point { fill: #9b7cff; }
.ov-card-dark .order-point { fill: #4d9bff; }
.ov-card-dark .chart-hover-dot.gmv { fill: #9b7cff; }
.ov-card-dark .chart-hover-dot.orders { fill: #4d9bff; }
.ov-card-dark .empty-chart-icon { border-color: rgba(255, 255, 255, .16); color: rgba(232, 237, 247, .5); }
.ov-card-dark .section-state { color: rgba(232, 237, 247, .58); }
.ov-card-dark .section-state strong { color: rgba(232, 237, 247, .82); }
.section-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--dash-text-muted); text-align: center; }
.section-state strong { color: var(--dash-text-soft); font-size: 12.5px; font-weight: 600; }
.chart-state { height: 268px; }
.empty-chart-icon { display: inline-flex; width: 36px; height: 36px; align-items: center; justify-content: center; border: 1px solid var(--dash-border); border-radius: 11px; color: var(--dash-text-muted); font-size: 20px; }
.loader { width: 16px; height: 16px; border: 2px solid #e3e8f1; border-top-color: var(--dash-purple); border-radius: 50%; animation: dashboard-spin .8s linear infinite; }
@keyframes dashboard-spin { to { transform: rotate(360deg); } }
.error-state { color: var(--dash-red); }

.shortcut-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
/* 设计稿排版：图标在左、标题/副标题在右，按钮在文字下方（不是图标下方） */
.shortcut-tile { display: grid; grid-template-columns: 44px minmax(0, 1fr); grid-template-rows: auto auto; gap: 10px 12px; align-items: start; min-width: 0; padding: 14px; border: 1px solid transparent; border-radius: 16px; background: #f7f9fd; }
.shortcut-tile.tone-purple { background: #f6f3ff; border-color: #ece5ff; }
.shortcut-tile.tone-blue { background: #f2f7ff; border-color: #e3eeff; }
.shortcut-tile.tone-teal { background: #eefaf7; border-color: #dcf3ee; }
.shortcut-tile.tone-rose { background: #fff3f4; border-color: #ffe4e8; }
.shortcut-tile.disabled { opacity: .96; }
.tile-icon { grid-row: 1; grid-column: 1; display: inline-flex; width: 44px; height: 44px; align-items: center; justify-content: center; border-radius: 13px; background: var(--brand-gradient); color: #fff; font-size: 19px; }
.shortcut-tile.tone-blue .tile-icon { background: linear-gradient(135deg, #3f9bff, #1f6fea); }
.shortcut-tile.tone-teal .tile-icon { background: linear-gradient(135deg, #21c8a8, #0e9f8c); }
.shortcut-tile.tone-rose .tile-icon { background: linear-gradient(135deg, #ff8a8a, #ef4a5f); }
.tile-copy { grid-row: 1; grid-column: 2; display: flex; min-width: 0; flex-direction: column; gap: 5px; }
.tile-copy strong { overflow: hidden; color: var(--dash-text); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.tile-copy small { overflow: hidden; color: var(--dash-text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.tile-action { grid-row: 2; grid-column: 2; align-self: start; justify-self: start; min-height: 34px; padding: 0 15px; border: 0; border-radius: 10px; background: var(--brand-gradient); color: #fff; cursor: pointer; font-size: 12px; font-weight: 600; }
.tile-action:hover:not(:disabled), .tile-action:focus-visible { filter: brightness(1.05); outline: none; }
.tile-action:disabled { background: #eef1f7; color: var(--dash-text-muted); cursor: not-allowed; font-weight: 500; }

/* ---------------- 右栏：平台同步 / AI 助手 / 待办 ---------------- */
.ov-pill { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
.ov-pill.success { background: #ecfdf3; color: #027a48; }
.ov-pill.info { background: #eef2f7; color: #475467; }
.ov-empty { padding: 16px 2px; color: var(--dash-text-muted); font-size: 12px; text-align: center; }
.ov-link { display: inline-flex; align-items: center; justify-content: center; gap: 6px; margin-top: 10px; padding-top: 12px; width: 100%; border: 0; border-top: 1px solid #f2f4f8; background: transparent; color: var(--dash-purple); cursor: pointer; font-size: 12.5px; font-weight: 600; }
.ov-link.inline { width: auto; margin: 0; padding: 0; border: 0; font-size: 12px; }
.ov-link:hover, .ov-link:focus-visible { color: #5b3df5; outline: none; }
.sync-row { display: flex; align-items: center; gap: 11px; padding: 11px 0; border-bottom: 1px solid #f4f6fa; }
.sync-row:last-of-type { border-bottom: 0; }
.sync-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }
.sync-copy strong { color: var(--dash-text); font-size: 13px; }
.sync-copy span { color: var(--dash-text-muted); font-size: 11.5px; }
.sync-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.sync-meta strong { display: inline-flex; align-items: center; gap: 5px; color: var(--dash-green); font-size: 12px; }
.sync-meta:has(.sync-dot.offline) strong { color: var(--dash-red); }
.sync-meta:has(.sync-dot.login) strong { color: var(--dash-orange); }
.sync-meta small { color: var(--dash-text-muted); font-size: 11px; white-space: nowrap; }
.sync-dot { display: none; }
.ov-ai { overflow: hidden; border: 0; background: linear-gradient(125deg, #2b2170 0%, #3a2a92 42%, #1b1748 100%); color: #fff; }
.ov-ai-glow { position: absolute; top: -46px; right: -30px; width: 190px; height: 190px; border-radius: 50%; background: radial-gradient(circle, rgba(164, 120, 255, .85), rgba(124, 92, 255, .18) 55%, transparent 72%); filter: blur(2px); }
.ov-ai-copy { position: relative; display: flex; flex-direction: column; gap: 8px; }
.ov-ai-copy h2 { display: flex; align-items: center; gap: 8px; color: #fff; font-size: 16px; }
.ov-ai-copy p { color: rgba(255, 255, 255, .76); font-size: 12px; }
.ov-ai-button { display: inline-flex; align-self: flex-start; align-items: center; gap: 8px; margin-top: 4px; height: 36px; padding: 0 16px; border: 0; border-radius: 11px; background: #fff; color: #3a2a92; cursor: pointer; font-size: 12.5px; font-weight: 700; }
.ov-ai-button:hover, .ov-ai-button:focus-visible { background: #f3efff; outline: none; }
.todo-list { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 0; padding: 0; list-style: none; }
.todo-item { display: flex; align-items: center; gap: 10px; padding: 9px 2px; }
.todo-check { width: 18px; height: 18px; flex: 0 0 18px; border: 1.5px solid #cfd8e6; border-radius: 50%; }
.todo-title { min-width: 0; flex: 1; overflow: hidden; color: var(--dash-text); font-size: 12.5px; text-overflow: ellipsis; white-space: nowrap; }
.todo-chip { flex: 0 0 auto; padding: 3px 9px; border-radius: 8px; font-size: 11px; font-weight: 600; }
.todo-chip.urgent { background: #fff4e5; color: #b54708; }
.todo-chip.info { background: #eef4ff; color: #1d4ed8; }
.todo-add { display: flex; width: 100%; align-items: center; justify-content: center; gap: 6px; margin-top: 10px; height: 38px; border: 1px dashed #d8dfea; border-radius: 12px; background: transparent; color: var(--dash-text-soft); cursor: pointer; font-size: 12.5px; }
.todo-add:hover, .todo-add:focus-visible { border-color: rgba(124, 92, 255, .55); color: var(--dash-purple); outline: none; }

/* ---------------- 弹窗 / 菜单 / 提示 ---------------- */
.dashboard-context-menu { position: fixed; z-index: 220; width: 252px; padding: 6px; border: 1px solid var(--dash-border-strong); border-radius: 14px; background: #fff; box-shadow: var(--shadow-pop); }
.ctx-item { display: block; width: 100%; min-height: 31px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--dash-text-soft); text-align: left; cursor: pointer; font-size: 12px; }
.ctx-item:hover, .ctx-item:focus-visible { background: #f2f4f8; color: var(--dash-text); outline: none; }
.ctx-item:disabled { cursor: not-allowed; opacity: .45; }
.ctx-item.danger:hover { background: #fef3f2; color: #b42318; }
.ctx-sep { height: 1px; margin: 5px 4px; background: var(--dash-border); }
.dashboard-overlay { position: fixed; inset: 0; z-index: 230; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(15, 23, 41, .38); backdrop-filter: blur(3px); }
.dashboard-dialog { width: min(480px, 100%); padding: 20px; border: 1px solid var(--dash-border); border-radius: 18px; background: #fff; box-shadow: var(--shadow-pop); }
.dashboard-dialog h2 { margin: 0 0 14px; font-size: 17px; }
.dashboard-dialog input { width: 100%; min-height: 36px; box-sizing: border-box; padding: 0 11px; border: 1px solid var(--dash-border); border-radius: 10px; outline: none; background: #f7f9fd; color: var(--dash-text); }
.dashboard-dialog input:focus { border-color: rgba(124, 92, 255, .6); background: #fff; box-shadow: 0 0 0 3px rgba(124, 92, 255, .1); }
.dashboard-dialog-note { margin: 0 0 14px; color: var(--dash-text-muted); font-size: 12px; line-height: 1.6; }
.dashboard-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.store-pick { display: flex; align-items: center; gap: 8px; min-height: 32px; color: var(--dash-text-soft); font-size: 12px; }
.store-pick input { width: auto; min-height: 0; }
.modal-mask { position: fixed; inset: 0; z-index: 236; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(15, 23, 41, .38); backdrop-filter: blur(3px); }
.modal { width: min(560px, calc(100vw - 48px)); max-height: min(680px, calc(100vh - 48px)); overflow: auto; padding: 20px; border: 1px solid var(--dash-border); border-radius: 18px; background: #fff; box-shadow: var(--shadow-pop); }
.modal h2 { margin: 0 0 14px; font-size: 17px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
.btn-ghost, .btn-danger { min-height: 32px; padding: 0 13px; border: 1px solid var(--dash-border); border-radius: 9px; background: #fff; color: var(--dash-text-soft); cursor: pointer; font-size: 12px; }
.btn-ghost:hover, .btn-ghost:focus-visible { border-color: rgba(124, 92, 255, .5); color: var(--dash-text); outline: none; }
.btn-danger { border-color: rgba(240, 68, 56, .35); color: #b42318; }
.btn-danger:hover, .btn-danger:focus-visible { background: #fef3f2; outline: none; }
.btn-ghost.sm, .btn-danger.sm { min-height: 26px; padding: 0 9px; font-size: 11px; }
.trash-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--dash-border); }
.trash-meta { min-width: 0; flex: 1; color: var(--dash-text-soft); font-size: 12px; }
.store-create-modal { width: min(520px, calc(100vw - 48px)); }
.modal-field { display: flex; flex-direction: column; gap: 6px; margin: 11px 0; color: var(--dash-text-soft); font-size: 12px; }
.modal-field input, .modal-field select { box-sizing: border-box; width: 100%; min-height: 36px; padding: 0 10px; border: 1px solid var(--dash-border); border-radius: 10px; outline: none; background: #f7f9fd; color: var(--dash-text); }
.modal-field input:focus, .modal-field select:focus { border-color: rgba(124, 92, 255, .6); background: #fff; box-shadow: 0 0 0 3px rgba(124, 92, 255, .1); }
.btn-primary { min-height: 32px; padding: 0 15px; border: 0; border-radius: 9px; background: var(--brand-gradient); color: #fff; cursor: pointer; font-size: 12px; font-weight: 600; }
.btn-primary:disabled { cursor: not-allowed; opacity: .55; }
.unified-button { min-height: 32px; padding: 0 13px; border: 1px solid var(--dash-border); border-radius: 9px; background: #fff; color: var(--dash-text-soft); cursor: pointer; font-size: 12px; }
.unified-button:hover, .unified-button:focus-visible { border-color: rgba(124, 92, 255, .5); color: var(--dash-text); outline: none; }
.unified-button.primary { border: 0; background: var(--brand-gradient); color: #fff; font-weight: 600; }
.unified-button.danger { border-color: rgba(240, 68, 56, .35); color: #b42318; }
.unified-button:disabled { cursor: not-allowed; opacity: .55; }
.dashboard-notice { position: fixed; right: 25px; bottom: 24px; z-index: 240; max-width: 340px; padding: 11px 15px; border: 1px solid var(--dash-border); border-radius: 12px; background: #fff; box-shadow: var(--shadow-pop); color: var(--dash-text); font-size: 12px; }
.dashboard-toast-host { position: fixed; right: 25px; bottom: 24px; z-index: 245; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; max-width: min(420px, calc(100vw - 50px)); pointer-events: none; }
.dashboard-toast { padding: 11px 15px; border: 1px solid var(--dash-border); border-radius: 12px; background: #fff; box-shadow: var(--shadow-pop); color: var(--dash-text-soft); font-size: 12px; }
.dashboard-toast.success { border-color: rgba(18, 183, 106, .35); color: #027a48; }
.dashboard-toast.error { border-color: rgba(240, 68, 56, .35); color: #b42318; }
.command-backdrop { position: fixed; inset: 0; z-index: 170; display: flex; align-items: flex-start; justify-content: center; padding-top: 92px; background: rgba(15, 23, 41, .32); backdrop-filter: blur(2px); }
.command-palette { width: min(560px, calc(100vw - 32px)); overflow: hidden; border: 1px solid var(--dash-border); border-radius: 16px; background: #fff; box-shadow: var(--shadow-pop); }
.command-search { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--dash-border); color: var(--dash-text-muted); }
.command-search input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--dash-text); font-size: 13px; }
.command-results { display: flex; max-height: 330px; flex-direction: column; overflow-y: auto; padding: 7px; }
.command-results button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px; border: 0; border-radius: 10px; background: transparent; text-align: left; cursor: pointer; }
.command-results button:hover, .command-results button:focus-visible { background: #f2f4f8; outline: none; }
.command-result-icon { display: flex; width: 28px; height: 28px; align-items: center; justify-content: center; border-radius: 8px; background: var(--brand-soft); color: var(--dash-purple); }
.command-results button span:nth-child(2) { display: flex; flex: 1; flex-direction: column; gap: 2px; }
.command-results strong { color: var(--dash-text); font-size: 12px; }
.command-results small { color: var(--dash-text-muted); font-size: 11px; }
.command-results kbd { color: var(--dash-text-muted); }
.command-empty { padding: 28px; color: var(--dash-text-muted); text-align: center; font-size: 12px; }

/* ---------------- 响应式 ---------------- */
@media (max-width: 1380px) {
  .dashboard-sidebar { width: 228px; min-width: 228px; }
  .ov-grid { grid-template-columns: minmax(0, 1fr) 300px; }
  .kpi-value { font-size: 21px; }
  .shortcut-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 1180px) {
  .ov-grid { grid-template-columns: minmax(0, 1fr); }
  .ov-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); row-gap: 16px; }
}
@media (max-width: 900px) {
  .dashboard-sidebar { width: 62px; min-width: 62px; }
  .dashboard-brand-copy, .nav-label, .nav-group-title, .dashboard-store-area, .pro-copy, .pro-arrow { display: none; }
  .dashboard-nav { padding: 8px; }
  .dashboard-nav-item { justify-content: center; padding: 0; }
  .dashboard-sidebar-footer { padding: 8px; }
  .ov-card-head { flex-direction: column; align-items: flex-start; }
  .shortcut-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
