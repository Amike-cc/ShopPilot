<template>
  <section
    :class="['dashboard-shell', { 'workspace-hidden': !props.active, 'mobile-nav-open': mobileNavOpen }]"
    data-test="dashboard-home"
  >
    <!-- ============================ 左栏 ============================
         2026-11 重构：由深色侧栏改为浅色统一风。导航分三组（主控 / 运营 / 工具），
         店铺列表独立成区并支持搜索（>6 家时出现），底部只留设置与回收站。
         收起态从"只有 4 个按钮"改为完整图标轨道——收起后仍能切页，不必先展开。 -->
    <aside class="dashboard-sidebar sidebar" :class="['sb', { collapsed: leftSidebarCollapsed, 'mobile-open': mobileNavOpen }]" data-test="sidebar" aria-label="ShopPilot 主导航">
      <div v-if="leftSidebarCollapsed && !mobileNavOpen" class="sb-rail sidebar-rail">
        <button type="button" class="ui-icon-btn" data-test="sidebar-expand" title="展开左侧栏（Ctrl+Shift+E）" @click="setLeftSidebarOpen(true)">
          <AppIcon name="expand" :size="16" />
        </button>
        <div class="sb-rail-sep" aria-hidden="true"></div>
        <button
          v-for="item in visibleNavItems"
          :key="item.key"
          type="button"
          class="ui-icon-btn sb-rail-btn"
          :class="{ on: activeNav === item.label }"
          :data-test="`nav-${item.key}`"
          :title="item.label"
          @click="handleNav(item)"
        >
          <AppIcon :name="item.icon" :size="17" />
        </button>
        <div class="sb-rail-sep" aria-hidden="true"></div>
        <button type="button" class="ui-icon-btn sb-rail-btn btn-new" data-test="rail-new" title="添加店铺" @click="openStoreCreate">
          <AppIcon name="plus" :size="17" />
        </button>
        <button type="button" class="ui-icon-btn sb-rail-btn" data-test="rail-trash" title="回收站" @click="openTrash">
          <AppIcon name="trash" :size="17" />
          <span v-if="ws.trashStores.length" class="rail-badge" data-test="rail-trash-badge"></span>
        </button>
        <button type="button" class="ui-icon-btn sb-rail-btn" data-test="rail-settings" title="设置中心" @click="navigateTo('settings')">
          <AppIcon name="settings" :size="17" />
        </button>
      </div>

      <template v-else>
        <div class="sb-brand">
          <img class="sb-mark" :src="brandMark" alt="" aria-hidden="true" />
          <div class="sb-brand-copy">
            <strong>ShopPilot</strong>
            <span>多平台经营工作台</span>
          </div>
          <button
            type="button"
            class="ui-icon-btn sb-collapse"
            data-test="sidebar-collapse"
            title="收起左侧栏（Ctrl+Shift+E）"
            @click="setLeftSidebarOpen(false)"
          >
            <AppIcon name="collapse" :size="15" />
          </button>
        </div>

        <nav class="sb-nav" aria-label="主功能导航">
          <div v-for="group in navGroups" :key="group.key" class="sb-group">
            <div v-if="group.title" class="sb-group-title">{{ group.title }}</div>
            <button
              v-for="item in group.items"
              :key="item.key"
              type="button"
              :class="['sb-item', 'dashboard-nav-item', { active: activeNav === item.label }]"
              :data-test="`nav-${item.key}`"
              :aria-current="activeNav === item.label ? 'page' : undefined"
              @click="handleNav(item)"
            >
              <AppIcon :name="item.icon" :size="16" />
              <span class="sb-item-label">{{ item.label }}</span>
            </button>
          </div>
        </nav>

        <div class="sb-stores">
          <div class="sb-stores-head">
            <span class="sb-stores-title">我的店铺</span>
            <span class="ui-badge">{{ ws.stores.length }}</span>
            <button type="button" class="ui-icon-btn sb-add btn-new" title="添加店铺" aria-label="添加店铺" @click="openStoreCreate">
              <AppIcon name="plus" :size="15" />
            </button>
          </div>
          <label v-if="ws.stores.length > 6" class="sb-search">
            <AppIcon name="search" :size="13" />
            <input v-model="storeQuery" placeholder="搜索店铺" aria-label="搜索店铺">
          </label>
          <div class="sb-store-list">
            <div v-if="!ws.ready" class="sb-hint">正在读取店铺…</div>
            <div v-else-if="!ws.stores.length" class="sb-empty">
              <div class="sb-empty-icon" aria-hidden="true"><AppIcon name="store" :size="20" /></div>
              <span>还没有店铺</span>
              <button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" @click="openStoreCreate">
                <AppIcon name="plus" :size="13" />添加店铺
              </button>
              <button type="button" class="sb-link" @click="navigateTo('stores')">去店铺管理看看</button>
            </div>
            <template v-else>
              <button
                v-for="store in visibleStores"
                :key="store.id"
                type="button"
                :class="['sb-store', 'store-card', { displayed: ws.displayedStoreId === store.id }]"
                data-test="store-card"
                :data-store-id="store.id"
                :title="`${store.platform} · ${statusLabel(store.status)} · 最近活动 ${storeLastActiveLabel(store.lastActiveAt)}`"
                @click="openStoreFromPage(store.id)"
                @contextmenu.prevent="openStoreContext(store, $event)"
              >
                <PlatformIcon :name="store.platform" :size="16" />
                <span class="sb-store-name">{{ store.name }}</span>
                <span
                  v-if="ws.openingStoreId === store.id"
                  class="sb-store-opening"
                >打开中…</span>
                <span
                  v-else-if="(ws.customerUnread[store.id] || 0) > 0"
                  class="ui-badge ui-badge--danger unread-badge store-unread-badge"
                  data-test="store-unread"
                  :title="`客服未读 ${ws.customerUnread[store.id]} 条`"
                >{{ ws.customerUnread[store.id] > 99 ? '99+' : ws.customerUnread[store.id] }}</span>
                <span v-else-if="statusClass(store.status) !== 'online'" :class="['sb-store-warn', statusClass(store.status)]">{{ statusLabel(store.status) }}</span>
                <!-- 正常只留一个状态点；异常才用文字说出来（安静时安静，出错时显眼） -->
                <i v-if="statusClass(store.status) === 'online'" :class="['ui-dot', statusClass(store.status)]" :title="statusLabel(store.status)" aria-hidden="true"></i>
                <!-- .store-action 是验收脚本用来"打开这家店"的锚点（custom-task / m1 / 邀约系列），
                     保持 22×22 的真实尺寸与可点击：不能只留一个装饰图标。 -->
                <span
                  class="store-action"
                  role="button"
                  tabindex="-1"
                  :title="`打开 ${store.name}`"
                  aria-label="打开浏览器"
                  @click.stop="openStoreFromPage(store.id)"
                ><AppIcon name="arrow-right" :size="13" /></span>
              </button>
              <div v-if="!visibleStores.length" class="sb-hint">没有匹配「{{ storeQuery }}」的店铺</div>
            </template>
          </div>
        </div>

        <div class="sb-foot">
          <button
            type="button"
            :class="['sb-item', 'sb-settings', { active: activeNav === '设置中心' }]"
            data-test="settings-open-btn"
            @click="navigateTo('settings')"
          >
            <AppIcon name="settings" :size="16" />
            <span class="sb-item-label">设置</span>
          </button>
          <button type="button" class="ui-icon-btn sb-trash" data-test="trash-open" title="回收站" aria-label="回收站" @click="openTrash">
            <AppIcon name="trash" :size="16" />
            <span v-if="ws.trashStores.length" class="sb-trash-count">{{ ws.trashStores.length }}</span>
          </button>
        </div>
      </template>
    </aside>

    <button
      v-if="mobileNavOpen"
      type="button"
      class="mobile-sidebar-backdrop"
      data-test="mobile-sidebar-backdrop"
      aria-label="关闭导航菜单"
      @click="mobileNavOpen = false"
    ></button>

    <main class="dashboard-main">
      <header class="dashboard-toolbar">
        <button
          type="button"
          class="mobile-nav-toggle"
          data-test="mobile-nav-toggle"
          :aria-expanded="mobileNavOpen"
          :aria-label="mobileNavOpen ? '关闭导航菜单' : '打开导航菜单'"
          title="导航菜单"
          @click="toggleMobileNav"
        >
          <span></span><span></span><span></span>
        </button>

        <div class="appbar-crumb" aria-label="当前位置">
          <span>工作台</span>
          <AppIcon name="chevron-right" :size="12" />
          <strong>{{ pageTitle }}</strong>
        </div>

        <div class="workspace-switch" role="tablist" aria-label="工作区切换">
          <button
            type="button"
            class="on"
            data-test="workspace-tab-workbench"
            role="tab"
            aria-selected="true"
            tabindex="0"
            title="当前工作台"
            @pointerdown.stop
            @mousedown.stop
            @click.stop
          >工作台</button>
          <button
            type="button"
            data-test="workspace-tab-customer-service"
            role="tab"
            aria-selected="false"
            tabindex="0"
            title="打开电商客服工作区（登录与工作台同步）"
            @pointerdown.stop
            @mousedown.stop
            @click.stop="emit('open-customer-service')"
          >
            电商客服
            <span
              v-if="customerUnreadTotal > 0"
              class="ui-badge ui-badge--danger"
              data-test="customer-service-unread"
              :title="`客服未读 ${customerUnreadTotal} 条`"
            >{{ customerUnreadTotal > 99 ? '99+' : customerUnreadTotal }}</span>
          </button>
        </div>

        <div class="appbar-actions">
          <button type="button" class="appbar-search" data-test="command-open" title="搜索功能与店铺（Ctrl+K）" @click="openCommandPalette">
            <AppIcon name="search" :size="14" />
            <span>搜索</span>
            <kbd class="ui-kbd">Ctrl K</kbd>
          </button>
          <!-- 原来是"看起来能点、点了只弹一句提示"的日期按钮；时钟是事实展示，不该伪装成菜单 -->
          <time class="appbar-clock" :datetime="nowLabel" title="时间取自本机系统时钟">{{ nowLabel }}</time>
          <div class="notification-anchor">
            <button
              type="button"
              class="ui-icon-btn"
              data-test="notification-bell"
              :aria-expanded="notificationOpen"
              title="通知"
              aria-label="通知"
              @click="notificationOpen = !notificationOpen"
            >
              <AppIcon name="bell" :size="17" />
              <i v-if="notificationCount" class="notification-dot" :aria-label="`有 ${notificationCount} 条通知`"></i>
            </button>
            <div v-if="notificationOpen" class="notification-center ui-menu" data-test="notification-center" role="dialog" aria-label="通知中心">
              <header class="notification-head"><strong>通知</strong><span>{{ notificationCount }} 条</span></header>
              <div v-if="!notifications.length" class="notification-empty" data-test="notification-empty">
                暂无通知。达人邀约状态与客服未读会出现在这里。
              </div>
              <button
                v-for="item in notifications"
                :key="item.id"
                type="button"
                class="notification-item"
                :class="'tone-' + item.tone"
                :data-test="'notification-item-' + item.id"
                @click="runNotification(item)"
              >
                <strong>{{ item.title }}</strong>
                <span>{{ item.detail }}</span>
              </button>
            </div>
          </div>
          <span class="appbar-avatar" title="ShopPilot Pro · 本地账号">SP</span>
        </div>
      </header>

      <!-- 店铺 guest 宿主：只要还有店铺处于打开状态就持续挂载，切到别的页面时只隐藏不销毁。
           销毁会连带销毁 webview 元素（也就是 guest 渲染进程），重开会丢掉页面状态、登录流程
           中间步骤与已选的达人分页；隐藏则只影响可见性与命中，页面继续活着。 -->
      <div
        v-if="browserHostMounted"
        :class="['dashboard-browser-host', { active: browserHostActive }]"
        :aria-hidden="!browserHostActive"
        data-test="dashboard-browser-host"
      >
        <DashboardBrowserSurface
          ref="browserSurfaceRef"
          :active="browserHostActive"
          @open-settings="openSettingsTab"
        />
      </div>
      <!-- 页面链与 guest 宿主**并存**：宿主由 CSS（.dashboard-browser-host:not(.active)）
           移出布局流隐藏（guest 保活），只有 browserHostActive 时才接管主区域。
           曾经把页面链写成宿主后面的 v-else-if，导致"有店铺打开时所有页面都不渲染"
           （2026-10-19 集成验收实报）。 -->
      <template v-if="!browserHostActive">
        <UnifiedStorePage v-if="activePage === 'stores'" @open-store="openStoreFromPage" />
        <UnifiedDataPage v-else-if="activePage === 'analytics'" mode="analytics" @open-store="openStoreFromPage" />
        <UnifiedDataPage v-else-if="activePage === 'invoices'" mode="invoices" @open-store="openStoreFromPage" />
        <UnifiedDataPage v-else-if="activePage === 'tax'" mode="tax" @open-store="openStoreFromPage" />
        <UnifiedSettingsPage v-else-if="activePage === 'settings'" :initial-tab="settingsTab" @close="closeSettings" />
        <UnifiedChatImagePage v-else-if="activePage === 'chat-image'" @go-home="navigateTo('overview')" @busy-change="chatImageBusy = $event" />
        <UnifiedAssistantPage v-else-if="activePage === 'assistant'" />
        <UnifiedAppsPage v-else-if="activePage === 'apps'" @navigate="navigateTo" />
        <DashboardOverviewPage
          v-else-if="activePage === 'overview'"
          :invoice-todo-state="invoiceTodoState"
          :pending-invoices="pendingInvoices"
          @navigate="navigateTo"
          @open-invoices="navigateTo('invoices')"
          @open-assistant="openAssistant"
          @notice="showNotice"
          @refresh-invoice-todo="loadInvoiceTodo"
        />
      </template>
    </main>

    <!-- 店铺右键菜单 -->
    <div
      v-if="storeContext.open && storeContext.store"
      class="dashboard-context-menu ui-menu"
      data-test="store-ctx"
      role="menu"
      :style="{ left: `${storeContext.x}px`, top: `${storeContext.y}px` }"
      @click.stop
    >
      <div class="ui-menu__label">{{ storeContext.store.name }}</div>
      <button type="button" class="ui-menu__item" data-test="ctx-toggle" role="menuitem" @click="storeContextAction('toggle')">
        <AppIcon :name="ws.openStoreIds.includes(storeContext.store.id) ? 'stop' : 'panel'" :size="14" />
        {{ ws.openStoreIds.includes(storeContext.store.id) ? '关闭浏览器' : '打开浏览器' }}
      </button>
      <button type="button" class="ui-menu__item" data-test="ctx-standalone" role="menuitem" :disabled="!canOpenStandalone" @click="storeContextAction('standalone')">
        <AppIcon name="external" :size="14" />在独立窗口打开当前标签页
      </button>
      <div class="ui-menu__sep"></div>
      <button type="button" class="ui-menu__item" data-test="ctx-rename" role="menuitem" @click="storeContextAction('rename')">
        <AppIcon name="edit" :size="14" />重命名…
      </button>
      <button type="button" class="ui-menu__item" data-test="ctx-readname" role="menuitem" @click="storeContextAction('readname')">
        <AppIcon name="refresh" :size="14" />读取并更新店铺名（从页面）
      </button>
      <button type="button" class="ui-menu__item" data-test="ctx-copycfg" role="menuitem" :disabled="otherStoreOptions.length === 0" @click="storeContextAction('copycfg')">
        <AppIcon name="copy" :size="14" />复制环境配置到其他店铺…
      </button>
      <button type="button" class="ui-menu__item" data-test="ctx-copyid" role="menuitem" @click="storeContextAction('copyid')">
        <AppIcon name="tag" :size="14" />复制店铺 ID
      </button>
      <div class="ui-menu__sep"></div>
      <button type="button" class="ui-menu__item ui-menu__item--danger" data-test="ctx-trash" role="menuitem" @click="storeContextAction('trash')">
        <AppIcon name="trash" :size="14" />移入回收站
      </button>
    </div>

    <!-- 重命名 -->
    <div v-if="renameDialog.open" class="ui-overlay" data-test="rename-dialog" @click.self="renameDialog.open = false">
      <section class="ui-dialog" role="dialog" aria-modal="true" aria-label="重命名店铺">
        <div class="ui-dialog__head">
          <div><h2>重命名店铺</h2><p>只改本机显示名，不影响平台店铺名称。</p></div>
          <button type="button" class="ui-icon-btn" aria-label="关闭" @click="renameDialog.open = false"><AppIcon name="close" :size="15" /></button>
        </div>
        <div class="ui-dialog__body">
          <input v-model="renameDialog.value" class="ui-input" data-test="rename-input" maxlength="60" placeholder="店铺名称" @keydown.enter="saveStoreRename">
        </div>
        <div class="ui-dialog__foot">
          <button type="button" class="ui-btn ui-btn--secondary" @click="renameDialog.open = false">取消</button>
          <button type="button" class="ui-btn ui-btn--primary" data-test="rename-save" :disabled="!renameDialog.value.trim()" @click="saveStoreRename">保存</button>
        </div>
      </section>
    </div>

    <!-- 复制环境配置 -->
    <div v-if="copyConfigDialog.open" class="ui-overlay" data-test="copy-config-dialog" @click.self="copyConfigDialog.open = false">
      <section class="ui-dialog" role="dialog" aria-modal="true" aria-label="复制环境配置">
        <div class="ui-dialog__head">
          <div><h2>复制环境配置</h2><p>只复制环境指纹配置，不含 Cookie 会话和代理凭据。</p></div>
          <button type="button" class="ui-icon-btn" aria-label="关闭" @click="copyConfigDialog.open = false"><AppIcon name="close" :size="15" /></button>
        </div>
        <div class="ui-dialog__body">
          <div class="pick-list">
            <label v-for="store in otherStoreOptions" :key="store.id" class="pick-row">
              <input v-model="copyConfigDialog.targets" type="checkbox" :value="store.id" data-test="pick-target">
              <PlatformIcon :name="store.platform" :size="15" />
              <span>{{ store.name }}</span>
            </label>
          </div>
        </div>
        <div class="ui-dialog__foot">
          <button type="button" class="ui-btn ui-btn--secondary" @click="copyConfigDialog.open = false">取消</button>
          <button type="button" class="ui-btn ui-btn--primary" data-test="copy-apply" :disabled="!copyConfigDialog.targets.length" @click="applyStoreConfigCopy">复制到选中店铺</button>
        </div>
      </section>
    </div>

    <!-- 通用确认 -->
    <div v-if="confirmDialog.open" class="ui-overlay" data-test="confirm-dialog" @click.self="dismissConfirmDialog">
      <section class="ui-dialog" role="alertdialog" aria-modal="true" aria-label="确认操作">
        <div class="ui-dialog__head">
          <div><h2>{{ confirmDialog.title }}</h2><p>{{ confirmDialog.message }}</p></div>
        </div>
        <div class="ui-dialog__foot">
          <button type="button" class="ui-btn ui-btn--secondary" @click="dismissConfirmDialog">取消</button>
          <button type="button" class="ui-btn ui-btn--danger-solid" data-test="confirm-ok" @click="runConfirmDialog">确认</button>
        </div>
      </section>
    </div>

    <!-- 添加店铺 -->
    <div v-if="createStoreDialog.open" class="ui-overlay" data-test="store-create-dialog" @click.self="createStoreDialog.open = false">
      <form class="ui-dialog" @submit.prevent="submitStoreCreate">
        <div class="ui-dialog__head">
          <div><h2>添加店铺</h2><p>创建后会为这家店分配独立的浏览器会话与环境配置。</p></div>
          <button type="button" class="ui-icon-btn" aria-label="关闭" @click="createStoreDialog.open = false"><AppIcon name="close" :size="15" /></button>
        </div>
        <div class="ui-dialog__body dialog-form">
          <label class="ui-field">
            <span class="ui-field__label">店铺名称</span>
            <input v-model="createStoreDialog.name" class="ui-input" data-test="store-name" required placeholder="例如：美国主站">
          </label>
          <label class="ui-field">
            <span class="ui-field__label">平台</span>
            <select v-model="createStoreDialog.platform" class="ui-select" data-test="platform-select" data-unified-test="store-platform" @change="onCreatePlatformChange">
              <option v-for="platform in availablePlatforms" :key="platform.name" :value="platform.name">{{ platform.name }}</option>
              <option value="其他">其他（自定义平台）</option>
            </select>
          </label>
          <label class="ui-field">
            <span class="ui-field__label">后台地址</span>
            <input v-model="createStoreDialog.adminUrl" class="ui-input" data-test="admin-url" required placeholder="https://…">
            <span v-if="createStoreDialog.adminUrl" class="ui-field__hint">已按所选平台填入默认后台地址，可自行修改</span>
          </label>
          <div v-if="createStoreError" class="ui-notice ui-notice--error" role="alert">{{ createStoreError }}</div>
        </div>
        <!-- modal-actions / btn-primary 是 m1 验收脚本点「创建」用的类名锚点，保留别名不改脚本 -->
        <div class="ui-dialog__foot modal-actions">
          <button type="button" class="ui-btn ui-btn--secondary btn-ghost" @click="createStoreDialog.open = false">取消</button>
          <button type="submit" class="ui-btn ui-btn--primary btn-primary" :disabled="createStoreBusy || !createStoreDialog.name.trim() || !createStoreDialog.adminUrl.trim()">
            {{ createStoreBusy ? '创建中…' : '创建' }}
          </button>
        </div>
      </form>
    </div>

    <!-- 回收站 -->
    <div v-if="ws.trashOpen" class="ui-overlay" data-test="trash-dialog" @click.self="closeTrash">
      <div class="ui-dialog ui-dialog--wide" role="dialog" aria-modal="true" aria-label="回收站">
        <div class="ui-dialog__head">
          <div><h2>回收站</h2><p>移入回收站的店铺会保留会话与环境配置，可随时恢复。</p></div>
          <button type="button" class="ui-icon-btn" aria-label="关闭" @click="closeTrash"><AppIcon name="close" :size="15" /></button>
        </div>
        <div class="ui-dialog__body">
          <div v-if="!ws.trashStores.length" class="ui-empty ui-empty--compact">
            <div class="ui-empty__icon"><AppIcon name="trash" :size="20" /></div>
            <strong class="ui-empty__title">回收站是空的</strong>
            <span class="ui-empty__desc">被移入回收站的店铺会出现在这里，可恢复或彻底删除。</span>
          </div>
          <div v-for="trashStore in ws.trashStores" :key="trashStore.id" class="trash-row">
            <PlatformIcon :name="trashStore.platform" :size="22" />
            <div class="trash-meta">
              <div>{{ trashStore.name }}</div>
              <div class="ui-row__sub">{{ trashStore.platform }}</div>
            </div>
            <button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" @click="ws.restoreStore(trashStore.id)">
              <AppIcon name="arrow-left" :size="13" />恢复
            </button>
            <button type="button" class="ui-btn ui-btn--danger ui-btn--sm" @click="confirmPurge(trashStore)">
              <AppIcon name="trash" :size="13" />彻底删除
            </button>
          </div>
        </div>
        <div class="ui-dialog__foot">
          <button type="button" class="ui-btn ui-btn--secondary" @click="closeTrash">关闭</button>
        </div>
      </div>
    </div>

    <div v-if="notice" class="appbar-notice" role="status">
      <AppIcon name="info" :size="14" />{{ notice }}
    </div>
    <div class="ui-toast-host" aria-live="polite" aria-atomic="false">
      <div
        v-for="toast in ws.toasts"
        :key="toast.id"
        :class="['ui-toast', 'toast', toast.kind === 'error' ? 'ui-toast--error' : toast.kind === 'success' ? 'ui-toast--success' : '']"
      >{{ toast.text }}</div>
    </div>

    <!-- 命令面板 -->
    <div v-if="commandOpen" class="command-backdrop" @click.self="commandOpen = false">
      <section class="command-palette" role="dialog" aria-modal="true" aria-label="全局搜索">
        <div class="command-search">
          <AppIcon name="search" :size="17" />
          <input ref="commandInput" v-model="globalQuery" autofocus placeholder="搜索功能、店铺或达人邀约…" aria-label="搜索功能与店铺" @keydown.esc="commandOpen = false">
          <kbd class="ui-kbd">Esc</kbd>
        </div>
        <div v-if="commandResults.length" class="command-results">
          <button v-for="result in commandResults" :key="result.key" type="button" class="command-result" @click="runCommand(result)">
            <span class="command-result-icon"><AppIcon :name="result.icon" :size="16" /></span>
            <span class="command-result-copy"><strong>{{ result.label }}</strong><small>{{ result.description }}</small></span>
            <AppIcon name="arrow-right" :size="14" />
          </button>
        </div>
        <div v-else class="command-empty">没有匹配的功能或店铺</div>
      </section>
    </div>

    <AgentDock
      v-if="hasNativeBridge && isModuleInstalled('ai-assistant') && activePage !== 'assistant'"
      :locked="ws.appLocked"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import PlatformIcon from '../../components/PlatformIcon.vue'
