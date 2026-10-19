<template>
  <section :class="['dashboard-shell welcome', { 'image-studio-shell': activePage === 'image-studio', 'workspace-hidden': !props.active, 'mobile-nav-open': mobileNavOpen }]" data-test="dashboard-home">
    <aside class="dashboard-sidebar sidebar" :class="{ collapsed: leftSidebarCollapsed, 'mobile-open': mobileNavOpen }" data-test="sidebar" aria-label="ShopPilot 主导航">
      <div v-if="leftSidebarCollapsed && !mobileNavOpen" class="sidebar-rail">
        <button type="button" class="rail-btn" data-test="sidebar-expand" title="展开左侧栏（Ctrl+Shift+E）" @click="setLeftSidebarOpen(true)"><img :src="forwardIcon" alt="" /></button>
        <button type="button" class="rail-btn btn-new" data-test="rail-new" title="添加店铺" @click="openStoreCreate"><img :src="addIcon" alt="" /></button>
        <button type="button" class="rail-btn" data-test="rail-trash" title="回收站" @click="openTrash">
          <img :src="utilityTrashIcon" alt="" />
          <span v-if="ws.trashStores.length" class="rail-badge" data-test="rail-trash-badge"></span>
        </button>
        <button type="button" class="rail-btn" data-test="rail-settings" title="设置中心" @click="navigateTo('settings')"><img :src="settingsIcon" alt="" /></button>
      </div>
      <template v-else>
      <div class="dashboard-brand">