import AppIcon from '../../components/ui/AppIcon.vue'
import AgentDock from '../agent/AgentDock.vue'
import DashboardBrowserSurface from './DashboardBrowserSurface.vue'
// 首屏按需加载：这些页面级重资产（数据中心/设置/邀约）只在用户真正
// 切到对应页签时才拉取对应 chunk，首屏 JS 不再把它们打进来。组件名与 props/emits 用法不变。
const UnifiedStorePage = defineAsyncComponent(() => import('./UnifiedStorePage.vue'))
const UnifiedDataPage = defineAsyncComponent(() => import('./UnifiedDataPage.vue'))
const UnifiedSettingsPage = defineAsyncComponent(() => import('./UnifiedSettingsPage.vue'))
const UnifiedChatImagePage = defineAsyncComponent(() => import('./UnifiedChatImagePage.vue'))
const UnifiedAssistantPage = defineAsyncComponent(() => import('./UnifiedAssistantPage.vue'))
const UnifiedAppsPage = defineAsyncComponent(() => import('./UnifiedAppsPage.vue'))
import DashboardOverviewPage from './components/DashboardOverviewPage.vue'
import { waitForWorkspaceReady } from './use-dashboard-overview'
import { ensureAppModulesLoaded, isModuleInstalled, type OptionalModuleKey } from './use-app-modules'
import { buildWorkbenchNotifications, type WorkbenchNotificationItem } from './notification-center'
import { storeLastActiveLabel } from './store-activity'
import { useAgentStore } from '../../stores/agent'
import { useWorkspaceStore, type StoreRow } from '../../stores/workspace'
import brandMark from '../../assets/brand/shopilot-mark.svg'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import { storeStatusLabel } from '@shared/enums/store-status'

type LoadState = 'loading' | 'ready' | 'empty' | 'error'

const emit = defineEmits<{
  'open-store': [storeId: string]
  'open-customer-service': []
}>()
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true })

const ws = useWorkspaceStore()
const agent = useAgentStore()
/**
 * 导航模型（2026-11 重构）：icon 改为 AppIcon 的名字，不再依赖 15–20px 的 PNG。
 * 分组按"一天里的使用顺序"排：主控台（看与管）→ 运营（对账与报送）→ 工具（创作与入口）。
 */
type NavItem = { key: string; label: string; icon: string }
const navItems: NavItem[] = [
  { key: 'overview', label: '经营总览', icon: 'home' },
  { key: 'stores', label: '店铺管理', icon: 'store' },
  { key: 'analytics', label: '数据分析', icon: 'chart' },
  { key: 'invoices', label: '发票中心', icon: 'receipt' },
  { key: 'tax', label: '涉税信息', icon: 'percent' },
  { key: 'assistant', label: 'AI 电商助手', icon: 'sparkles' },
  { key: 'chat-image', label: '对话生图', icon: 'message' },
  { key: 'apps', label: '应用商城', icon: 'grid' }
]
const activeNav = ref('经营总览')
/**
 * 可选模块（发票/涉税/两个 AI 工具）支持在应用商城下载安装/卸载；
 * 卸载后只隐藏入口与路由，数据保留。核心功能（总览/店铺/数据/商城/设置）不在过滤范围。
 */