<div class="dashboard-brand-mark" aria-hidden="true"><img :src="brandMark" alt="" /></div>
        <div class="dashboard-brand-copy">
          <strong>ShopPilot</strong>
          <span>多平台经营工作台</span>
        </div>
        <button type="button" class="sidebar-collapse" data-test="sidebar-collapse" title="收起左侧栏（Ctrl+Shift+E）" @click="setLeftSidebarOpen(false)"><img :src="backIcon" alt="" /></button>
      </div>

      <nav class="dashboard-nav" aria-label="主功能导航">
        <template v-for="group in navGroups" :key="group.key">
          <div v-if="group.title" class="nav-group-title">{{ group.title }}</div>
          <button
            v-for="item in group.items"
            :key="item.label"
            type="button"
            :class="['dashboard-nav-item', { active: activeNav === item.label }]"
            :data-test="`nav-${item.key}`"
            :aria-current="activeNav === item.label ? 'page' : undefined"
            @click="handleNav(item)"
          >
            <span class="nav-glyph" aria-hidden="true"><img v-if="item.icon" :src="item.icon" alt="" /> <span v-else>{{ item.glyph }}</span></span>
            <span class="nav-label">{{ item.label }}</span>
          </button>
        </template>
      </nav>

      <div class="dashboard-store-area">
        <div class="store-area-title">
          <span>我的店铺</span>
          <span class="store-count">{{ ws.stores.length }}</span>
          <button type="button" class="add-store-button btn-new" title="添加店铺" @click="openStoreCreate"><img :src="addIcon" alt="" /></button>
        </div>
        <div class="store-area-body">
          <div v-if="!ws.ready" class="sidebar-state">正在读取店铺…</div>
          <div v-else-if="!ws.stores.length" class="sidebar-state">
            <img class="sidebar-state-art" :src="emptyStoreArt" alt="暂无店铺" />
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
              <!-- 客服未读红点（2026-10-16「实时检测店铺消息」）：哪家有新消息一眼看到 -->
              <span
                v-if="(ws.customerUnread[store.id] || 0) > 0"
                class="unread-badge store-unread-badge"
                data-test="store-unread"
                :title="`客服未读 ${ws.customerUnread[store.id]} 条`"
              >{{ ws.customerUnread[store.id] > 99 ? '99+' : ws.customerUnread[store.id] }}</span>
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
              ><img :src="openIcon" alt="" /></span>
            </button>
          </div>
        </div>
      </div>

      <div class="dashboard-sidebar-footer">
        <button type="button" class="pro-card" @click="navigateTo('settings')">
          <span class="pro-avatar" aria-hidden="true">SP</span>
          <span class="pro-copy"><strong>ShopPilot Pro</strong><span class="pro-badge">专业版</span></span>
          <span class="pro-arrow" aria-hidden="true"><img :src="forwardIcon" alt="" /></span>
        </button>
        <div class="foot-row">
          <button
            type="button"
            :class="['dashboard-nav-item', 'foot-btn', 'foot-settings', { active: activeNav === '设置中心' }]"
            data-test="settings-open-btn"
            @click="handleNav(settingsNav)"
          >
            <span class="nav-glyph" aria-hidden="true"><img :src="settingsNav.icon" alt="" /></span>
            <span class="nav-label">设置</span>
          </button>
          <button type="button" class="foot-btn foot-icon" data-test="trash-open" title="回收站" aria-label="回收站" @click="openTrash">
            <img :src="utilityTrashIcon" alt="" /><span v-if="ws.trashStores.length" class="badge">{{ ws.trashStores.length }}</span>
          </button>
        </div>
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
        <div class="toolbar-crumb" aria-label="当前位置">
          <span class="crumb-root">工作台</span>
          <span class="crumb-sep" aria-hidden="true">/</span>
          <span class="crumb-current">{{ pageTitle }}</span>
        </div>
        <div class="workspace-switcher" role="tablist" aria-label="工作区切换">
          <button
            type="button"
            class="workspace-tab active"
            data-test="workspace-tab-workbench"
            role="tab"
            aria-selected="true"
            tabindex="0"
            title="当前工作台"
            @pointerdown.stop
            @mousedown.stop
            @click.stop
          >
            <span>工作台</span>
          </button>
          <button
            type="button"
            class="workspace-tab"
            data-test="workspace-tab-customer-service"
            role="tab"
            aria-selected="false"
            tabindex="0"
            title="打开电商客服工作区（登录与工作台同步）"
            @pointerdown.stop
            @mousedown.stop
            @click.stop="emit('open-customer-service')"
          >
            <span class="workspace-product-spark" aria-hidden="true">✦</span>
            <span>电商客服</span>
            <!-- 客服入口红点：所有店铺未读之和（实时检测事件驱动，不轮询界面） -->
            <span v-if="customerUnreadTotal > 0" class="unread-badge" data-test="customer-service-unread" :title="`客服未读 ${customerUnreadTotal} 条`">{{ customerUnreadTotal > 99 ? '99+' : customerUnreadTotal }}</span>
          </button>
        </div>
        <div class="toolbar-actions">
          <button type="button" class="toolbar-datetime" title="时间取自本机系统时钟" @click="showNotice('时间取自本机系统时钟；采集周期与调用记录都以它为准')">
            <img class="dt-icon" :src="dateIcon" alt="" />{{ nowLabel }}<img class="dt-caret" :src="caretDownIcon" alt="" />
          </button>
          <div class="notification-anchor">
            <button type="button" class="toolbar-icon-button" data-test="notification-bell" :aria-expanded="notificationOpen" title="通知" @click="notificationOpen = !notificationOpen">
              <img class="toolbar-action-icon" :src="notificationIcon" alt="" />
              <i v-if="notificationCount" class="notification-dot" :aria-label="`有 ${notificationCount} 条通知`"></i>
            </button>
            <div v-if="notificationOpen" class="notification-center" data-test="notification-center" role="dialog" aria-label="通知中心">
              <header><strong>通知</strong><span>{{ notificationCount }} 条</span></header>
              <div v-if="!notifications.length" class="notification-empty" data-test="notification-empty">暂无通知：达人邀约状态与客服未读会出现在这里。</div>
              <button v-for="item in notifications" :key="item.id" type="button" class="notification-item" :class="'tone-' + item.tone" :data-test="'notification-item-' + item.id" @click="runNotification(item)">
                <strong>{{ item.title }}</strong><span>{{ item.detail }}</span>
              </button>
            </div>
          </div>
          <button type="button" class="toolbar-icon-button" title="帮助（Ctrl+K 打开命令面板）" @click="showNotice('按 Ctrl+K 打开命令面板；店铺与设置入口在左栏与各页面内')"><img :src="helpIcon" alt="" /></button>
          <span class="toolbar-avatar" aria-hidden="true" title="ShopPilot Pro">SP</span>
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
      <UnifiedImageStudioPage v-else-if="activePage === 'image-studio'" @go-home="navigateTo('overview')" @busy-change="imageStudioBusy = $event" />
      <ProductManagementPage v-else-if="activePage === 'products'" @navigate="navigateTo" @open-store="openStoreFromPage" />
      <CreatorInvitePage v-else-if="activePage === 'creator-invite'" @open-config="openCreatorInvite" @open-store="openStoreFromPage" @navigate="handleInviteNavigate" />
      <UnifiedAppsPage v-else-if="activePage === 'ai' || activePage === 'apps'" :mode="activePage" @navigate="navigateTo" @open-assistant="openAssistant" @open-invite="openCreatorInvite" />
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

    <div v-if="storeContext.open && storeContext.store" class="dashboard-context-menu" data-test="store-ctx" :style="{ left: `${storeContext.x}px`, top: `${storeContext.y}px` }" @click.stop>
      <button type="button" class="ctx-item" data-test="ctx-toggle" @click="storeContextAction('toggle')"><img :src="ws.openStoreIds.includes(storeContext.store.id) ? dashboardTrashIcon : dashboardBrowserIcon" alt="" />{{ ws.openStoreIds.includes(storeContext.store.id) ? '关闭浏览器' : '打开浏览器' }}</button>
      <button type="button" class="ctx-item" data-test="ctx-standalone" :disabled="!canOpenStandalone" @click="storeContextAction('standalone')"><img :src="dashboardExternalIcon" alt="" />在独立窗口打开当前标签页</button>
      <div class="ctx-sep"></div>
      <button type="button" class="ctx-item" data-test="ctx-rename" @click="storeContextAction('rename')"><img :src="dashboardRenameIcon" alt="" />重命名…</button>
      <button type="button" class="ctx-item" data-test="ctx-readname" @click="storeContextAction('readname')"><img :src="dashboardRenameIcon" alt="" />读取并更新店铺名（从页面）</button>
      <button type="button" class="ctx-item" data-test="ctx-copycfg" :disabled="otherStoreOptions.length === 0" @click="storeContextAction('copycfg')"><img :src="dashboardCopyIcon" alt="" />复制环境配置到其他店铺…</button>
      <button type="button" class="ctx-item" data-test="ctx-copyid" @click="storeContextAction('copyid')"><img :src="dashboardCopyIcon" alt="" />复制店铺 ID</button>
      <div class="ctx-sep"></div>
      <button type="button" class="ctx-item danger" data-test="ctx-trash" @click="storeContextAction('trash')"><img :src="dashboardTrashIcon" alt="" />移入回收站</button>
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

    <div v-if="confirmDialog.open" class="dashboard-overlay" data-test="confirm-dialog" @click.self="dismissConfirmDialog">
      <section class="dashboard-dialog" role="dialog" aria-modal="true" aria-label="确认操作">
        <h2>{{ confirmDialog.title }}</h2><p class="dashboard-dialog-note">{{ confirmDialog.message }}</p>
        <div class="dashboard-dialog-actions"><button type="button" class="unified-button" @click="dismissConfirmDialog">取消</button><button type="button" class="unified-button danger" data-test="confirm-ok" @click="runConfirmDialog">确认</button></div>
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
          <button type="button" class="btn-ghost sm" @click="ws.restoreStore(trashStore.id)"><img class="inline-action-icon" :src="dashboardRestoreIcon" alt="" />恢复</button>
          <button type="button" class="btn-danger sm" @click="confirmPurge(trashStore)"><img class="inline-action-icon" :src="dashboardPurgeIcon" alt="" />彻底删除</button>
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
        <div class="command-search"><img class="command-search-icon" :src="observeIcon" alt="" /><input ref="commandInput" v-model="globalQuery" autofocus placeholder="搜索功能、店铺或达人邀约…" @keydown.esc="commandOpen = false" /></div>
        <div v-if="commandResults.length" class="command-results"><button v-for="result in commandResults" :key="result.key" type="button" @click="runCommand(result)"><span class="command-result-icon"><img :src="result.icon" alt="" /></span><span><strong>{{ result.label }}</strong><small>{{ result.description }}</small></span><kbd>↵</kbd></button></div>
        <div v-else class="command-empty">没有匹配的功能或店铺</div>
      </section>
    </div>

    <AgentDock
      v-if="hasNativeBridge"
      :locked="ws.appLocked"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import PlatformIcon from '../../components/PlatformIcon.vue'