const OPTIONAL_PAGE_MODULE: Record<string, OptionalModuleKey> = {
  invoices: 'invoices',
  tax: 'tax',
  assistant: 'ai-assistant',
  'chat-image': 'ai-chat-image'
}
const visibleNavItems = computed(() => navItems.filter((item) => {
  const moduleKey = OPTIONAL_PAGE_MODULE[item.key]
  return !moduleKey || isModuleInstalled(moduleKey)
}))
void ensureAppModulesLoaded()
/** 侧栏导航分组：主控台 / 运营 / AI 工具（每个工具独立入口）/ 工具 */
const navGroups = computed(() => [
  { key: 'main', title: '', items: visibleNavItems.value.filter(item => ['经营总览', '店铺管理'].includes(item.label)) },
  { key: 'ops', title: '运营', items: visibleNavItems.value.filter(item => ['数据分析', '发票中心', '涉税信息'].includes(item.label)) },
  { key: 'ai', title: 'AI 工具', items: visibleNavItems.value.filter(item => ['AI 电商助手', '对话生图'].includes(item.label)) },
  { key: 'tools', title: '工具', items: visibleNavItems.value.filter(item => ['应用商城'].includes(item.label)) }
].filter(group => group.items.length > 0))
/** 店铺搜索：只在店铺多到列表要滚的时候出现，少店铺时不占一行 */
const storeQuery = ref('')
const visibleStores = computed(() => {
  // 归档 = 不参与日常切换：侧栏与"在用店铺"都不再列出，店铺管理里可在「已归档」恢复。
  const active = ws.stores.filter(store => store.status !== 'archived')
  const keyword = storeQuery.value.trim().toLowerCase()
  if (!keyword) return active
  return active.filter(store => `${store.name} ${store.platform}`.toLowerCase().includes(keyword))
})
const PAGE_TITLES: Record<string, string> = {
  overview: '经营总览', browser: '店铺工作台', stores: '店铺管理',
  assistant: 'AI 电商助手', analytics: '数据分析', invoices: '发票中心', tax: '涉税信息', apps: '应用商城', settings: '设置中心',
  'chat-image': '对话生图'
}
const pageTitle = computed(() => PAGE_TITLES[activePage.value] || '经营总览')
/**
 * 客服未读总数（2026-10-16「实时检测店铺消息」）：侧栏客服入口红点用。
 * 只累加真读到的正数——读不到的店按 0 算，绝不虚报（口径与 @shared/customer-message-alert 一致）。
 */
const customerUnreadTotal = computed(() =>
  Object.values(ws.customerUnread || {}).reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? Number(value) : 0), 0)
)
/** 顶栏时间（设计稿里是实时时钟；每秒走一格，和系统时间一致） */
const nowLabel = ref('')
let clockTimer: number | undefined
function tickClock() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  nowLabel.value = `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
type DashboardPage = 'overview' | 'browser' | 'stores' | 'analytics' | 'apps' | 'settings' | 'invoices' | 'tax' | 'assistant' | 'chat-image'
type SettingsTab = 'entry' | 'ai' | 'security' | 'extensions' | 'maintenance' | 'about'
const activePage = ref<DashboardPage>('overview')
/** 对话生图生成中：消息与结果只在页面内存里，切走会丢。 */
const chatImageBusy = ref(false)
const settingsReturnPage = ref<DashboardPage>('overview')
const settingsReturnStoreId = ref<string | null>(null)
const settingsTab = ref<SettingsTab>('entry')
/** 有店铺处于打开状态 → guest 宿主常驻（页面状态不因切页丢失）。 */
const browserHostMounted = computed(() => ws.openStoreIds.length > 0)
/** 宿主是否真的显示给用户：在浏览器页且确实显示着某家店铺。 */
const browserHostActive = computed(() => props.active && activePage.value === 'browser' && !!ws.displayedStoreId)
const storeContext = reactive({ open: false, x: 0, y: 0, store: null as StoreRow | null })
const renameDialog = reactive({ open: false, value: '' })
const copyConfigDialog = reactive({ open: false, sourceId: '', sourceName: '', targets: [] as string[] })
const confirmDialog = reactive({ open: false, title: '', message: '', action: null as null | (() => Promise<void>) })
const createStoreDialog = reactive({ open: false, name: '', platform: '拼多多', adminUrl: '' })
const createStoreError = ref('')
const createStoreBusy = ref(false)
const availablePlatforms = (((window as Window & { shopilot?: Window['shopilot'] }).shopilot?.platforms || []) as Array<{ name: string; adminUrl: string }>)
const leftSidebarCollapsed = ref(false)
/** 窄屏时把完整导航作为抽屉打开；桌面宽度下按钮与状态不会参与布局。 */
const mobileNavOpen = ref(false)
function toggleMobileNav() {
  mobileNavOpen.value = !mobileNavOpen.value
  // 侧栏收起偏好只适合桌面常驻布局；移动抽屉打开时必须恢复内容，否则只会显示空轨道。
  if (mobileNavOpen.value && leftSidebarCollapsed.value) leftSidebarCollapsed.value = false
}
const hasNativeBridge = typeof window !== 'undefined' && !!(window as Window & { shopilot?: Window['shopilot'] }).shopilot
const globalQuery = ref('')
const commandOpen = ref(false)
const commandInput = ref<HTMLInputElement | null>(null)
const notice = ref('')
const invoiceTodoState = ref<LoadState>('loading')
const invoiceTodoRows = ref<Array<{ storeId: string; storeName: string; count: number }>>([])
let noticeTimer: number | undefined


/** 顶栏通知中心只聚合仍有用户页面的达人邀约状态与客服未读。 */
const notificationOpen = ref(false)
/** 运行状态以 runLive 的实时值为准（latestRun 可能停在列表加载那一刻）。 */
const notificationTasks = computed(() => ws.tasks
  .filter(task => task?.kind === 'creator_invite' || String(task?.name || '').trim().startsWith('达人邀约 ·'))
  .map(task => {
    const run = task?.latestRun
    const live = run?.id ? ws.runLive?.[run.id]?.status : null
    return live && run ? { ...task, latestRun: { ...run, status: live } } : task
  }))
const notifications = computed<WorkbenchNotificationItem[]>(() => buildWorkbenchNotifications({
  tasks: notificationTasks.value as any,
  customerUnread: customerUnreadTotal.value
}))
const notificationCount = computed(() => notifications.value.length)
const browserSurfaceRef = ref<{ openInvitePanel: (storeId?: string | null) => Promise<void> } | null>(null)
/**
 * 通知点击：客服走抽屉，达人邀约**不再有独立页**——切到店铺工作台并打开右侧邀约面板。
 * 面板没挂载时兜底只切店铺，至少让用户看到目标店铺。
 */
async function runNotification(item: WorkbenchNotificationItem) {
  notificationOpen.value = false
  if (item.target === 'customer-service') {
    emit('open-customer-service')
    return
  }
  navigateTo('browser')
  await nextTick()
  if (browserSurfaceRef.value) {
    await browserSurfaceRef.value.openInvitePanel(item.storeId || null)
  } else if (item.storeId) {
    try { await ws.showStore(item.storeId) } catch { /* 店铺可能已删除 */ }
  }
}
const otherStoreOptions = computed(() => ws.stores.filter(store => store.id !== storeContext.store?.id))
const canOpenStandalone = computed(() => !!storeContext.store && ws.displayedStoreId === storeContext.store.id && !!ws.activeTab)

type PendingInvoiceItem = { id: string; name: string; badge: string; tone: string }
const pendingInvoices = computed((): PendingInvoiceItem[] => invoiceTodoRows.value.map(row => ({
    id: `invoice:${row.storeId}`,
    name: `${row.storeName} · 待开发票`,
    badge: `${row.count} 条`,
    tone: 'urgent'
  })).slice(0, 3))


function statusClass(status: string) { return status === 'online' ? 'online' : ['needs_login', 'proxy_error'].includes(status) ? 'warning' : 'offline' }
// P2-2（2026-10-15 审查）：原先只判 online/needs_login/launching，proxy_error/archived/incomplete
// 全部落「离线」——同一店铺在不同页显示互相矛盾的文案。统一走 shared 的单一映射。
function statusLabel(status: string) { return storeStatusLabel(status) }

async function loadInvoiceTodo() {
  if (!isModuleInstalled('invoices')) { invoiceTodoRows.value = []; invoiceTodoState.value = 'empty'; return }
  invoiceTodoState.value = 'loading'
  try {
    const response = await window.shopilot.overview.invoiceCenter()
    if (!response.ok) { invoiceTodoRows.value = []; invoiceTodoState.value = 'error'; return }
    const rows = (response.data as { rows?: Array<{ storeId?: unknown; storeName?: unknown; count?: unknown }> } | undefined)?.rows || []
    invoiceTodoRows.value = rows
      .map(row => ({ storeId: String(row.storeId || ''), storeName: String(row.storeName || '未命名店铺'), count: Number(row.count) || 0 }))
      .filter(row => row.storeId && row.count > 0)
    invoiceTodoState.value = invoiceTodoRows.value.length ? 'ready' : 'empty'
  } catch {
    invoiceTodoRows.value = []
    invoiceTodoState.value = 'error'
  }
}
function showNotice(message: string) { notice.value = message; if (noticeTimer) window.clearTimeout(noticeTimer); noticeTimer = window.setTimeout(() => { notice.value = '' }, 3600) }
function handleNav(item: { key: string }) {
  mobileNavOpen.value = false
  navigateTo(item.key as DashboardPage)
}
/**
 * 生图页面正在请求接口时拦截离开：结果只在当前页面内存里，
 * 切页会卸载组件、丢掉已经拿到的图片与文案。
 */
function preventBusyAiStudioExit() {
  if (activePage.value === 'chat-image' && chatImageBusy.value) {
    activeNav.value = '对话生图'
    showNotice('对话仍在生成图片，完成后再离开，避免丢失结果。')
    return true
  }
  return false
}
function navigateTo(page: DashboardPage) {
  const moduleKey = OPTIONAL_PAGE_MODULE[page]
  if (moduleKey && !isModuleInstalled(moduleKey)) {
    showNotice(`「${PAGE_TITLES[page] || '该功能'}」未安装，可在应用商城下载安装`)
    page = 'apps'
  }
  if (page !== activePage.value && preventBusyAiStudioExit()) return
  mobileNavOpen.value = false
  // B4：回到经营总览时补一次发票待办——「待开发票」那几行只在挂载与"停在总览页时的任务终态事件"
  // 里刷新；从发票中心采集完再回来，数字会停在这一轮之前（看起来像"采集没生效"）。
  if (page === 'overview' && activePage.value !== 'overview') void loadInvoiceTodo()
  if (page === 'settings' && activePage.value !== 'settings') {
    settingsReturnPage.value = activePage.value
    settingsReturnStoreId.value = ws.displayedStoreId
  }
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
  else if (page === 'stores') activeNav.value = '店铺管理'
  else if (page === 'assistant') activeNav.value = 'AI 电商助手'
  else if (page === 'analytics') activeNav.value = '数据分析'
  else if (page === 'invoices') activeNav.value = '发票中心'
  else if (page === 'tax') activeNav.value = '涉税信息'
  else if (page === 'apps') activeNav.value = '应用商城'
  else if (page === 'chat-image') activeNav.value = '对话生图'
}
/** 设置中心页签白名单：环境面板等入口只允许跳到已知页签，未知值回落到默认「平台入口」 */
const SETTINGS_TABS: SettingsTab[] = ['entry', 'ai', 'security', 'extensions', 'maintenance', 'about']
function openSettingsTab(tab?: string) {
  settingsTab.value = (SETTINGS_TABS as string[]).includes(tab || '') ? (tab as SettingsTab) : 'entry'
  navigateTo('settings')
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
async function openStoreFromPage(storeId: string) {
  if (preventBusyAiStudioExit()) return
  mobileNavOpen.value = false
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
  const bridge = (window as Window & { shopilot?: Window['shopilot'] }).shopilot
  if (bridge) void bridge.settings.set('ui.leftSidebarCollapsed', !open)
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
  confirmDialog.title = '彻底删除店铺'
  confirmDialog.message = `彻底删除「${store.name}」后不可恢复，将清除其环境、下载记录与缓存。`
  confirmDialog.action = async () => { await ws.purgeStore(store.id) }
  confirmDialog.open = true
}
function openStoreContext(store: StoreRow, event: MouseEvent) {
  storeContext.store = store
  const width = 252; const height = 306
  storeContext.x = Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))
  storeContext.y = Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))
  storeContext.open = true
}
function closeStoreContext() { storeContext.open = false }
async function storeContextAction(kind: 'toggle' | 'standalone' | 'rename' | 'readname' | 'copycfg' | 'copyid' | 'trash') {
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
  if (kind === 'readname') {
    // 右键是**明确意图**：读出真名就直接更新（不再弹对话框让人确认），与页面加载时的自动改名
    // 同一条写库路径；改了什么用提示说清楚，想手工改名仍走「重命名…」。
    if (!ws.openStoreIds.includes(store.id)) { ws.toast('先打开这家店的浏览器，再去读店铺名', 'info'); return }
    ws.toast('正在从店铺页面读取店铺名…', 'info', 2000)
    const result = await window.shopilot.browser.readStoreName(store.id)
    if (!result.ok) { ws.toast(`读取失败：${result.error.message}`, 'error'); return }
    const data = result.data as { ok?: boolean; name?: string | null; sourceLabel?: string | null; reason?: string | null; pageKind?: string } | null
    if (!data?.name) {
      // 读不到就如实说：登录页说"先登录"，子页面说"回首页再试"，不拿界面词硬凑一个名字
      ws.toast(data?.reason || '这个页面读不到店铺名', data?.pageKind === 'login' ? 'info' : 'error', 5000)
      return
    }
    if (data.name === store.name) { ws.toast(`店铺名已经是「${data.name}」`, 'success'); return }
    const updated = await window.shopilot.store.update({ storeId: store.id, patch: { name: data.name } })
    if (!updated.ok) { ws.toast(`更新店铺名失败：${updated.error.message}`, 'error'); return }
    await ws.refreshStores()
    ws.toast(`店铺名已更新：「${store.name}」→「${data.name}」（来源：${data.sourceLabel || '页面'}）`, 'success', 6000)
    return
  }
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
function dismissConfirmDialog() {
  confirmDialog.open = false
  confirmDialog.action = null
}
async function syncStoreContextOcclusion() {
  const bridge = (window as Window & { shopilot?: Window['shopilot'] }).shopilot
  if (!bridge) return
  await nextTick()
  const menu = document.querySelector('[data-test="store-ctx"]') as HTMLElement | null
  const viewport = document.querySelector('[data-test="dashboard-browser-viewport"]') as HTMLElement | null
  if (!menu || !viewport) { await bridge.browser.setViewsObscured(false); return }
  const m = menu.getBoundingClientRect(); const v = viewport.getBoundingClientRect()
  const sidebar = document.querySelector('.dashboard-sidebar')?.getBoundingClientRect()
  // 店铺列表位于固定左栏；右键点在左栏时菜单不会盖住原生店铺视图，即使浏览器布局尚未完成一次测量也不能误隐藏。
  if (storeContext.x < (sidebar?.right || 268)) { await bridge.browser.setViewsObscured(false); return }
  const overlap = !(m.right <= v.left || m.left >= v.right || m.bottom <= v.top || m.top >= v.bottom)
  await bridge.browser.setViewsObscured(overlap)
}
async function openAssistant() {
  if (!isModuleInstalled('ai-assistant')) {
    showNotice('「AI 电商助手」未安装，可在应用商城下载安装')
    navigateTo('apps')
    return
  }
  // 助手是独立功能页；右下角悬浮球仍保留为不离开当前页的快捷入口。
  navigateTo('assistant')
}
function openCommandPalette() { commandOpen.value = true; nextTick(() => commandInput.value?.focus()) }
const commandResults = computed(() => {
  const query = globalQuery.value.trim().toLowerCase()
  const results = [
    { key: 'home', icon: 'home', label: '经营总览', description: '回到经营总览', action: () => navigateTo('overview') },
    { key: 'trend', icon: 'chart', label: '销售趋势', description: '打开数据分析页面', action: () => navigateTo('analytics') },
    { key: 'settings', icon: 'settings', label: '设置中心', description: '打开统一设置页面', action: () => navigateTo('settings') },
    ...ws.stores.map(store => ({ key: `store-${store.id}`, icon: 'store', label: store.name, description: `${store.platform} · 打开店铺浏览器`, action: () => openStoreFromPage(store.id) }))
  ]
  return query ? results.filter(item => `${item.label} ${item.description}`.toLowerCase().includes(query)).slice(0, 8) : results.slice(0, 6)
})
function runCommand(result: any) { commandOpen.value = false; result.action() }
function onKeydown(event: KeyboardEvent) {
  // 两个工作区共存时，快捷键只归当前可见的经营工作台处理。
  if (!props.active) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommandPalette() }
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'e') { event.preventDefault(); setLeftSidebarOpen(leftSidebarCollapsed.value); return }
  if (event.key === 'Escape') {
    if (confirmDialog.open) { dismissConfirmDialog(); event.preventDefault() }
    else if (renameDialog.open) { renameDialog.open = false; event.preventDefault() }
    else if (copyConfigDialog.open) { copyConfigDialog.open = false; event.preventDefault() }
    else if (notificationOpen.value) { notificationOpen.value = false; event.preventDefault() }
    else if (storeContext.open) { closeStoreContext(); event.preventDefault() }
    else if (agent.ui.drawerOpen) { agent.setDrawerOpen(false); event.preventDefault() }
    commandOpen.value = false
    mobileNavOpen.value = false
  }
}
function onDocumentMouseDown(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (storeContext.open && !target?.closest('[data-test="store-ctx"]')) closeStoreContext()
  if (notificationOpen.value && !target?.closest('[data-test="notification-center"]') && !target?.closest('[data-test="notification-bell"]')) {
    notificationOpen.value = false
  }
}
watch(() => [storeContext.open, storeContext.x, storeContext.y], () => { void syncStoreContextOcclusion() })
watch(() => ws.trashOpen, open => {
  const bridge = (window as Window & { shopilot?: Window['shopilot'] }).shopilot
  if (bridge) void bridge.browser.setViewsObscured(!!open)
})
function onTaskProgress(event: any) {
  // 原 isOnOverview 的等价写法：容器仍然常驻，「待开发票」卡片只在总览页显示。
  if (activePage.value === 'overview' && (event?.phase === 'finished' || event?.phase === 'failed')) {
    void loadInvoiceTodo()
  }
}
// 主进程**单方面**显示店铺时（Agent 动作 / 开店后自动显示 → BROWSER_DISPLAY_CHANGED，
// workspace 已更新 displayedStoreId 与 displaySource）才把页面切过去：不切的话原生店铺视图
// 会盖住当前页（数据分析/设置…），而用户没有任何界面入口能纠正。
// 渲染层自己请求的显示（displaySource==='renderer'）不跟随——它本来就在正确的页上，
// 跟随会打断它自己的导航时序（实测会让"点店铺卡片进入"这类流程落空）。
watch([() => ws.displayedStoreId, () => ws.displaySource], ([storeId, source]) => {
  // 客服工作区显示时，经营工作台虽然保持挂载，但不跟随后台/Agent 的店铺显示事件改页。
  if (!props.active) return
  if (storeId && source === 'main' && activePage.value !== 'browser') {
    if (preventBusyAiStudioExit()) {
      // 主进程的原生店铺视图覆盖在渲染层上；生成未结束时收起它，保留生图页面。
      ws.displayedStoreId = null
      const bridge = (window as Window & { shopilot?: Window['shopilot'] }).shopilot
      if (bridge) void bridge.browser.display(null)
      return
    }
    activePage.value = 'browser'
    activeNav.value = '经营总览'
  }
})

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  document.addEventListener('mousedown', onDocumentMouseDown)
  // Vite 预览页没有 Electron preload；保留纯渲染层页面可见，便于逐页做界面审查。
  // 桌面应用仍走下面的真实 IPC 初始化路径。
  if (!window.shopilot) {
    tickClock()
    clockTimer = window.setInterval(tickClock, 1000)
    return
  }
  window.shopilot.on(EVENT_CHANNELS.TASK_PROGRESS, onTaskProgress)
  tickClock()
  clockTimer = window.setInterval(tickClock, 1000)
  // DashboardView 现在是应用的真实入口，必须自行完成工作区初始化，不能依赖旧 WorkbenchView 的生命周期。
  await ws.init()
  await waitForWorkspaceReady(ws)
  const savedSidebar = await window.shopilot.settings.get('ui.leftSidebarCollapsed')
  if (savedSidebar.ok && savedSidebar.data?.value === true) leftSidebarCollapsed.value = true
  if (ws.displayedStoreId) { activePage.value = 'browser'; activeNav.value = '经营总览' }
})
// 概览数据（快照/采集指标/趋势）的加载、定时刷新与采集完成监听都在子组件 + use-dashboard-overview 里，
// 容器只在总览页事件（任务终态）时刷新「待开发票」卡片。
onBeforeUnmount(() => { window.removeEventListener('keydown', onKeydown); document.removeEventListener('mousedown', onDocumentMouseDown); if (window.shopilot) { window.shopilot.off(EVENT_CHANNELS.TASK_PROGRESS, onTaskProgress); void window.shopilot.browser.setViewsObscured(false) } if (noticeTimer) window.clearTimeout(noticeTimer); if (clockTimer) window.clearInterval(clockTimer) })
</script>

<style scoped>
/* ============================================================================
   统一工作台外壳 · 浅色统一风（2026-11 重构）
   设计令牌全部来自 styles/tokens.css；本文件只写"外壳自己的布局"。
   规则：不允许出现硬编码颜色（除透明遮罩），不允许新增圆角/阴影档位。
   ========================================================================== */

.dashboard-shell {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--ui-canvas);
  color: var(--ui-text);
  font-size: var(--text-13);
}
.dashboard-shell.workspace-hidden {
  position: absolute;
  inset: 0;
  z-index: 0;
  opacity: 0;
  pointer-events: none;
}

/* ---------------- 左栏 ---------------- */
.dashboard-sidebar {
  /* UI v3（2026-11-10）：深色左栏。只在本子树内重定义 ui-* 令牌，
     子元素原本就引用这些变量，因此无需逐条改色；内容区保持浅色。 */
  --ui-surface: #0b1120;
  --ui-surface-subtle: #111a2e;
  --ui-surface-sunken: #172138;
  --ui-border: #1e293b;
  --ui-border-strong: #2a3750;
  --ui-text: #f1f5ff;
  --ui-text-secondary: #c3cce0;
  --ui-text-muted: #8a96b2;
  --ui-text-disabled: #5b6780;
  --brand-soft: rgba(124, 92, 245, 0.18);
  --brand-soft-hover: rgba(124, 92, 245, 0.28);
  --brand-text: #c4b5fd;
  --brand: #7c5cf5;
  --warning-text: #fbbf24;
  --danger-text: #fb7185;
  display: flex;
  width: var(--shell-sidebar-w);
  min-width: var(--shell-sidebar-w);
  flex-direction: column;
  border-right: 1px solid #1e293b;
  background: #0b1120;
  color: var(--ui-text-secondary);
  transition:
    width var(--dur-base) var(--ease),
    min-width var(--dur-base) var(--ease);
}
.dashboard-sidebar.collapsed {
  width: var(--shell-sidebar-collapsed-w);
  min-width: var(--shell-sidebar-collapsed-w);
}
.dashboard-sidebar ::-webkit-scrollbar { width: 8px; }
.dashboard-sidebar ::-webkit-scrollbar-thumb { border-radius: 8px; background: #243049; }
.dashboard-sidebar ::-webkit-scrollbar-track { background: transparent; }

/* 品牌区 */
.sb-brand {
  display: flex;
  height: var(--shell-toolbar-h);
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid transparent;
}
.sb-mark {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: var(--r-sm);
  object-fit: contain;
}
.sb-brand-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 0;
  line-height: 1.25;
}
.sb-brand-copy strong {
  color: var(--ui-text);
  font-size: var(--text-14);
  font-weight: var(--weight-semibold);
  letter-spacing: -0.01em;
}
.sb-brand-copy span {
  color: var(--ui-text-muted);
  font-size: 10.5px;
  white-space: nowrap;
}
.sb-collapse {
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease);
}
.dashboard-sidebar:hover .sb-collapse,
.sb-collapse:focus-visible {
  opacity: 1;
}

/* 导航 */
.sb-nav {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 1px;
  padding: var(--sp-1) 8px var(--sp-2);
  overflow-y: auto;
}
.sb-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.sb-group-title {
  padding: 12px 8px 4px;
  color: var(--ui-text-muted);
  font-size: 10.5px;
  font-weight: var(--weight-semibold);
  letter-spacing: 0.06em;
}
.sb-item {
  display: flex;
  width: 100%;
  height: 34px;
  align-items: center;
  gap: 9px;
  padding: 0 9px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ui-text-secondary);
  font-size: var(--text-13);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.sb-item .ui-icon {
  color: var(--ui-text-muted);
  transition: color var(--dur-fast) var(--ease);
}
.sb-item:hover {
  background: var(--ui-surface-sunken);
  color: var(--ui-text);
}
.sb-item:hover .ui-icon {
  color: var(--ui-text-secondary);
}
.sb-item.active {
  background: var(--brand);
  color: #fff;
  font-weight: var(--weight-semibold);
  box-shadow: 0 6px 18px -8px rgba(124, 92, 245, 0.8);
}
.sb-item.active .ui-icon {
  color: #fff;
}
.sb-item-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 店铺区 */
.sb-stores {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  padding: 6px 8px 8px;
  border-top: 1px solid var(--ui-border);
}
.sb-stores-head {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 2px 0 6px;
}
.sb-stores-title {
  color: var(--ui-text-muted);
  font-size: var(--text-11);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.04em;
}
.sb-add {
  width: 24px;
  height: 24px;
  margin-left: auto;
  border-radius: var(--r-xs);
}
.sb-search {
  display: flex;
  height: 28px;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border-radius: var(--r-xs);
  background: var(--ui-surface-sunken);
  color: var(--ui-text-muted);
}
.sb-search input {
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--ui-text);
  font-size: var(--text-12);
  outline: none;
}
.sb-search input::placeholder {
  color: var(--ui-text-disabled);
}
.sb-store-list {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  overflow-y: auto;
}
.sb-store {
  display: flex;
  width: 100%;
  height: 34px;
  align-items: center;
  gap: 8px;
  padding: 0 6px 0 8px;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--ui-text-secondary);
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.sb-store:hover {
  background: var(--ui-surface-sunken);
}
.sb-store.displayed {
  background: var(--brand-soft);
}
.sb-store.displayed .sb-store-name {
  color: var(--brand-text);
  font-weight: var(--weight-semibold);
}
.sb-store-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--ui-text);
  font-size: var(--text-12);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-store-warn {
  flex: 0 0 auto;
  font-size: 10.5px;
  font-weight: var(--weight-medium);
  white-space: nowrap;
}
.sb-store-warn.warning {
  color: var(--warning-text);
}
.sb-store-warn.offline {
  color: var(--danger-text);
}
.sb-store-opening {
  flex: 0 0 auto;
  color: var(--brand-text);
  font-size: 10.5px;
  font-weight: var(--weight-medium);
  white-space: nowrap;
}
.sb-store .ui-dot {
  margin-left: 1px;
}
.store-action {
  display: inline-flex;
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-xs);
  color: var(--ui-text-disabled);
  opacity: 0;
  transition:
    opacity var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.sb-store:hover .store-action,
.sb-store.displayed .store-action,
.store-action:focus-visible {
  opacity: 1;
}
.store-action:hover {
  background: var(--brand-soft);
  color: var(--brand);
}

/* 客服未读红点：固定 16px 高，绝不参与行高计算（契约见 customer-message-alert.test.ts）。
   侧栏店铺行与顶部「电商客服」页签共用同一套尺寸，避免两处红点一高一矮。 */
.unread-badge {
  display: inline-flex;
  height: 16px;
  min-width: 16px;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
  font-size: 10.5px;
  line-height: 1;
}
.store-unread-badge {
  margin-left: 2px;
  flex: 0 0 auto;
}
.sb-hint {
  padding: 10px 8px;
  color: var(--ui-text-muted);
  font-size: var(--text-12);
  line-height: var(--leading-snug);
}
.sb-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 18px 10px;
  color: var(--ui-text-muted);
  font-size: var(--text-12);
  text-align: center;
}
.sb-empty-icon {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border-radius: var(--r-md);
  background: var(--ui-surface-sunken);
  color: var(--ui-text-disabled);
}
.sb-link {
  border: 0;
  background: none;
  color: var(--brand-text);
  font-size: var(--text-11);
  cursor: pointer;
}
.sb-link:hover {
  text-decoration: underline;
}

/* 左栏底部 */
.sb-foot {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 8px;
  border-top: 1px solid var(--ui-border);
}
.sb-settings {
  flex: 1;
}
.sb-trash {
  position: relative;
  flex: 0 0 auto;
}
.sb-trash-count {
  position: absolute;
  top: -1px;
  right: -1px;
  min-width: 14px;
  height: 14px;
  padding: 0 4px;
  border: 1.5px solid var(--ui-surface);
  border-radius: var(--r-full);
  background: var(--danger);
  color: #fff;
  font-size: 9.5px;
  font-weight: var(--weight-semibold);
  line-height: 11px;
  text-align: center;
}

/* 收起态轨道 */
.sb-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 0;
  overflow-y: auto;
  -webkit-app-region: drag;
}
.sb-rail .ui-icon-btn {
  -webkit-app-region: no-drag;
}
.sb-rail-sep {
  width: 20px;
  height: 1px;
  margin: 6px 0;
  flex: 0 0 auto;
  background: var(--ui-border);
}
.sb-rail-btn {
  width: 36px;
  height: 34px;
  border-radius: var(--r-sm);
}
.sb-rail-btn.on {
  background: var(--brand);
  color: #fff;
  box-shadow: 0 6px 16px -8px rgba(124, 92, 245, 0.9);
}
.dashboard-sidebar .sb-rail-btn {
  color: var(--ui-text-secondary);
}
.dashboard-sidebar .sb-rail-btn:hover {
  background: var(--ui-surface-sunken);
  color: var(--ui-text);
}
.dashboard-sidebar .sb-rail-btn.on {
  background: var(--brand);
  color: #fff;
}
.rail-badge {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--danger);
}

/* ---------------- 主区 ---------------- */
.dashboard-main {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  background: var(--ui-canvas);
}
.dashboard-browser-host {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
}
/* 非当前页：脱离布局流并隐藏视觉/命中，但保留真实尺寸 —— guest 自认可见才会继续渲染，
   渲染层重进浏览器页时也就不需要重建页面（重建 = 丢状态 + 重新登录流程）。 */
.dashboard-browser-host:not(.active) {
  position: absolute;
  inset: 0;
  z-index: 0;
  opacity: 0;
  pointer-events: none;
  transform: translate3d(-200vw, 0, 0);
  will-change: transform;
}
.dashboard-browser-host > :deep(.dashboard-browser-surface) {
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
}

/* ---------------- 顶栏 ----------------
   与右上角原生窗口按钮（WCO，高 38px）共存：
   · 右侧留出 148px：原生按钮画在页面之上，不留白会压住内容；
   · 底色固定 #ffffff，与 App.vue 的 TOOLBAR_BG 保持同一色值（overlay 是不透明覆盖层）。 */
.dashboard-toolbar {
  position: relative;
  z-index: var(--z-sticky);
  display: flex;
  height: var(--shell-toolbar-h);
  flex: 0 0 var(--shell-toolbar-h);
  align-items: center;
  gap: var(--sp-3);
  padding: 0 148px 0 18px;
  border-bottom: 1px solid var(--ui-border);
  background: #ffffff;
  -webkit-app-region: drag;
}
.dashboard-toolbar button,
.dashboard-toolbar input,
.dashboard-toolbar select {
  -webkit-app-region: no-drag;
}
.appbar-crumb {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
  color: var(--ui-text-muted);
  font-size: var(--text-12);
  white-space: nowrap;
}
.appbar-crumb strong {
  color: var(--ui-text);
  font-size: var(--text-13);
  font-weight: var(--weight-semibold);
}

/* 工作区切换：居中，像"同一窗口里的两块屏" */
.workspace-switch {
  position: absolute;
  top: 50%;
  left: 50%;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-sm);
  background: var(--ui-surface-sunken);
  transform: translate(-50%, -50%);
}
.workspace-switch > button {
  display: inline-flex;
  height: 26px;
  align-items: center;
  gap: 5px;
  padding: 0 11px;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--ui-text-muted);
  font-size: var(--text-12);
  font-weight: var(--weight-medium);
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}
.workspace-switch > button:hover {
  color: var(--ui-text);
}
.workspace-switch > button.on {
  background: var(--ui-surface);
  color: var(--ui-text);
  box-shadow: var(--e1);
}

.appbar-actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.appbar-search {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 9px;
  border: 1px solid var(--ui-border);
  border-radius: var(--r-sm);
  background: var(--ui-surface);
  color: var(--ui-text-muted);
  font-size: var(--text-12);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}
.appbar-search:hover {
  border-color: var(--ui-border-strong);
  background: var(--ui-surface-subtle);
}
.appbar-search .ui-kbd {
  margin-left: 8px;
}
.appbar-clock {
  padding: 0 4px;
  color: var(--ui-text-muted);
  font-size: var(--text-12);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.appbar-avatar {
  display: inline-grid;
  width: 28px;
  height: 28px;
  place-items: center;
  margin-left: 2px;
  border-radius: 50%;
  background: var(--brand);
  color: #fff;
  font-size: 10.5px;
  font-weight: var(--weight-bold);
  letter-spacing: 0.02em;
}

/* 通知中心 */
.notification-anchor {
  position: relative;
  display: inline-flex;
}
.notification-dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 6px;
  height: 6px;
  border: 1.5px solid #fff;
  border-radius: 50%;
  background: var(--danger);
}
.notification-center {
  top: 36px;
  right: 0;
  display: flex;
  width: 322px;
  max-height: 380px;
  flex-direction: column;
  gap: 1px;
  overflow-y: auto;
  padding: 6px;
  box-shadow: var(--e3);
}
.notification-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 8px;
  border-bottom: 1px solid var(--ui-border);
  color: var(--ui-text-muted);
  font-size: var(--text-11);
}
.notification-head strong {
  color: var(--ui-text);
  font-size: var(--text-12);
}
.notification-item {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.notification-item:hover {
  background: var(--ui-surface-sunken);
}
.notification-item strong {
  color: var(--ui-text);
  font-size: var(--text-12);
  font-weight: var(--weight-semibold);
}
.notification-item span {
  color: var(--ui-text-muted);
  font-size: var(--text-11);
  line-height: var(--leading-snug);
}
.notification-item.tone-error strong {
  color: var(--danger-text);
}
.notification-item.tone-warning strong {
  color: var(--warning-text);
}
.notification-empty {
  padding: 16px 10px;
  color: var(--ui-text-muted);
  font-size: var(--text-11);
  line-height: var(--leading-normal);
}

/* ---------------- 弹层补充 ---------------- */
.dashboard-context-menu {
  position: fixed;
  min-width: 208px;
  padding: 4px;
}
.dialog-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding-top: 2px;
}
.pick-list {
  display: flex;
  max-height: 240px;
  flex-direction: column;
  gap: 1px;
  overflow-y: auto;
  padding: 2px;
  border: 1px solid var(--ui-border);
  border-radius: var(--r-sm);
}
.pick-row {
  display: flex;
  height: 32px;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  border-radius: var(--r-xs);
  color: var(--ui-text-secondary);
  font-size: var(--text-12);
  cursor: pointer;
}
.pick-row:hover {
  background: var(--ui-surface-sunken);
}
.pick-row input {
  accent-color: var(--brand);
}
.trash-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 8px;
  border-radius: var(--r-sm);
}
.trash-row:hover {
  background: var(--ui-surface-subtle);
}
.trash-meta {
  min-width: 0;
  flex: 1;
  color: var(--ui-text);
  font-size: var(--text-13);
}

/* 顶栏临时提示（不阻断操作的事实说明） */
.appbar-notice {
  position: fixed;
  bottom: 24px;
  left: 50%;
  z-index: var(--z-toast);
  display: inline-flex;
  max-width: 460px;
  align-items: center;
  gap: 7px;
  padding: 8px 14px;
  border: 1px solid var(--ui-border);
  border-radius: var(--r-full);
  background: var(--ui-surface);
  box-shadow: var(--e2);
  color: var(--ui-text-secondary);
  font-size: var(--text-12);
  transform: translateX(-50%);
  animation: ui-slide-up var(--dur-base) var(--ease);
}

/* 命令面板 */
.command-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  justify-content: center;
  padding-top: 12vh;
  background: rgba(16, 24, 40, 0.32);
  backdrop-filter: blur(3px);
  animation: ui-fade-in var(--dur-fast) var(--ease);
}
.command-palette {
  display: flex;
  width: min(560px, calc(100vw - 48px));
  max-height: 440px;
  flex-direction: column;
  align-self: flex-start;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: var(--r-lg);
  background: var(--ui-surface);
  box-shadow: var(--e3);
  animation: ui-pop-in var(--dur-base) var(--ease);
}
.command-search {
  display: flex;
  height: 46px;
  flex: 0 0 46px;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border-bottom: 1px solid var(--ui-border);
  color: var(--ui-text-muted);
}
.command-search input {
  min-width: 0;
  flex: 1;
  border: 0;
  background: transparent;
  color: var(--ui-text);
  font-size: var(--text-14);
  outline: none;
}
.command-search input::placeholder {
  color: var(--ui-text-disabled);
}
.command-results {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 1px;
  overflow-y: auto;
  padding: 6px;
}
.command-result {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ui-text-muted);
  text-align: left;
  cursor: pointer;
}
.command-result:hover,
.command-result:focus-visible {
  background: var(--ui-surface-sunken);
}
.command-result-icon {
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  place-items: center;
  border-radius: var(--r-xs);
  background: var(--ui-surface-sunken);
  color: var(--ui-text-secondary);
}
.command-result-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 1px;
}
.command-result-copy strong {
  color: var(--ui-text);
  font-size: var(--text-13);
  font-weight: var(--weight-medium);
}
.command-result-copy small {
  overflow: hidden;
  color: var(--ui-text-muted);
  font-size: var(--text-11);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.command-empty {
  padding: 26px 16px;
  color: var(--ui-text-muted);
  font-size: var(--text-12);
  text-align: center;
}

/* ---------- 窄屏 ---------- */
@media (max-width: 1360px) {
  .appbar-clock {
    display: none;
  }
}
@media (max-width: 1180px) {
  .dashboard-sidebar {
    width: 220px;
    min-width: 220px;
  }
  .appbar-search span,
  .appbar-search .ui-kbd {
    display: none;
  }
  .appbar-search {
    width: 30px;
    justify-content: center;
    padding: 0;
  }
}
@media (max-width: 980px) {
  .dashboard-sidebar {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: var(--z-overlay);
    width: 248px;
    min-width: 248px;
    box-shadow: var(--e3);
    transform: translateX(-100%);
    transition: transform var(--dur-base) var(--ease);
  }
  .dashboard-sidebar.mobile-open {
    transform: none;
  }
  .mobile-sidebar-backdrop {
    position: absolute;
    inset: 0;
    z-index: calc(var(--z-overlay) - 1);
    border: 0;
    background: rgba(16, 24, 40, 0.32);
  }
  .dashboard-toolbar {
    padding-left: 12px;
  }
  .workspace-switch {
    position: static;
    transform: none;
    margin-left: auto;
  }
  .appbar-actions {
    margin-left: 0;
  }
}
@media (min-width: 981px) {
  .mobile-nav-toggle,
  .mobile-sidebar-backdrop {
    display: none;
  }
}
@media (max-width: 760px) {
  /* 这里不能再动 padding-right：原生窗口按钮（WCO）在窄窗口里照样画在右上角，
     收掉留白就会重新压住顶栏右侧的操作（titlebar-toolbar-boundary 测试钉住这一点）。 */
  .appbar-crumb {
    display: none;
  }
}

/* 窄屏汉堡按钮 */
.mobile-nav-toggle {
  display: inline-flex;
  width: 30px;
  height: 30px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  cursor: pointer;
}
.mobile-nav-toggle span {
  display: block;
  width: 15px;
  height: 1.6px;
  border-radius: 2px;
  background: var(--ui-text-secondary);
}
.mobile-nav-toggle:hover {
  background: var(--ui-surface-sunken);
}
</style>