import AgentDock from '../agent/AgentDock.vue'
import DashboardBrowserSurface from './DashboardBrowserSurface.vue'
// 首屏按需加载：这些页面级重资产（图片工作台的图片资源、数据中心/设置/商品/邀约）只在用户真正
// 切到对应页签时才拉取对应 chunk，首屏 JS 不再把它们打进来。组件名与 props/emits 用法不变。
const UnifiedStorePage = defineAsyncComponent(() => import('./UnifiedStorePage.vue'))
const UnifiedDataPage = defineAsyncComponent(() => import('./UnifiedDataPage.vue'))
const UnifiedSettingsPage = defineAsyncComponent(() => import('./UnifiedSettingsPage.vue'))
const UnifiedImageStudioPage = defineAsyncComponent(() => import('./UnifiedImageStudioPage.vue'))
const ProductManagementPage = defineAsyncComponent(() => import('../products/ProductManagementPage.vue'))
const CreatorInvitePage = defineAsyncComponent(() => import('../invite/CreatorInvitePage.vue'))
const UnifiedAppsPage = defineAsyncComponent(() => import('./UnifiedAppsPage.vue'))
import DashboardOverviewPage from './components/DashboardOverviewPage.vue'
import { waitForWorkspaceReady } from './use-dashboard-overview'
import { buildWorkbenchNotifications, type WorkbenchNotificationItem } from './notification-center'
import { useAgentStore } from '../../stores/agent'
import { useWorkspaceStore, type StoreRow } from '../../stores/workspace'
import homeIcon from '../../assets/icons/nav-home.svg'
import productsIcon from '../../assets/icons/nav-products.svg'
import storeIcon from '../../assets/icons/nav-store.svg'
import aiIcon from '../../assets/icons/nav-ai.svg'
import analyticsIcon from '../../assets/icons/nav-analytics.svg'
import invoicesIcon from '../../assets/icons/app-invoices.svg'
import taxIcon from '../../assets/icons/app-tax.svg'
import appsIcon from '../../assets/icons/nav-apps.svg'
import settingsIcon from '../../assets/icons/nav-settings.svg'
import utilityTrashIcon from '../../assets/icons/utility-trash.svg'
import notificationIcon from '../../assets/icons/utility-notifications.svg'
import brandMark from '../../assets/generated/shopilot-logo-generated.png'
import dateIcon from '../../assets/generated/ui-icons/date.png'
import helpIcon from '../../assets/generated/ui-icons/help.png'
import addIcon from '../../assets/generated/ui-icons/add.png'
import openIcon from '../../assets/generated/ui-icons/open.png'
import observeIcon from '../../assets/generated/ui-icons/observe.png'
import forwardIcon from '../../assets/generated/ui-icons/forward-gen.png'
import backIcon from '../../assets/generated/ui-icons/back-gen.png'
import caretDownIcon from '../../assets/generated/ui-icons/caret-down-gen.png'
import dashboardBrowserIcon from '../../assets/generated/ui-icons/dashboard-browser-window-gen.png'
import dashboardExternalIcon from '../../assets/generated/ui-icons/dashboard-external-window-gen.png'
import dashboardRenameIcon from '../../assets/generated/ui-icons/dashboard-rename-gen.png'
import dashboardCopyIcon from '../../assets/generated/ui-icons/dashboard-copy-gen.png'
import dashboardTrashIcon from '../../assets/generated/ui-icons/dashboard-trash-gen.png'
import dashboardRestoreIcon from '../../assets/generated/ui-icons/dashboard-restore-gen.png'
import dashboardPurgeIcon from '../../assets/generated/ui-icons/dashboard-purge-gen.png'
import emptyStoreArt from '../../assets/ui/dashboard/empty-store.png'
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
const navItems = [
  { key: 'overview', label: '经营总览', glyph: '⌂', icon: homeIcon },
  { key: 'products', label: '商品管理', glyph: '◈', icon: productsIcon },
  { key: 'stores', label: '店铺管理', glyph: '▣', icon: storeIcon },
  { key: 'ai', label: 'AI 创作', glyph: '✦', icon: aiIcon },
  { key: 'analytics', label: '数据分析', glyph: '◫', icon: analyticsIcon },
  { key: 'invoices', label: '发票中心', glyph: '▤', icon: invoicesIcon },
  { key: 'tax', label: '涉税信息', glyph: '税', icon: taxIcon },
  { key: 'apps', label: '应用中心', glyph: '⊞', icon: appsIcon }
]
const activeNav = ref('经营总览')
/** 侧栏导航分组（主功能区三项 + 「智能运营」四项；设置单独落在左下角） */
const navGroups = computed(() => [
  { key: 'main', title: '', items: navItems.filter(item => ['经营总览', '商品管理', '店铺管理'].includes(item.label)) },
  { key: 'smart', title: '智能运营', items: navItems.filter(item => ['AI 创作', '数据分析', '发票中心', '涉税信息', '应用中心'].includes(item.label)) }
])
/** 左下角「设置」入口（设计稿放在侧栏底部，不在主分组里；仍用 .dashboard-nav-item 语义保证高亮与跳转一致） */
const settingsNav = { label: '设置中心', glyph: '⚙', icon: settingsIcon }
/** 顶栏面包屑右侧的当前页名（与导航标签同源，不另造一套文案） */
const PAGE_TITLES: Record<string, string> = {
  overview: '经营总览', browser: '店铺工作台', products: '商品管理', stores: '店铺管理',
  ai: 'AI 创作', analytics: '数据分析', invoices: '发票中心', tax: '涉税信息', apps: '应用中心', settings: '设置中心',
  'image-studio': '图片工作台', 'creator-invite': '达人邀约'
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
  nowLabel.value = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
type DashboardPage = 'overview' | 'browser' | 'products' | 'stores' | 'ai' | 'analytics' | 'apps' | 'settings' | 'invoices' | 'tax' | 'image-studio' | 'creator-invite'
type SettingsTab = 'entry' | 'ai' | 'security' | 'extensions' | 'maintenance' | 'about'
const activePage = ref<DashboardPage>('overview')
/** 生图请求仍在运行时保留图片工作台，避免卸载页面丢失返回结果。 */
const imageStudioBusy = ref(false)
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
const notificationTasks = computed(() => (ws.tasks as any[])
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
function runNotification(item: WorkbenchNotificationItem) {
  notificationOpen.value = false
  if (item.target === 'customer-service') emit('open-customer-service')
  else navigateTo('creator-invite')
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
  invoiceTodoState.value = 'loading'
  try {
    const response = await window.shopilot.overview.invoiceCenter()
    if (!response.ok) { invoiceTodoRows.value = []; invoiceTodoState.value = 'error'; return }
    invoiceTodoRows.value = ((response.data as any)?.rows || [])
      .map((row: any) => ({ storeId: String(row.storeId || ''), storeName: String(row.storeName || '未命名店铺'), count: Number(row.count) || 0 }))
      .filter((row: { storeId: string; count: number }) => row.storeId && row.count > 0)
    invoiceTodoState.value = invoiceTodoRows.value.length ? 'ready' : 'empty'
  } catch {
    invoiceTodoRows.value = []
    invoiceTodoState.value = 'error'
  }
}
function showNotice(message: string) { notice.value = message; if (noticeTimer) window.clearTimeout(noticeTimer); noticeTimer = window.setTimeout(() => { notice.value = '' }, 3600) }
function handleNav(item: { label: string }) {
  const pageByLabel: Record<string, DashboardPage> = {
    '经营总览': 'overview', '商品管理': 'products', '店铺管理': 'stores',
    'AI 创作': 'ai', '数据分析': 'analytics', '发票中心': 'invoices', '涉税信息': 'tax', '应用中心': 'apps', '设置中心': 'settings'
  }
  mobileNavOpen.value = false
  navigateTo(pageByLabel[item.label] || 'overview')
}
function preventBusyImageStudioExit() {
  if (activePage.value !== 'image-studio' || !imageStudioBusy.value) return false
  activeNav.value = 'AI 创作'
  showNotice('图片仍在生成，完成后再离开，避免丢失结果。')
  return true
}
function navigateTo(page: DashboardPage) {
  if (page !== 'image-studio' && preventBusyImageStudioExit()) return
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
  else if (page === 'products') activeNav.value = '商品管理'
  else if (page === 'stores') activeNav.value = '店铺管理'
  else if (page === 'ai') activeNav.value = 'AI 创作'
  else if (page === 'analytics') activeNav.value = '数据分析'
  else if (page === 'invoices') activeNav.value = '发票中心'
  else if (page === 'tax') activeNav.value = '涉税信息'
  else if (page === 'apps' || page === 'creator-invite') activeNav.value = '应用中心'
  else if (page === 'image-studio') activeNav.value = 'AI 创作'
}
/** 达人邀约页内的返回/去店铺动作：页面只发语义，不在子组件里猜主路由。 */
function handleInviteNavigate(page: string) {
  if (page === 'apps' || page === 'stores') navigateTo(page)
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
  if (preventBusyImageStudioExit()) return
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
/**
 * 达人邀约模块页的「新建邀约」入口：配置与真实发送仍在店铺浏览器的实测面板里，
 * 必须带着具体店铺进去——否则面板只会显示"当前平台未接入"，用户会误判成功能不可用。
 * 取店优先级：页面选中的店 → 正在显示的店 → 已打开的店 → 第一家店；一家都没有就先去店铺管理。
 */
async function openCreatorInvite(storeIdHint?: string): Promise<void> {
  if (preventBusyImageStudioExit()) return
  const storeId = storeIdHint || ws.displayedStoreId || ws.openStoreIds[0] || ws.stores[0]?.id
  if (!storeId) {
    navigateTo('stores')
    return
  }
  await openStoreFromPage(storeId)
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
  try { await agent.initialize(); agent.setDrawerOpen(true) } catch { showNotice('AI 助手暂时不可用，请检查模型配置') }
}
function openCommandPalette() { commandOpen.value = true; nextTick(() => commandInput.value?.focus()) }
const commandResults = computed(() => {
  const query = globalQuery.value.trim().toLowerCase()
  const results = [
    { key: 'home', icon: homeIcon, label: '经营总览', description: '回到经营总览', action: () => navigateTo('overview') },
    { key: 'trend', icon: analyticsIcon, label: '销售趋势', description: '打开数据分析页面', action: () => navigateTo('analytics') },
    { key: 'settings', icon: settingsIcon, label: '设置中心', description: '打开统一设置页面', action: () => navigateTo('settings') },
    ...ws.stores.map(store => ({ key: `store-${store.id}`, icon: storeIcon, label: store.name, description: `${store.platform} · 打开店铺浏览器`, action: () => openStoreFromPage(store.id) }))
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
    if (preventBusyImageStudioExit()) {
      // 主进程的原生店铺视图覆盖在渲染层上；生成未结束时收起它，保留图片工作台。
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
  /* muted 灰原为 #98a2b3：在白底上只有 2.58:1、在浅灰卡底上 2.2:1，用户实报「字体颜色看不清」。
     2026-10-02 全应用巡检（641 个文字节点）后统一提到 AA 之上——这是浅色主题里用量最大的一个 token。 */
  --dash-text-muted: #5b6472;
  --dash-purple: #7c5cff;
  --dash-blue: #2e90fa;
  --dash-cyan: #06aed4;
  --dash-green: #12b76a;
  --dash-orange: #f79009;
  --dash-red: #f04438;
  /* 文字专用的深色变体：上面几个是**装饰色**（点/条/边框），当文字色用时对比度不够
     （红 3.76:1、紫 4.35:1、青 2.22:1），所以文字一律走这三个，装饰仍用原色。 */
  --dash-red-text: #d92d20;
  --dash-purple-text: #5b3df5;
  --dash-cyan-text: #0e7490;
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
.dashboard-shell.workspace-hidden { position: absolute; inset: 0; z-index: 0; opacity: 0; pointer-events: none; }
.image-studio-shell .dashboard-toolbar { display: none; }
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
.sidebar-collapse { display:grid;place-items:center;margin-left: auto; width: 24px; height: 24px; flex: 0 0 auto; border: 0; border-radius: 6px; background: transparent; color: var(--side-text-muted); cursor: pointer; line-height: 1; }.sidebar-collapse img { width:15px;height:15px;object-fit:contain; }
.sidebar-collapse:hover, .sidebar-collapse:focus-visible { background: var(--side-surface); color: #fff; outline: none; }
.sidebar-rail { display: flex; height: 100%; flex-direction: column; align-items: center; gap: 6px; padding: 14px 0 12px; -webkit-app-region: drag; }
.sidebar-rail .rail-btn { position: relative; display: inline-flex; width: 34px; height: 34px; align-items: center; justify-content: center; border: 0; border-radius: 9px; background: transparent; color: var(--side-text-soft); cursor: pointer; font-size: 16px; -webkit-app-region: no-drag; }
.sidebar-rail .rail-btn:hover, .sidebar-rail .rail-btn:focus-visible { background: var(--side-surface); color: #fff; outline: none; }.sidebar-rail .rail-btn img { width: 18px; height: 18px; object-fit: contain; }
.sidebar-rail .rail-btn:first-child { margin-bottom: 4px; font-size: 19px; }
.rail-badge { position: absolute; top: 5px; right: 4px; width: 7px; height: 7px; border: 1px solid var(--side-bg); border-radius: 50%; background: #fb5470; }
.dashboard-brand { height: 74px; display: flex; align-items: center; gap: 11px; padding: 16px 16px 10px; }
.dashboard-brand-mark {
  display: flex; width: 40px; height: 40px; align-items: center; justify-content: center; flex: 0 0 40px;
  border-radius: 12px; background: var(--brand-gradient); box-shadow: 0 8px 18px rgba(124, 92, 255, .42);
  color: #fff; font-size: 19px; font-weight: 800;
}
.dashboard-brand-mark img { width: 32px; height: 32px; object-fit: contain; }
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
.nav-glyph { display: inline-flex; width: 20px; height: 20px; flex: 0 0 20px; align-items: center; justify-content: center; color: currentColor; font-size: 16px; line-height: 1; text-align: center; opacity: .95; overflow: hidden; border-radius: 6px; }
.nav-glyph img { display: block; width: 20px; height: 20px; object-fit: contain; }
.nav-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dashboard-store-area { min-height: 0; flex: 1; display: flex; flex-direction: column; border-top: 1px solid var(--side-border); margin-top: 4px; padding: 12px 12px 0; }
.store-area-title { display: flex; align-items: center; gap: 7px; padding: 2px 4px 10px; color: #cfd7e6; font-size: 12px; font-weight: 600; }
.store-count { display: inline-flex; min-width: 18px; height: 18px; align-items: center; justify-content: center; padding: 0 5px; border-radius: 6px; background: var(--side-surface); color: var(--side-text-soft); font-size: 10.5px; font-weight: 600; }
.add-store-button { margin-left: auto; width: 24px; height: 24px; flex: 0 0 auto; border: 0; border-radius: 7px; background: rgba(124, 92, 255, .22); color: #c3b2ff; font-size: 16px; line-height: 1; cursor: pointer; }
.add-store-button:hover, .add-store-button:focus-visible { background: rgba(124, 92, 255, .34); color: #fff; outline: none; }
.store-area-body { min-height: 0; flex: 1; display: flex; flex-direction: column; }
.sidebar-state { display: flex; flex-direction: column; align-items: center; gap: 7px; padding: 16px 8px; color: var(--side-text-muted); font-size: 11.5px; text-align: center; }
.sidebar-state-art { display: block; width: 74px; height: 58px; object-fit: cover; border-radius: 10px; opacity: .9; }
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
/* 客服未读红点：侧栏客服入口与对应店铺行共用（不抢焦点、不改变行高） */
.unread-badge { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 5px; border-radius: 8px; background: #ff4d4f; color: #fff; font-size: 10.5px; line-height: 1; font-weight: 600; }
.store-unread-badge { margin-left: 4px; }
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
.pro-arrow img { width:14px;height:14px;object-fit:contain; }.pro-arrow { color: var(--side-text-muted); font-size: 16px; }
.foot-btn { display: flex; width: 100%; align-items: center; gap: 8px; height: 34px; padding: 0 10px; border: 0; border-radius: 9px; background: transparent; color: var(--side-text-soft); cursor: pointer; font-size: 12.5px; text-align: left; }
.foot-btn:hover, .foot-btn:focus-visible { background: var(--side-surface); color: #fff; outline: none; }
.foot-btn.foot-settings.active { background: rgba(124, 92, 255, .24); color: #cbbcff; }
.foot-btn .badge { min-width: 16px; margin-left: auto; padding: 1px 6px; border-radius: 10px; background: rgba(240, 68, 56, .24); color: #ffb4ae; text-align: center; font-size: 10px; }
.foot-row { display: flex; align-items: center; gap: 6px; }
.foot-row .foot-settings { flex: 1; min-width: 0; }
.foot-icon { position: relative; width: 36px; flex: 0 0 36px; justify-content: center; padding: 0; font-size: 13px; }
.foot-icon img { width: 17px; height: 17px; object-fit: contain; }.foot-icon .badge { position: absolute; top: 3px; right: 1px; min-width: 14px; margin: 0; padding: 0 4px; font-size: 9.5px; }
.storage-status.connected { color: #38d39f; }

/* ---------------- 主区域 + 顶栏 ---------------- */
.dashboard-main { position: relative; min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; overflow: hidden; background: var(--dash-bg); }
.dashboard-browser-host { min-width: 0; min-height: 0; flex: 1 1 auto; display: flex; }
/* 非当前页：脱离布局流并隐藏视觉/命中，但保留真实尺寸 —— guest 自认可见才会继续渲染，
   渲染层重进浏览器页时也就不需要重建页面（重建 = 丢状态 + 重新登录流程）。 */
.dashboard-browser-host:not(.active) {
  /* Electron 的 <webview> 是独立合成层；opacity/pointer-events 只影响 DOM 命中，
     在部分 Windows GPU 路径仍可能留下覆盖层。把宿主移出渲染区域可以可靠释放
     鼠标命中，同时不销毁 guest、标签页或 persist 分区，所以登录态和页面状态继续长活。 */
  position: absolute;
  inset: 0;
  z-index: 0;
  opacity: 0;
  pointer-events: none;
  transform: translate3d(-200vw, 0, 0);
  will-change: transform;
}
.dashboard-browser-host > :deep(.dashboard-browser-surface) { min-width: 0; min-height: 0; flex: 1 1 auto; }
/* 顶部栏与右上角原生窗口按钮（WCO，高 38px）共存：
   · 右侧留出 148px：原生按钮是画在页面之上的覆盖层，不留白就会压住头像；
   · 底色固定为 #ffffff，且与 App.vue 的 TOOLBAR_BG 保持同一色值（overlay 是不透明覆盖层）。 */
.dashboard-toolbar {
  position: relative; z-index: 10; display: flex; align-items: center; gap: 16px; height: 64px; flex: 0 0 64px;
  padding: 0 148px 0 22px; border-bottom: 1px solid var(--dash-border); background: #ffffff;
  -webkit-app-region: drag;
}
.toolbar-crumb { display: flex; align-items: center; gap: 8px; color: var(--dash-text-muted); font-size: 13px; }
/* 面包屑根节点原本继承 toolbar-crumb 的 muted 灰（#98a2b3 → 白底 2.58:1，实测看不清）。
   2026-10-02 用户实报"字体颜色看不清楚"后统一提到 AA 之上。 */
.crumb-root { color: var(--dash-text-soft); }
.crumb-current { color: var(--dash-text); font-weight: 600; }
/* 分隔符是纯装饰（aria-hidden），但太浅会在浅底上看不见；给到 AA 之上最省事 */
.crumb-sep { color: #64748b; }
.workspace-switcher {
  position: absolute;
  z-index: 11;
  top: 50%;
  left: 50%;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--dash-border);
  border-radius: 11px;
  background: #f7f8fc;
  box-shadow: 0 1px 3px rgba(16, 24, 40, .04);
  -webkit-app-region: no-drag;
  transform: translate(-50%, -50%);
}
.workspace-tab {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  gap: 7px;
  padding: 0 13px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dash-text-soft);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  transition: background .16s, color .16s, box-shadow .16s;
}
.workspace-tab:hover, .workspace-tab:focus-visible {
  background: #fff;
  color: var(--dash-text);
  box-shadow: 0 2px 8px rgba(16, 24, 40, .08);
}
.workspace-tab:focus-visible { outline: 2px solid rgba(124, 92, 255, .42); outline-offset: 1px; }
.workspace-tab.active { background: #fff; color: var(--dash-text); box-shadow: 0 2px 8px rgba(16, 24, 40, .08); }
.workspace-product-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dash-purple); box-shadow: 0 0 0 3px rgba(124, 92, 255, .14); }
.workspace-product-spark { color: var(--dash-purple); font-size: 14px; line-height: 1; }
.toolbar-actions { display: flex; min-width: 0; align-items: center; gap: 10px; margin-left: auto; -webkit-app-region: no-drag; }
.toolbar-datetime { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border: 1px solid var(--dash-border); border-radius: 11px; background: #fff; color: var(--dash-text-soft); font-size: 12.5px; }
.dt-icon { width: 18px; height: 18px; object-fit: contain; }
.dt-caret { width:13px;height:13px;margin-left: 2px;object-fit:contain; }
.toolbar-icon-button { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border: 0; border-radius: 10px; background: transparent; color: var(--dash-text-soft); font-size: 16px; cursor: pointer; }.toolbar-icon-button img { width: 20px; height: 20px; object-fit: contain; }
.toolbar-icon-button:hover, .toolbar-icon-button:focus-visible { background: #f2f4f8; color: var(--dash-text); outline: none; }
.notification-anchor { position: relative; display: inline-flex; }
.notification-center { position: absolute; top: 42px; right: 0; z-index: 80; display: flex; width: 320px; max-height: 380px; flex-direction: column; gap: 2px; overflow: auto; padding: 8px; border: 1px solid var(--dash-border); border-radius: 12px; background: #fff; box-shadow: 0 18px 40px rgba(16, 24, 40, .18); }
.notification-center header { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px 8px; color: var(--dash-text-muted); font-size: 11px; }
.notification-center header strong { color: var(--dash-text); font-size: 12px; }
.notification-item { display: flex; width: 100%; flex-direction: column; gap: 3px; padding: 9px 10px; border: 0; border-radius: 8px; background: transparent; text-align: left; cursor: pointer; }
.notification-item:hover, .notification-item:focus-visible { background: #f4f5f7; outline: none; }
.notification-item strong { color: var(--dash-text); font-size: 12px; font-weight: 600; }
.notification-item span { color: var(--dash-text-muted); font-size: 11px; line-height: 1.5; }
.notification-item.tone-error strong { color: #b42318; }
.notification-item.tone-warning strong { color: #b54708; }
.notification-empty { padding: 14px 10px; color: var(--dash-text-muted); font-size: 11px; line-height: 1.6; }
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
.dashboard-error .state-icon { display: inline-flex; width: 22px; height: 22px; object-fit: contain; }
.refresh-icon { width: 17px; height: 17px; object-fit: contain; }
.btn-new img { width: 18px; height: 18px; object-fit: contain; }.store-action img { width: 16px; height: 16px; object-fit: contain; }.command-search-icon { width: 20px; height: 20px; object-fit: contain; }
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
.delta-icon { width:13px;height:13px;vertical-align:-2px;object-fit:contain; }.kpi-delta { font-size: 11.5px; font-weight: 600; }
.kpi-delta.up { color: var(--dash-green); }
.kpi-delta.down { color: var(--dash-red-text); }
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
.dashboard-state-art { display: block; width: 86px; height: 64px; object-fit: cover; border-radius: 12px; opacity: .88; }
.analytics-state-art { width: 112px; height: 78px; }
.compact-state-art { width: 62px; height: 48px; }
.loader { width: 16px; height: 16px; border: 2px solid #e3e8f1; border-top-color: var(--dash-purple); border-radius: 50%; animation: dashboard-spin .8s linear infinite; }
@keyframes dashboard-spin { to { transform: rotate(360deg); } }
.error-state { color: var(--dash-red-text); }

.shortcut-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
/* 设计稿排版：图标在左、标题/副标题在右，按钮在文字下方（不是图标下方） */
.shortcut-tile { display: grid; grid-template-columns: 44px minmax(0, 1fr); grid-template-rows: auto auto; gap: 10px 12px; align-items: start; min-width: 0; padding: 14px; border: 1px solid transparent; border-radius: 16px; background: #f7f9fd; }
.shortcut-tile.tone-purple { background: #f6f3ff; border-color: #ece5ff; }
.shortcut-tile.tone-blue { background: #f2f7ff; border-color: #e3eeff; }
.shortcut-tile.tone-teal { background: #eefaf7; border-color: #dcf3ee; }
.shortcut-tile.tone-rose { background: #fff3f4; border-color: #ffe4e8; }
.shortcut-tile.disabled { opacity: .96; }
.tile-icon img { width: 23px; height: 23px; object-fit: contain; }.tile-icon { grid-row: 1; grid-column: 1; display: inline-flex; width: 44px; height: 44px; align-items: center; justify-content: center; border-radius: 13px; background: var(--brand-gradient); color: #fff; font-size: 19px; }
.shortcut-tile.tone-blue .tile-icon { background: linear-gradient(135deg, #3f9bff, #1f6fea); }
.shortcut-tile.tone-teal .tile-icon { background: linear-gradient(135deg, #21c8a8, #0e9f8c); }
.shortcut-tile.tone-rose .tile-icon { background: linear-gradient(135deg, #ff8a8a, #ef4a5f); }
.tile-copy { grid-row: 1; grid-column: 2; display: flex; min-width: 0; flex-direction: column; gap: 5px; }
.tile-copy strong { overflow: hidden; color: var(--dash-text); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.tile-copy small { overflow: hidden; color: var(--dash-text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.inline-action-icon { width:14px;height:14px;object-fit:contain;vertical-align:-2px; }
.tile-action { grid-row: 2; grid-column: 2; align-self: start; justify-self: start; min-height: 34px; padding: 0 15px; border: 0; border-radius: 10px; background: var(--brand-gradient); color: #fff; cursor: pointer; font-size: 12px; font-weight: 600; }
.tile-action:hover:not(:disabled), .tile-action:focus-visible { filter: brightness(1.05); outline: none; }
.tile-action:disabled { background: #eef1f7; color: var(--dash-text-muted); cursor: not-allowed; font-weight: 500; }

/* ---------------- 右栏：平台同步 / AI 助手 / 待办 ---------------- */
.ov-pill { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
.ov-pill.success { background: #ecfdf3; color: #027a48; }
.ov-pill.info { background: #eef2f7; color: #475467; }
.ov-empty { padding: 16px 2px; color: var(--dash-text-muted); font-size: 12px; text-align: center; }
.ov-link img { width:14px;height:14px;object-fit:contain; }.ov-link { display: inline-flex; align-items: center; justify-content: center; gap: 6px; margin-top: 10px; padding-top: 12px; width: 100%; border: 0; border-top: 1px solid #f2f4f8; background: transparent; color: var(--dash-purple-text); cursor: pointer; font-size: 12.5px; font-weight: 600; }
.ov-link.inline { width: auto; margin: 0; padding: 0; border: 0; font-size: 12px; }
.ov-link:hover, .ov-link:focus-visible { color: #5b3df5; outline: none; }
.sync-row { display: flex; align-items: center; gap: 11px; padding: 11px 0; border-bottom: 1px solid #f4f6fa; }
.sync-row:last-of-type { border-bottom: 0; }
.sync-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }
.sync-copy strong { color: var(--dash-text); font-size: 13px; }
.sync-copy span { color: var(--dash-text-muted); font-size: 11.5px; }
.sync-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.sync-meta strong { display: inline-flex; align-items: center; gap: 5px; color: var(--dash-green); font-size: 12px; }
.sync-meta:has(.sync-dot.offline) strong { color: var(--dash-red-text); }
.sync-meta:has(.sync-dot.login) strong { color: var(--dash-orange); }
.sync-meta small { color: var(--dash-text-muted); font-size: 11px; white-space: nowrap; }
.sync-dot { display: none; }
.ov-ai { overflow: hidden; border: 0; background: linear-gradient(125deg, #2b2170 0%, #3a2a92 42%, #1b1748 100%); color: #fff; }
.ov-ai-glow { position: absolute; top: -46px; right: -30px; width: 190px; height: 190px; border-radius: 50%; background: radial-gradient(circle, rgba(164, 120, 255, .85), rgba(124, 92, 255, .18) 55%, transparent 72%); filter: blur(2px); }
.ov-ai-copy { position: relative; display: flex; flex-direction: column; gap: 8px; }
.ov-ai-copy h2 { display: flex; align-items: center; gap: 8px; color: #fff; font-size: 16px; }
.ov-ai-copy p { color: rgba(255, 255, 255, .76); font-size: 12px; }
.ov-ai-button .inline-action-icon { width:14px;height:14px;object-fit:contain; }.ov-ai-button { display: inline-flex; align-self: flex-start; align-items: center; gap: 8px; margin-top: 4px; height: 36px; padding: 0 16px; border: 0; border-radius: 11px; background: #fff; color: #3a2a92; cursor: pointer; font-size: 12.5px; font-weight: 700; }
.ov-ai-button:hover, .ov-ai-button:focus-visible { background: #f3efff; outline: none; }
.todo-list { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 0; padding: 0; list-style: none; }
.todo-item { display: flex; align-items: center; gap: 10px; padding: 9px 2px; }
.todo-item.clickable { cursor: pointer; border-radius: 7px; }
.todo-item.clickable:hover, .todo-item.clickable:focus-visible { background: var(--dash-card-hover); outline: none; }
.todo-check { width: 18px; height: 18px; flex: 0 0 18px; border: 1.5px solid #cfd8e6; border-radius: 50%; }
.todo-title { min-width: 0; flex: 1; overflow: hidden; color: var(--dash-text); font-size: 12.5px; text-overflow: ellipsis; white-space: nowrap; }
.todo-chip { flex: 0 0 auto; padding: 3px 9px; border-radius: 8px; font-size: 11px; font-weight: 600; }
.todo-chip.urgent { background: #fff4e5; color: #b54708; }
.todo-chip.info { background: #eef4ff; color: #1d4ed8; }
/* 概览卡只展示待开发票状态，点击后进入发票中心核对。 */

/* ---------------- 弹窗 / 菜单 / 提示 ---------------- */
.dashboard-context-menu { position: fixed; z-index: 220; width: 252px; padding: 6px; border: 1px solid var(--dash-border-strong); border-radius: 14px; background: #fff; box-shadow: var(--shadow-pop); }
.ctx-item { display: flex; align-items: center; gap: 7px; width: 100%; min-height: 31px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--dash-text-soft); text-align: left; cursor: pointer; font-size: 12px; }
.ctx-item img { width: 15px; height: 15px; flex: 0 0 15px; object-fit: contain; }
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
.command-result-icon img { width: 16px; height: 16px; object-fit: contain; }.toolbar-action-icon { width: 17px; height: 17px; object-fit: contain; }.command-result-icon { display: flex; width: 28px; height: 28px; align-items: center; justify-content: center; border-radius: 8px; background: var(--brand-soft); color: var(--dash-purple); }
.command-results button span:nth-child(2) { display: flex; flex: 1; flex-direction: column; gap: 2px; }
.command-results strong { color: var(--dash-text); font-size: 12px; }
.command-results small { color: var(--dash-text-muted); font-size: 11px; }
.command-results kbd { color: var(--dash-text-muted); }
.command-empty { padding: 28px; color: var(--dash-text-muted); text-align: center; font-size: 12px; }

/* 窄屏导航：完整侧栏变成抽屉，保留店铺列表和设置入口，避免只剩无法识别的图标。 */
.mobile-nav-toggle { display: none; width: 34px; height: 34px; flex: 0 0 34px; align-items: center; justify-content: center; flex-direction: column; gap: 4px; border: 1px solid var(--dash-border); border-radius: 9px; background: #fff; cursor: pointer; -webkit-app-region: no-drag; }
.mobile-nav-toggle span { display: block; width: 15px; height: 1.5px; border-radius: 2px; background: var(--dash-text-soft); }
.mobile-nav-toggle:hover, .mobile-nav-toggle:focus-visible { border-color: rgba(124, 92, 255, .55); outline: none; box-shadow: 0 0 0 3px rgba(124, 92, 255, .1); }
.mobile-sidebar-backdrop { display: none; }

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
@media (max-width: 720px) {
  .dashboard-shell { position: relative; }
  .dashboard-sidebar { position: fixed; inset: 0 auto 0 0; z-index: 160; width: min(286px, 86vw); min-width: min(286px, 86vw); transform: translateX(-105%); transition: transform .2s ease; box-shadow: 18px 0 46px rgba(15, 23, 41, .25); }
  .dashboard-shell.mobile-nav-open .dashboard-sidebar { transform: translateX(0); }
  .dashboard-shell.mobile-nav-open .dashboard-sidebar.collapsed { width: min(286px, 86vw); min-width: min(286px, 86vw); }
  .dashboard-shell.mobile-nav-open .dashboard-brand-copy { display: flex; }
  .dashboard-shell.mobile-nav-open .nav-label { display: inline; }
  .dashboard-shell.mobile-nav-open .nav-group-title { display: block; }
  .dashboard-shell.mobile-nav-open .dashboard-store-area { display: flex; }
  .dashboard-shell.mobile-nav-open .pro-copy { display: flex; }
  .dashboard-shell.mobile-nav-open .pro-arrow { display: inline; }
  .dashboard-shell.mobile-nav-open .dashboard-nav-item { justify-content: flex-start; padding: 0 12px; }
  .dashboard-shell.mobile-nav-open .dashboard-store-area { display: flex; }
  .dashboard-shell.mobile-nav-open .sidebar-rail { display: none; }
  .mobile-sidebar-backdrop { position: fixed; inset: 0; z-index: 150; display: block; border: 0; background: rgba(15, 23, 41, .42); backdrop-filter: blur(2px); cursor: pointer; }
  .dashboard-toolbar { height: 56px; flex-basis: 56px; gap: 8px; padding: 0 12px; }
  .mobile-nav-toggle { display: inline-flex; }
  .toolbar-crumb { min-width: 0; flex: 1 1 auto; gap: 4px; font-size: 12px; }
  .crumb-root, .crumb-sep { display: none; }
  .crumb-current { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .workspace-switcher { position: static; flex: 0 0 auto; max-width: 138px; overflow-x: auto; transform: none; scrollbar-width: none; }
  .workspace-switcher::-webkit-scrollbar { display: none; }
  .workspace-tab { min-height: 30px; padding: 0 8px; font-size: 11px; }
  .toolbar-actions { flex: 0 0 auto; gap: 2px; }
  .toolbar-datetime { display: none; }
  .toolbar-icon-button { width: 32px; height: 32px; }
  .toolbar-avatar { width: 30px; height: 30px; }
  .notification-center { position: fixed; top: 60px; right: 10px; width: min(320px, calc(100vw - 20px)); }
  .overview-page { padding: 14px 12px 24px; }
  .ov-card { padding: 14px; border-radius: 14px; }
  .ov-card-head { gap: 10px; }
  .ov-card-tools { width: 100%; min-width: 0; flex-wrap: wrap; }
  .period-tabs { max-width: 100%; overflow-x: auto; scrollbar-width: none; }
  .period-tabs::-webkit-scrollbar { display: none; }
  .period-tabs button { min-width: 58px; padding: 0 9px; }
  .platform-select { flex: 1 1 140px; min-width: 0; }
  .ov-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px 9px; }
  .ov-kpi { padding-left: 9px; }
  .kpi-value { font-size: 20px; }
  .dashboard-error { align-items: flex-start; flex-wrap: wrap; }
  .dashboard-error button { margin-left: auto; }
  .dashboard-dialog, .modal { width: min(100%, calc(100vw - 24px)); padding: 16px; }
  .modal-mask, .dashboard-overlay { padding: 12px; }
  .modal-actions, .dashboard-dialog-actions { flex-wrap: wrap; }
  .modal-actions > *, .dashboard-dialog-actions > * { min-height: 40px; flex: 1 1 120px; }
  .dashboard-toast-host { right: 12px; bottom: 12px; max-width: calc(100vw - 24px); }
}
@media (max-width: 480px) {
  .dashboard-toolbar { gap: 6px; }
  .workspace-switcher { max-width: 108px; }
  .workspace-tab { padding: 0 7px; }
  .workspace-tab > span:last-child { max-width: 58px; overflow: hidden; text-overflow: ellipsis; }
  .toolbar-icon-button { width: 30px; }
  .toolbar-avatar { display: none; }
  .ov-kpis { gap: 11px 7px; }
  .kpi-value { font-size: 18px; }
  .ov-title-row { align-items: flex-start; flex-direction: column; gap: 8px; }
  .ov-refresh { width: 100%; justify-content: center; }
  .shortcut-tile { padding: 12px; }
}
</style>
