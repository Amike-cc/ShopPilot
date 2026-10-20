<template>
  <section class="dashboard-browser-surface" data-test="dashboard-browser-surface" aria-label="店铺浏览器">
    <div class="dashboard-browser-tabs" role="tablist" aria-label="店铺标签页">
      <button
        v-for="(tab, tabIndex) in ws.displayedTabs"
        :key="tab.id"
        type="button"
        draggable="true"
        :class="['dashboard-browser-tab', { active: ws.activeTab?.id === tab.id, 'multi-selected': isTabSelected(tab.id), pinned: tab.isPinned, dragging: dragTabId === tab.id }]"
        role="tab"
        :aria-selected="ws.activeTab?.id === tab.id"
        :data-test="'browser-tab-' + tabIndex"
        :data-tab-id="tab.id"
        :title="tab.isPinned ? '已固定：一键关闭会保留' : (tab.title || tab.url)"
        @click="onTabClick(tab, $event)"
        @contextmenu.prevent.stop="openTabMenu(tab, $event)"
        @dragstart="onTabDragStart(tab, $event)"
        @dragover.prevent
        @drop.prevent="onTabDrop(tab, $event)"
        @dragend="onTabDragEnd"
      >
        <span v-if="tab.isPinned" class="browser-tab-pin" aria-hidden="true">●</span>
        <span v-if="tab.loading" class="browser-tab-spinner" aria-hidden="true"></span>
        <span class="browser-tab-title" :title="tab.title || tab.url">{{ tab.title || '新标签页' }}</span>
        <span class="browser-tab-close" title="关闭标签页" @click.stop="ws.closeTab(tab.id)"><img :src="closeIcon" alt="" /></span>
      </button>
      <button type="button" class="dashboard-browser-tab-add" title="新标签页" @click="ws.newTab()"><img :src="addIcon" alt="" /></button>
      <!-- 多选模式：只有真的选中了才出现，避免常驻占用标签栏宽度 -->
      <div v-if="selectedTabIds.length" class="dashboard-tabs-batch" data-test="tabs-batch-bar">
        <span class="tabs-batch-count" data-test="tabs-batch-count">已选 {{ selectedTabIds.length }} 个</span>
        <button type="button" class="tabs-batch-close" data-test="tabs-batch-close" @click="requestCloseSelected">关闭选中</button>
        <button type="button" class="tabs-batch-clear" data-test="tabs-batch-clear" @click="clearTabSelection">取消</button>
      </div>
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
            @dom-ready="handleWebviewAttach(item)"
            @did-fail-load="handleWebviewFailure(item, $event)"
            @did-finish-load="clearWebviewError(item)"
            @destroyed="handleWebviewDestroyed(item)"
          ></webview>
          <div v-if="webviewDiagnostics.length" class="dashboard-browser-webview-diagnostics" data-test="webview-diagnostics">
            <div class="diagnostic-head">
              <strong>浏览器视图诊断</strong>
              <span class="diagnostic-count">{{ failedDiagnostics.length ? `${failedDiagnostics.length} 个页面未就绪` : '连接中' }}</span>
              <button
                type="button"
                class="mini-btn icon-btn diagnostic-collapse"
                :aria-expanded="!diagnosticsCollapsed"
                :aria-label="diagnosticsCollapsed ? '展开诊断详情' : '收起诊断详情（失败列表仍会保留）'"
                @click="diagnosticsCollapsed = !diagnosticsCollapsed"
              >{{ diagnosticsCollapsed ? '展开' : '收起' }}</button>
            </div>
            <template v-if="!diagnosticsCollapsed">
              <!-- live region 只包文本：按钮放在 region 外，避免每次店铺/标签切换都被朗读器重播一遍控件 -->
              <div class="diagnostic-list" aria-live="polite" aria-atomic="false">
                <span v-for="diagnostic in webviewDiagnostics" :key="diagnostic.key" class="diagnostic-text">{{ diagnostic.text }}</span>
              </div>
              <div v-if="failedDiagnostics.length" class="diagnostic-actions-list">
                <div v-for="diagnostic in failedDiagnostics" :key="diagnostic.key" class="diagnostic-actions">
                  <span class="diagnostic-action-store">{{ diagnostic.storeName }}</span>
                  <button type="button" class="mini-btn icon-btn" :aria-label="`重试连接 ${diagnostic.storeName}`" @click="retryWebview(diagnostic.key)"><img class="button-icon" :src="browserRetryIcon" alt="" />重试</button>
                  <button type="button" class="mini-btn icon-btn" :aria-label="`检查 ${diagnostic.storeName} 代理`" @click="openProxyPanel(diagnostic)">检查代理</button>
                  <button type="button" class="mini-btn icon-btn" :aria-label="`重新登录 ${diagnostic.storeName}`" @click="reopenHome(diagnostic)">重新登录</button>
                  <button type="button" class="mini-btn icon-btn" :aria-label="`清理 ${diagnostic.storeName} 站点数据（保留登录态）`" @click="clearSiteData(diagnostic)">清理站点数据</button>
                </div>
              </div>
            </template>
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
            <div class="env-h">会话与 Cookie <button type="button" class="mini-btn env-action" data-test="session-check-login" :disabled="loginCheckBusy || !loginCheckReady" :title="loginCheckTitle" @click="checkLoginStatus">{{ loginCheckButtonText(loginCheckBusy) }}</button></div>
            <!-- 主动检测结果：tone 决定颜色，label + detail 直接上屏；结构不认识时如实显示「未识别」 -->
            <div v-if="loginCheckView" :class="['env-note', `login-check-${loginCheckView.tone}`]" data-test="session-check-login-result"><strong>{{ loginCheckView.label }}</strong> · {{ loginCheckView.detail }}</div>
            <!-- 行内提示：检测失败的原因，或按钮为什么点不动（不用 alert / window.confirm） -->
            <div v-if="loginCheckNote" class="env-note" data-test="session-check-login-note">{{ loginCheckNote }}</div>
            <div class="cf-btns"><button type="button" class="mini-btn" data-test="btn-export-session" :disabled="secBusy" @click="exportSession"><img class="button-icon" :src="sessionExportIcon" alt="" />导出加密会话包…</button><button type="button" class="mini-btn" data-test="btn-import-session" :disabled="secBusy" @click="importSession"><img class="button-icon" :src="sessionImportIcon" alt="" />导入会话包…</button></div>
            <div class="env-note">导出包经口令加密并带有效期；口令由主进程托管窗口采集，不经过界面脚本。</div>
            <input v-model="ckSearch" class="ck-search" placeholder="搜索 Cookie（名称/域）" @input="refreshCookies" />
            <div class="row-sub cookie-count">共 {{ cookiesTotal }} 条<span v-if="ckSearch">（筛选后 {{ cookies.length }}）</span></div>
            <div v-for="cookie in cookies.slice(0, 40)" :key="cookie.domain + cookie.path + cookie.name" class="proxy-item ck-item"><div class="p-info"><div class="row-main" :title="cookie.valuePreview">{{ cookie.name }}<span v-if="cookie.httpOnly" class="ck-flag">HttpOnly</span><span v-if="cookie.secure" class="ck-flag">Secure</span></div><div class="row-sub">{{ cookie.domain }}{{ cookie.path }} · {{ cookie.session ? '会话级' : cookie.expires }} · {{ cookie.valuePreview }}</div></div><button type="button" class="row-del" title="删除该 Cookie" @click="delCookie(cookie)"><img :src="deleteIcon" alt="" /></button></div>
            <button v-if="cookiesTotal > 0" type="button" class="mini-btn danger-btn" @click="clearCookies">清空该店铺全部 Cookie</button>
          </div>

          <div class="env-sec" data-test="lock-sec">
            <div class="env-h">应用锁</div>
            <template v-if="!ws.securityEnabled">
              <div class="env-note">未设置主密码。设置后可随时锁定应用；锁定会隐藏浏览器视图并拒绝业务操作。</div>
              <button type="button" class="mini-btn primary" data-test="lock-open-settings" @click="emit('open-settings', 'security')">去设置中心设置主密码 →</button>
            </template>
            <template v-else>
              <div class="cf-btns"><button type="button" class="mini-btn primary" data-test="btn-lock-now" @click="lockNow"><img class="button-icon" :src="securityLockIcon" alt="" />立即锁定</button><button type="button" class="mini-btn" data-test="lock-open-settings" @click="emit('open-settings', 'security')">安全设置 →</button></div>
              <div class="env-note">空闲自动锁定：{{ ws.idleMinutes ? ws.idleMinutes + ' 分钟' : '关闭' }}（在「设置中心 → 安全」中调整）</div>
            </template>
          </div>

          <div class="env-sec" data-test="diag-sec">
            <div class="env-h">备份与诊断</div>
            <div class="env-note">备份、恢复、诊断包与审计导出已移至「设置中心 → 数据与维护」，避免两处入口各自演化。</div>
            <button type="button" class="mini-btn" data-test="diag-open-settings" @click="emit('open-settings', 'maintenance')">打开数据与维护 →</button>
          </div>
        </div>

        <div v-else class="dashboard-browser-panel-body invite-panel-body">
          <div class="browser-panel-heading"><strong>达人邀约</strong><button type="button" @click="ws.refreshTasks()"><img class="button-icon" :src="browserRefreshIcon" alt="" />刷新</button></div>
          <!--
            配置 + 实时日志是独立组件：同一份视图也用在「应用中心 → 达人邀约」独立页。
            达人邀约在后端隐藏窗口运行，这里只是配置入口，不再承担"打开店铺浏览器"的前置条件。
          -->
          <InvitePanelView v-if="ws.displayedStoreId" :controller="inviteController" @started="onInviteStarted" />
          <div v-else class="browser-panel-empty invite-live-empty">先选择一家店铺，再配置并启动达人邀约。</div>
        </div>
      </aside>

      <aside v-else class="dashboard-browser-panel right-panel collapsed panel-rail" data-test="right-panel" data-dashboard-test="dashboard-browser-panel" aria-label="已收起的店铺工作台侧栏">
        <button type="button" class="panel-rail-expand" data-test="panel-expand" title="展开侧栏" @click="setPanelOpen(true)"><img :src="panelExpandIcon" alt="" /></button>
        <button v-for="item in panelItems" :key="item.key" type="button" class="panel-rail-button" :class="{ on: panel === item.key }" :data-test="`rail-${item.key}`" :title="item.label" @click="openPanel(item.key)"><img :src="item.icon" alt="" /></button>
      </aside>
    </div>

    <!-- 标签页右键菜单：关闭 / 关闭其他 / 关闭全部（批量项会先弹二次确认） -->
    <div
      v-if="tabMenu.open"
      class="tabs-context-menu"
      data-test="tabs-context-menu"
      role="menu"
      :style="{ left: tabMenu.x + 'px', top: tabMenu.y + 'px' }"
    >
      <button type="button" role="menuitem" data-test="tabs-menu-close" @click="closeTabFromMenu">关闭标签页</button>
      <button type="button" role="menuitem" data-test="tabs-menu-toggle-pin" :disabled="!menuTarget" @click="togglePinFromMenu">{{ pinMenuLabelText }}</button>
      <button type="button" role="menuitem" data-test="tabs-menu-close-others" :disabled="!menuOtherCount && !menuOtherIncludesPinned" @click="requestCloseOthers()">
        关闭其他标签页<span class="tabs-menu-count">{{ menuOtherIncludesPinned ? visibleTabs.length - 1 : menuOtherCount }}</span>
      </button>
      <button type="button" role="menuitem" data-test="tabs-menu-close-all" :disabled="!visibleTabs.length" @click="requestCloseAll()">
        关闭全部标签页<span class="tabs-menu-count">{{ menuAllIncludesPinned ? visibleTabs.length : menuAllCount }}</span>
      </button>
      <template v-if="selectedTabIds.length > 1">
        <div class="tabs-menu-sep"></div>
        <button type="button" role="menuitem" data-test="tabs-menu-close-selected" @click="requestCloseSelected">
          关闭选中的 {{ selectedTabIds.length }} 个
        </button>
      </template>
    </div>

    <!-- 批量关闭二次确认：不用 window.confirm，避免阻塞渲染进程与 CDP 会话 -->
    <div v-if="pendingTabClose" class="tabs-confirm-mask" data-test="tabs-close-confirm" @click.self="cancelTabClose">
      <div class="tabs-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="tabs-confirm-title">
        <h3 id="tabs-confirm-title" data-test="tabs-close-title">{{ pendingTabClose.title }}</h3>
        <p data-test="tabs-close-detail">{{ pendingTabClose.detail }}</p>
        <div class="tabs-confirm-actions">
          <button type="button" class="tabs-confirm-cancel" data-test="tabs-close-cancel" @click="cancelTabClose">取消</button>
          <button type="button" class="tabs-confirm-ok" data-test="tabs-close-ok" @click="confirmTabClose">确认关闭</button>
        </div>
      </div>
    </div>

    <div v-if="pendingPanelConfirmation" class="tabs-confirm-mask" data-test="panel-confirm" @click.self="cancelPanelConfirmation">
      <div class="tabs-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="panel-confirm-title">
        <h3 id="panel-confirm-title">{{ pendingPanelConfirmation.title }}</h3>
        <p>{{ pendingPanelConfirmation.detail }}</p>
        <div class="tabs-confirm-actions">
          <button type="button" class="tabs-confirm-cancel" data-test="panel-confirm-cancel" @click="cancelPanelConfirmation">取消</button>
          <button type="button" class="tabs-confirm-ok" data-test="panel-confirm-ok" @click="confirmPanelConfirmation">确认</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import PlatformIcon from '../../components/PlatformIcon.vue'
import bookmarksArt from '../../assets/ui/browser/bookmarks.png'
import downloadsArt from '../../assets/ui/browser/downloads.png'
import networkArt from '../../assets/ui/browser/network.png'
import homeIcon from '../../assets/icons/utility-home.svg'
import bookmarksIcon from '../../assets/icons/browser-bookmarks.svg'
import downloadsIcon from '../../assets/icons/browser-downloads.svg'
import envIcon from '../../assets/icons/browser-env.svg'
import inviteIcon from '../../assets/icons/invite-creator.svg'
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
import workspaceRefreshIcon from '../../assets/generated/ui-icons/workspace-refresh-gen.png'
import settingsSaveIcon from '../../assets/generated/ui-icons/settings-save-gen.png'
import panelExpandIcon from '../../assets/generated/ui-icons/panel-expand-gen.png'
import panelToggleIcon from '../../assets/generated/ui-icons/chevron-right-gen.png'
import verifiedIcon from '../../assets/generated/ui-icons/browser-verified-gen.png'
import unknownIcon from '../../assets/generated/ui-icons/browser-unknown-gen.png'
import browserRefreshIcon from '../../assets/generated/ui-icons/browser-refresh-gen.png'
import { useWorkspaceStore } from '../../stores/workspace'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
// 标签栏「固定 / 拖拽重排」的纯逻辑（菜单文案、落点 → 新顺序）
// 「主动检测登录状态」的纯逻辑（结果文案 / 按钮文案 / 按钮门控）
import { canCheckLogin, describeLoginCheckResult, loginCheckBlockedReason, loginCheckButtonText, type LoginCheckView } from './session-login-state'
// 视图诊断判据与词表（2026-10-16 审查第 8 条 / V4）：与主进程的 did-fail-load 监听、
// 「视图体检」读同一份定义，避免两处各写一遍、各错一半
import { BROWSER_VIEW_STATE_SENTENCE, classifyLoadFailure } from '@shared/view-state'
import { looksLikePlaceholderStoreName } from '@shared/store-name'
import { useBrowserTabs } from './use-browser-tabs'

import { useCreatorInvite } from './use-creator-invite'
import InvitePanelView from '../invite/InvitePanelView.vue'
import { useStoreWebviews, type OpenWebviewEntry, type ViewDiagnostic } from './use-store-webviews'
const emit = defineEmits<{
  // 环境面板的跳转入口：打开设置中心并落到指定页签（安全 / 数据与维护）
  'open-settings': [tab?: string]
}>()
const props = defineProps<{ active?: boolean }>()

const ws = useWorkspaceStore()
// ---------- 标签栏状态机（多选 / 菜单 / 批量关闭 / 固定与拖拽 / 快捷键诊断）----------
// 状态与事件接线全部在 use-browser-tabs.ts；这里只保留 onTabCloseRequested 这一个主进程事件入口。
const {
  urlDraft,
  selectedTabIds,
  tabMenu,
  pendingTabClose,
  pendingPanelConfirmation,
  visibleTabs,
  menuTarget,
  menuOtherCount,
  menuAllCount,
  menuAllIncludesPinned,
  menuOtherIncludesPinned,
  pinMenuLabelText,
  dragTabId,
  isTabSelected,
  clearTabSelection,
  onTabClick,
  openTabMenu,
  closeTabMenu,
  onTabMenuOutside,
  requestCloseSelected,
  requestCloseOthers,
  requestCloseAll,
  closeTabFromMenu,
  togglePinFromMenu,
  onTabDragStart,
  onTabDrop,
  onTabDragEnd,
  cancelTabClose,
  askPanelConfirmation,
  cancelPanelConfirmation,
  confirmPanelConfirmation,
  confirmTabClose,
  inputDiagnostic,
  describeKeyboardEvent,
  onBrowserKeyup,
} = useBrowserTabs({
  // 登录检测结果是按店铺算的：换店必须清掉，否则会把上一家的结论显示给下一家
  resetLoginCheckState: () => {
    loginCheckView.value = null
    loginCheckError.value = ''
    loginCheckNotifiedStore.value = null
  }
})
function onTabCloseRequested(payload: { storeId?: string, tabId?: string, mode?: 'all' | 'others' }): void {
  inputDiagnostic('ipc BROWSER_TAB_CLOSE_REQUESTED', {
    payload,
    active: props.active === true,
    displayedStoreId: ws.displayedStoreId
  })
  if (!props.active || !payload || payload.storeId !== ws.displayedStoreId) return
  if (payload.mode === 'all') requestCloseAll()
  else if (payload.mode === 'others') requestCloseOthers(payload.tabId || undefined)
}

const store = computed(() => ws.stores.find(item => item.id === ws.displayedStoreId) || null)
const platformHomeUrls = ref<Record<string, string>>({})
const homeUrl = computed(() => store.value ? platformHomeUrls.value[store.value.platform] || store.value.adminUrl || '' : '')
type PanelKey = 'bookmarks' | 'downloads' | 'env' | 'invite'
const panel = ref<PanelKey>('invite')
const panelOpen = ref(true)
const panelItems: Array<{ key: PanelKey; label: string; icon: string }> = [
  { key: 'bookmarks', label: '收藏', icon: bookmarksIcon },
  { key: 'downloads', label: '下载', icon: downloadsIcon },
  { key: 'env', label: '环境', icon: envIcon },
  { key: 'invite', label: '达人邀约', icon: inviteIcon }
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

// ---------- webview 适配层（ADR-001：元素登记/attach/看门狗/诊断动作见 use-store-webviews.ts）----------
// 组件只保留模板与布局；这里传入活动 guest 列表与诊断动作用到的面板入口。
const webviews = useStoreWebviews({ openWebviews, selectPanel, refreshEnvironment, platformHomeUrls })
const {
  webviewFailures,
  webviewAttached,
  diagnosticsCollapsed,
  webviewRefCallback,
  handleWebviewAttach,
  clearAttachWatchdog,
  retryWebview,
  handleWebviewDestroyed,
  openProxyPanel,
  reopenHome,
  clearSiteData,
} = webviews
const webviewDiagnostics = computed<ViewDiagnostic[]>(() => openWebviews.value
  // 采集专用页不参与诊断：它是后台自己的页面，用户没让它出现，就不该在界面上闪"正在连接店铺页面…"
  // （它的状态在设置中心「视图体检」里可见）
  .filter(item => !item.internal)
  // 失败态与「连接中」是两个独立门控（2026-10-16 审查 P1）：
  // 失败必须不受 guestAttached 约束——注册成功后 guestAttached 恒为 true，
  // 而 did-fail-load 只在注册成功之后才会发生，旧的 `!webviewAttached` 过滤会把
  // 网络/代理失败（用户最常见的故障）整个吞掉，只剩白屏。
  .map(item => ({
    key: item.key,
    storeId: item.storeId,
    tabId: item.tabId,
    storeName: item.storeName,
    failure: webviewFailures[item.key] as string | undefined,
    attached: webviewAttached(item)
  }))
  .filter(row => !!row.failure || !row.attached)
  .map(row => ({
    key: row.key,
    storeId: row.storeId,
    tabId: row.tabId,
    storeName: row.storeName,
    failed: !!row.failure,
    // 文案与「视图体检」同源（@shared/view-state）：两处不再各写一套措辞
    text: row.failure
      ? `${row.storeName}：${BROWSER_VIEW_STATE_SENTENCE.load_failed}——${row.failure}`
      : `${row.storeName}：${BROWSER_VIEW_STATE_SENTENCE.connecting}`
  })))

/** 失败条目单独取一份：动作按钮要放在 live region 之外 */
const failedDiagnostics = computed(() => webviewDiagnostics.value.filter(diagnostic => diagnostic.failed))

/** 浮层可收起（2026-10-16 审查 P3-10）：它是绝对定位、会盖住平台页面左下角 */
function clearWebviewError(item: OpenWebviewEntry): void {
  // 只有"已经真正挂上"的视图才配清失败态：未注册时 about:blank 加载完也会触发
  // did-finish-load，清掉注册失败的如实原因后界面退回"正在连接…"，
  // 用户从此刻起既看不到原因、也没有重试按钮（2026-10-16 用户实报的现场）。
  if (!webviewAttached(item)) return
  delete webviewFailures[item.key]
  clearAttachWatchdog(item.key)
  void maybeAutoNameStore(item)
}

/** 本会话里已经自动命名过的店铺：一次就够，别每加载一页就写一次库 */
const autoNamedStores = new Set<string>()

/**
 * 页面加载完成 → 把**占位名**的店铺自动改成平台上写的真名（2026-10-16 用户要求）。
 *
 * 为什么只动占位名：`11121`「店铺1」这种是建店时的出生名，改成真名只有好处；
 * 而「慕么美」「福气满满」可能是用户**有意**起的内部代号，被平台名悄悄覆盖、且每次开页
 * 都再覆盖一次，属于帮倒忙。手输的名字一律不碰（右键「读取店铺名」可随时手动采用）。
 *
 * 全程可见、可回退：写库走 store:update（和手动改名同一条路）、刷新列表、并弹提示告知
 * 改成了什么——不静默改数据。
 */
async function maybeAutoNameStore(item: OpenWebviewEntry): Promise<void> {
  if (item.internal) return
  if (autoNamedStores.has(item.storeId)) return
  const store = ws.stores.find(row => row.id === item.storeId)
  if (!store || !looksLikePlaceholderStoreName(store.name)) return
  autoNamedStores.add(item.storeId)
  const result = await window.shopilot.browser.readStoreName(item.storeId, item.tabId)
  if (!result.ok) {
    // 页面还没就绪/读超时：不是"这家店没有真名"，留着下次页面加载再试
    autoNamedStores.delete(item.storeId)
    return
  }
  const data = result.data as { name?: string | null; sourceLabel?: string | null } | null
  if (!data?.name || data.name === store.name) return
  const updated = await window.shopilot.store.update({ storeId: item.storeId, patch: { name: data.name } })
  if (!updated.ok) return
  autoNamedStores.delete(item.storeId)
  await ws.refreshStores()
  ws.toast(`店铺名已按店铺页面自动更新：「${store.name}」→「${data.name}」（来源：${data.sourceLabel || '页面'}）`, 'success', 6000)
}

function handleWebviewFailure(item: OpenWebviewEntry, event: any): void {
  // 判据与主进程同源（@shared/view-state.classifyLoadFailure）：
  // · 子框架（广告/统计/第三方登录 iframe）失败不是整页失败；
  // · 被取消的加载（-3 = net::ERR_ABORTED，Electron 对 did-fail-load 的定义就包含 cancelled）
  //   也不是失败——只豁免 -3、或者只看 isMainFrame，都会漏掉另一半（2026-10-16 审查 P3-8）。
  const reason = classifyLoadFailure(event)
  if (!reason) return
  const message = `加载失败（${reason}）`
  webviewFailures[item.key] = message
  // 渲染层有到主日志的现成桥接（main/index.ts 的 console-message 监听，level>=2 才记）：
  // 落一条 warn，诊断包的 app.log 才查得到"哪个店、哪个标签页、因为什么失败"（审查 P2-6）
  console.warn(`[webview-diagnostics] ${item.storeName}(${item.storeId.slice(0, 8)}/${item.tabId.slice(0, 8)}) ${message}`)
}


// ---------- 达人邀约（状态/IPC 读写/校验/任务进度映射见 use-creator-invite.ts）----------
// 配置与日志的模板已抽到 features/invite/InvitePanelView.vue（独立页复用同一份视图）。
// 本组件只保留「平台入口」这条侧栏通用数据，以及店铺切换时的配置重载。
const inviteController = useCreatorInvite({ store })
const {
  entryRoutes,
  displayedPlatformName,
  refreshSquareUrls,
  loadInviteCategoryTrees,
  refreshEntryRoutes,
  loadInviteConfig
} = inviteController

/** 开始邀约成功后的界面反馈：日志区已由 composable 刷新，这里只同步一次任务数据。 */
function onInviteStarted(): void {
  void ws.refreshTasks()
}
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

function selectPanel(next: PanelKey) {
  panel.value = next
  if (next === 'bookmarks') void ws.refreshBookmarks()
  if (next === 'bookmarks') void refreshEntryRoutes()
  if (next === 'downloads') void ws.refreshDownloads()
  if (next === 'env') void refreshEnvironment()
  if (next === 'invite') void ws.refreshTasks()
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
  inputDiagnostic('keydown', describeKeyboardEvent(event))
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'b') { event.preventDefault(); togglePanel(); return }
  // Esc 逐层退出：确认框 → 右键菜单 → 多选
  if (event.key === 'Escape') {
    if (pendingPanelConfirmation.value) { event.preventDefault(); cancelPanelConfirmation(); return }
    if (pendingTabClose.value) { event.preventDefault(); pendingTabClose.value = null; return }
    if (tabMenu.open) { event.preventDefault(); closeTabMenu(); return }
    if (selectedTabIds.value.length) { event.preventDefault(); clearTabSelection() }
    return
  }
  if (!ws.displayedStoreId) return
  if (!(event.ctrlKey || event.metaKey)) return
  if (event.key.toLowerCase() !== 'w') return
  event.preventDefault()
  // Ctrl+Shift+W 关闭全部 / Ctrl+Alt+W 关闭其他（都先弹确认）；Ctrl+W 关当前页（与浏览器一致）
  if (event.shiftKey) { requestCloseAll(); return }
  if (event.altKey) { requestCloseOthers(ws.activeTab?.id); return }
  if (ws.activeTab) void ws.closeTab(ws.activeTab.id)
  else ws.toast('没有可关闭的标签页', 'info')
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

// ---------- 主动检测登录状态（session.checkLoginStatus / SESSION_EXPIRED）----------
// 会话区此前只有被动读数与导入导出；这里补上"主动查一次登录态"的入口，
// 并接上主进程在确认"未登录/过期"时广播的 SESSION_EXPIRED（此前是一条死契约）。
const loginCheckBusy = ref(false)
const loginCheckView = ref<LoginCheckView | null>(null)
const loginCheckError = ref('')
/**
 * 已经提示过"登录态不可用"的店铺：一次检测既会产生 IPC 返回、又会触发 SESSION_EXPIRED
 * 事件，两条路各弹一次就是重复提示。登录态恢复正常或切换店铺时重置。
 */
const loginCheckNotifiedStore = ref<string | null>(null)

/** 检测要读店铺页面：活动标签的 guest 已经 attach 才算页面可用 */
const loginCheckPageAttached = computed(() => ws.activeTab?.guestAttached === true)
const loginCheckGate = computed(() => ({ storeId: ws.displayedStoreId, pageAttached: loginCheckPageAttached.value, appLocked: ws.appLocked }))
const loginCheckReady = computed(() => canCheckLogin(loginCheckGate.value))
/** 按钮 title：被挡住时说明原因（可用时为空字符串，等于没有 tooltip） */
const loginCheckTitle = computed(() => loginCheckBlockedReason(loginCheckGate.value))
// 行内提示：IPC 失败优先，其次是"按钮为什么点不动"
const loginCheckNote = computed(() => loginCheckError.value || loginCheckTitle.value)

/** 同一家店的一次"登录态不可用"只提示一次（IPC 结果与事件共用这一道闸） */
function notifyLoginExpired(storeId: string, text: string): void {
  if (loginCheckNotifiedStore.value === storeId) return
  loginCheckNotifiedStore.value = storeId
  ws.toast(text, 'error')
}

async function checkLoginStatus(): Promise<void> {
  const storeId = ws.displayedStoreId
  if (!storeId || loginCheckBusy.value) return
  const blocked = loginCheckBlockedReason({ storeId, pageAttached: loginCheckPageAttached.value, appLocked: ws.appLocked })
  if (blocked) { loginCheckError.value = blocked; return }
  loginCheckBusy.value = true
  loginCheckError.value = ''
  try {
    const result = await window.shopilot.session.checkLoginStatus(storeId)
    // 切店了就丢掉这次结果，避免把 A 店的结论写到 B 店的会话块上
    if (ws.displayedStoreId !== storeId) return
    if (!result.ok) {
      // 失败不吞：主进程的错误消息原样上屏（行内提示，不弹 alert）
      loginCheckView.value = null
      loginCheckError.value = `检测失败：${result.error.message}`
      return
    }
    const view = describeLoginCheckResult(result.data)
    loginCheckView.value = view
    if (view.expired) notifyLoginExpired(storeId, `${view.label}：${view.detail}`)
    else loginCheckNotifiedStore.value = null // 登录态恢复：下次再过期要重新提示
  } catch (error) {
    loginCheckView.value = null
    loginCheckError.value = `检测失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    loginCheckBusy.value = false
  }
}

/** 主进程主动检测到"登录态不可用"时的广播（SESSION_EXPIRED）：只认当前显示的店铺 */
function onSessionExpired(payload: { storeId?: string; reasonCode?: string; safeMessage?: string }): void {
  if (!payload || payload.storeId !== ws.displayedStoreId) return
  const reasonCode = payload.reasonCode || 'LOGIN_REQUIRED'
  const safeMessage = payload.safeMessage || '主进程检测到该店铺登录态不可用'
  // 事件只带安全摘要（没有完整 PlatformLoginResult），如实按"登录态不可用"上屏。
  // 这里**不再回调** checkLoginStatus：检测本身就会发这个事件，回调会形成
  // 事件 → 检测 → 事件 的循环，还会再打一次页面。
  loginCheckView.value = {
    tone: 'warning',
    label: '登录态已失效',
    detail: `${safeMessage}（${reasonCode}）— 请到店铺页面重新登录`,
    expired: true
  }
  loginCheckError.value = ''
  notifyLoginExpired(payload.storeId, `登录态已失效：${safeMessage}`)
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
  await Promise.all([refreshCookies(), ws.refreshSecurity()])
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
  if (result.ok && result.data?.ok) {
    const detail = [result.data.httpStatus ? `HTTP ${result.data.httpStatus}` : '', result.data.exitIp ? `出口 ${result.data.exitIp}` : '', result.data.latencyMs != null ? `${result.data.latencyMs} ms` : ''].filter(Boolean).join(' · ')
    ws.toast(`代理可用${detail ? `（${detail}）` : ''}`, 'success')
  } else {
    const detail = result.ok ? [result.data?.errorCode || '出口异常', result.data?.httpStatus ? `HTTP ${result.data.httpStatus}` : ''].filter(Boolean).join(' · ') : result.error.message
    ws.toast(`代理不可用：${detail}`, 'error')
  }
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
  askPanelConfirmation({
    title: '删除代理？',
    detail: '绑定它的店铺会回退直连，平台将可能看到真实 IP。',
    action: async () => {
      const result = await window.shopilot.proxy.delete(id)
      if (!result.ok) { ws.toast(`删除失败：${result.error.message}`, 'error'); return }
      if (proxyBindId.value === id) proxyBindId.value = ''
      // 回落直连是**用户必须知道**的结果（真实 IP 会暴露给平台），不能只静默删掉
      const unbound = Number((result.data as any)?.unboundStores || 0)
      if (unbound > 0) ws.toast(`已删除代理：${unbound} 家店铺已回退直连（对面看到的是你的真实 IP），请重新绑定或确认可直连`, 'error')
      else ws.toast('已删除代理', 'success')
      void refreshEnvironment()
    }
  })
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
  const verifiedCount = verifyItems.value.filter(item => item.state === 'verified').length
  const failed = verifyItems.value.filter(item => item.state !== 'verified').length
  // 文案按**实际覆盖到的字段**措辞（2026-10-16 审查）：此前一句"全部字段实测一致"，
  // 而 platform / UA-CH / languages / deviceMemory 这些最易矛盾的项根本没在验证范围内。
  const detail = verifyItems.value.find(item => item.field === '实测取值')?.actual
  ws.toast(
    failed
      ? `已实测 ${verifiedCount} 项一致、${failed} 项未验证${detail ? `（${detail}）` : '（点「验证环境」前先打开该店铺页面）'}`
      : `已实测 ${verifiedCount} 项全部一致`,
    failed ? 'info' : 'success'
  )
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
  if (!storeId) return
  askPanelConfirmation({
    title: '清空店铺 Cookie？',
    detail: `「${store.value?.name || storeId}」的登录态将失效，需要重新登录。`,
    action: async () => {
      const result = await window.shopilot.session.clearCookies(storeId)
      if (result.ok) ws.toast('Cookie 已清空', 'success')
      else ws.toast(`清空失败：${result.error.message}`, 'error')
      void refreshCookies()
    }
  })
}

/**
 * 应用锁的「设置 / 更换 / 移除 / 空闲锁定」已整体迁移到「设置中心 → 安全」（单一入口）。
 * 侧栏只保留最高频的「立即锁定」快捷与跳转链接，避免两处各自演化。
 */
async function lockNow() {
  const result = await window.shopilot.security.lock()
  if (result.ok) await ws.refreshSecurity()
  else ws.toast(result.error.message, 'error')
}

async function removeBookmark(id: string) {
  const result = await window.shopilot.bookmark.delete(id)
  if (result.ok) await ws.refreshBookmarks()
}

function showInFolder(id: string) {
  void window.shopilot.download.showInFolder(id)
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
onMounted(async () => {
  const saved = await window.shopilot.settings.get('ui.rightPanelCollapsed')
  if (saved.ok && saved.data?.value === true) panelOpen.value = false
  window.addEventListener('keydown', onBrowserKeydown)
  window.addEventListener('keyup', onBrowserKeyup)
  document.addEventListener('mousedown', onTabMenuOutside)
  window.shopilot.on(EVENT_CHANNELS.BROWSER_TAB_CLOSE_REQUESTED, onTabCloseRequested)
  window.shopilot.on(EVENT_CHANNELS.SESSION_EXPIRED, onSessionExpired)
  void ws.refreshTasks()
  void ws.refreshSecurity()
  void refreshPlatformHomeUrls()
  void refreshSquareUrls()
  void loadInviteCategoryTrees()
  void refreshEntryRoutes()
  void loadInviteConfig()
})

onBeforeUnmount(() => {
  // 看门狗与 ref 闭包一起清（2026-10-16 审查 P4-11）：否则卸载后定时器仍会跑，
  // 往已经没人看的 reactive 表里写失败态
  webviews.dispose()
  pendingPanelConfirmation.value = null
  window.removeEventListener('keydown', onBrowserKeydown)
  window.removeEventListener('keyup', onBrowserKeyup)
  document.removeEventListener('mousedown', onTabMenuOutside)
  window.shopilot.off(EVENT_CHANNELS.BROWSER_TAB_CLOSE_REQUESTED, onTabCloseRequested)
  window.shopilot.off(EVENT_CHANNELS.SESSION_EXPIRED, onSessionExpired)
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
/* 固定标签：一键"关闭其他/全部"会跳过它，必须让用户在标签上就看得出来 */
.browser-tab-pin { flex: 0 0 auto; font-size: 8px; line-height: 1; color: #8b5cf6; }
.dashboard-browser-tab.multi-selected { border-color: #8b5cf6; background: #f1ebff; color: #4c1d95; }
.dashboard-browser-tab.multi-selected.active { background: #ffffff; }
/* 拖拽重排：被拖项淡出即可，落点按左右半在 JS 里算（见 tab-bar-actions.ts） */
.dashboard-browser-tab.dragging { opacity: .55; }
/* 多选工具条：只在真的选中时出现，避免常驻挤占标签宽度 */
.dashboard-tabs-batch { display: flex; align-items: center; gap: 6px; margin-left: 6px; padding: 0 8px; height: 26px; align-self: center; border: 1px solid #d9ccff; border-radius: 999px; background: #f7f3ff; white-space: nowrap; }
.tabs-batch-count { font-size: 11px; color: #5b21b6; }
.tabs-batch-close, .tabs-batch-clear { padding: 0 8px; height: 20px; line-height: 20px; border: 1px solid transparent; border-radius: 999px; background: transparent; font-size: 11px; cursor: pointer; }
.tabs-batch-close { color: #b42318; border-color: #f3c7c1; background: #fff5f3; }
.tabs-batch-close:hover { background: #ffe7e2; }
.tabs-batch-clear { color: #5b6472; }
.tabs-batch-clear:hover { color: var(--dash-text); }
/* 标签页右键菜单：fixed 定位（clientX/clientY 是视口坐标），层级压过 webview 容器 */
.tabs-context-menu { position: fixed; z-index: 60; display: flex; flex-direction: column; min-width: 190px; padding: 4px; border: 1px solid var(--dash-border); border-radius: 10px; background: #ffffff; box-shadow: 0 12px 32px rgba(24, 39, 75, .18); }
.tabs-context-menu button { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--dash-text); font-size: 12px; text-align: left; cursor: pointer; }
.tabs-context-menu button:hover:not(:disabled) { background: #f2f4f8; }
.tabs-context-menu button:disabled { color: #a7aebb; cursor: default; }
.tabs-menu-count { min-width: 18px; padding: 0 5px; border-radius: 999px; background: #eef1f6; color: #5b6472; font-size: 10px; text-align: center; }
.tabs-menu-sep { height: 1px; margin: 4px 6px; background: var(--dash-border); }
/* 二次确认：自定义浮层而不是 window.confirm —— 原生对话框会阻塞渲染进程（连 CDP 求值一起卡住） */
.tabs-confirm-mask { position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; background: rgba(17, 24, 39, .38); }
.tabs-confirm-card { width: min(420px, calc(100vw - 48px)); padding: 18px 20px; border-radius: 14px; background: #ffffff; box-shadow: 0 24px 60px rgba(17, 24, 39, .28); }
.tabs-confirm-card h3 { margin: 0 0 8px; font-size: 15px; color: var(--dash-text); }
.tabs-confirm-card p { margin: 0 0 16px; font-size: 12px; line-height: 1.7; color: #5b6472; }
.tabs-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
.tabs-confirm-actions button { min-width: 84px; height: 32px; border-radius: 8px; font-size: 12px; cursor: pointer; }
.tabs-confirm-cancel { border: 1px solid var(--dash-border); background: #ffffff; color: var(--dash-text); }
.tabs-confirm-cancel:hover { background: #f4f6fb; }
.tabs-confirm-ok { border: 1px solid #b42318; background: #d92d20; color: #ffffff; }
.tabs-confirm-ok:hover { background: #b42318; }
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
.dashboard-browser-webview-diagnostics { position: absolute; left: 10px; bottom: 10px; z-index: 3; display: flex; max-width: min(560px, calc(100% - 20px)); flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid rgba(242, 165, 87, .36); border-radius: 8px; background: #fff8ec; color: #92400e; font-size: 10px; line-height: 1.5; }
/* 头部：标题 + 失败条数 + 收起。收起后只剩这一行，避免浮层长期盖住平台页面左下角（审查 P3-10） */
.diagnostic-head { display: flex; align-items: center; gap: 8px; }
.diagnostic-head strong { color: #7a3d0a; font-size: 10px; }
.diagnostic-count { flex: 0 0 auto; color: var(--dash-text-muted); font-size: 9px; }
.diagnostic-collapse { margin-left: auto; }
.diagnostic-collapse:focus-visible { outline: 2px solid rgba(146, 64, 14, .55); outline-offset: 1px; }
.diagnostic-list { display: flex; flex-direction: column; gap: 4px; }
.diagnostic-actions-list { display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
.diagnostic-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding-top: 4px; border-top: 1px dashed rgba(146, 64, 14, .22); }
.diagnostic-action-store { color: var(--dash-text-muted); font-size: 9px; }
/* 关键动作必须有可见焦点（规范 §17.2）：浮层底色是浅黄，只靠 .mini-btn 的边框换色偏弱 */
.dashboard-browser-webview-diagnostics .mini-btn:focus-visible { outline: 2px solid rgba(146, 64, 14, .55); outline-offset: 1px; border-color: rgba(146, 64, 14, .6); }
/* 只给文本行设换行规则：不再用 `span { display:flex }` 一刀切（会把按钮行与计数也变成 flex 行） */
.dashboard-browser-webview-diagnostics .diagnostic-text { display: block; overflow-wrap: anywhere; }
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
/* 登录检测结果的四种语体：success/warning/error 各有自己的颜色，info 沿用 muted */
.env-note.login-check-success { color: #067647; }
.env-note.login-check-warning { color: #b54708; }
.env-note.login-check-error { color: #b42318; }
.env-note.login-check-info { color: var(--dash-text-muted); }
.proxy-item { display: flex; min-width: 0; align-items: center; gap: 7px; padding: 7px 0; border-top: 1px solid rgba(111,137,177,.08); }
.p-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: #78849b; }.p-dot.proxy-ok { background: #20d19a; }.p-dot.proxy-error { background: #ef6a7b; }
.p-info, .v-info { min-width: 0; flex: 1; }
.row-main { overflow: hidden; color: var(--dash-text-soft); text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }.row-sub { overflow: hidden; color: var(--dash-text-muted); text-overflow: ellipsis; white-space: nowrap; font-size: 9px; }
.button-icon { width:14px;height:14px;object-fit:contain;vertical-align:middle;margin-right:4px; }.mini-btn { min-height: 25px; padding: 0 8px; border: 1px solid var(--dash-border); border-radius: 6px; background: #ffffff; color: var(--dash-text-soft); cursor: pointer; font-size: 9px; white-space: nowrap; }.mini-btn:hover:not(:disabled), .mini-btn:focus-visible { border-color: rgba(145,116,255,.7); color: var(--dash-text); outline: none; }.mini-btn:disabled { cursor: not-allowed; opacity: .48; }.mini-btn.primary { border-color: #5b3df5; background: #6d4aff; color: #ffffff; }
.row-del { display:grid;place-items:center; width: 21px; height: 23px; flex: 0 0 21px; border: 0; border-radius: 5px; background: transparent; color: #78849b; cursor: pointer; font-size: 15px; }.row-del img { width:14px;height:14px;object-fit:contain; }.row-del:hover, .row-del:focus-visible { background: rgba(217,45,32,.14); color: #d92d20; outline: none; }.row-del:disabled { cursor: default; opacity: .56; }
.proxy-add { display: flex; flex-direction: column; gap: 6px; margin-top: 9px; }.proxy-add > input, .add-line input, .add-line select { min-height: 28px; padding: 0 7px; font-size: 9px; }.add-line { display: flex; gap: 6px; }.add-line select { width: 74px; min-width: 74px; flex: 0 0 74px; }.add-line .f-host { min-width: 60px; flex: 1 1 auto; }.add-line .f-port { width: 72px; min-width: 72px; flex: 0 0 72px; }.proxy-add > .mini-btn { align-self: flex-start; margin-top: 1px; }
.verify-item { display: flex; align-items: center; gap: 7px; padding: 6px 0; }.verify-status-icon { width: 17px; height: 17px; flex: 0 0 17px; object-fit: contain; }.cf-btns { display: flex; flex-wrap: wrap; gap: 6px; }.cf-btns.wrap { gap: 6px; }.cf-btns .mini-btn { margin-top: 0; }.ck-search { width: 100%; min-height: 28px; margin-top: 7px; padding: 0 7px; font-size: 9px; }.cookie-count { margin: 5px 0; }.ck-item { padding: 5px 0; }.ck-flag { margin-left: 4px; padding: 1px 3px; border: 1px solid var(--dash-border); border-radius: 4px; color: var(--dash-text-muted); font-size: 8px; }.danger-btn { border-color: rgba(217,45,32,.35); color: #d92d20; }
.browser-panel-link { width: 100%; margin-top: 12px; padding: 8px 0; border: 0; border-radius: 6px; background: rgba(124, 92, 255, .1); color: #5b3df5; font-size: 10px; cursor: pointer; }
.browser-panel-link:hover, .browser-panel-link:focus-visible { background: rgba(124, 92, 255, .18); color: #4326d9; outline: none; }
.invite-panel { min-width: 0; }.invite-config-sec { padding-bottom: 12px; }.invite-config-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 7px 0 9px; }.invite-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin-top: 8px; }.invite-field { display: flex; min-width: 0; flex-direction: column; gap: 4px; color: var(--dash-text-muted); font-size: 10px; }.invite-field input,.invite-field select,.invite-field textarea { min-width: 0; height: 29px; padding: 0 7px; border: 1px solid var(--dash-border); border-radius: 6px; background: #ffffff; color: var(--dash-text-soft); font-size: 10px; }.invite-field textarea { height: auto; min-height: 44px; padding: 6px 7px; line-height: 1.5; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }.invite-field input:focus,.invite-field select:focus,.invite-field textarea:focus { border-color: rgba(145,113,255,.78); outline: none; box-shadow: 0 0 0 2px rgba(145,113,255,.14); }.invite-choice-group { margin-top: 9px; color: var(--dash-text-muted); font-size: 10px; }
.invite-script-group textarea { width: 100%; box-sizing: border-box; min-height: 64px; margin-top: 6px; padding: 6px 7px; border: 1px solid var(--dash-border); border-radius: 6px; background: #ffffff; color: var(--dash-text-soft); font: inherit; font-size: 10px; line-height: 1.5; resize: vertical; }
.invite-script-group textarea:focus { border-color: rgba(145,113,255,.78); outline: none; box-shadow: 0 0 0 2px rgba(145,113,255,.14); }
.invite-script-group textarea[readonly] { background: #f7f8fa; color: var(--dash-text-muted); }
.invite-script-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.invite-script-row select { min-width: 0; flex: 1; height: 26px; padding: 0 6px; border: 1px solid var(--dash-border); border-radius: 6px; background: #ffffff; color: var(--dash-text-soft); font: inherit; font-size: 9.5px; }
.invite-ai-hint { margin-top: 5px; color: #b54708; }.invite-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }.inv-chip { display: inline-flex; align-items: center; gap: 4px; min-height: 24px; padding: 0 6px; border: 1px solid rgba(111,137,177,.22); border-radius: 999px; background: #f7f9fd; color: var(--dash-text-muted); cursor: pointer; font-size: 9px; }.inv-chip input { position: absolute; opacity: 0; pointer-events: none; }.inv-chip.on { border-color: rgba(135,102,246,.72); background: rgba(111,77,225,.18); color: #4c1d95; }.invite-missing { margin: 8px 0 0; padding: 7px 8px 7px 21px; border: 1px solid rgba(242,165,87,.2); border-radius: 7px; background: rgba(245,158,11,.12); color: #92400e; font-size: 9px; line-height: 1.5; }.invite-start-row { display: flex; align-items: center; gap: 8px; margin-top: 9px; }.entry-routes-title { margin-left: 6px; }.entry-route { min-height: 42px; padding-left: 4px; }.invite-live-sec { padding: 3px 2px 12px; border-bottom: 0; }.invite-live-empty { min-height: 150px; padding: 12px; line-height: 1.6; }.invite-live-stuck { padding: 8px 9px; border: 1px solid rgba(242,165,87,.24); border-radius: 7px; background: rgba(245,158,11,.12); color: #92400e; font-size: 10px; line-height: 1.45; }.step-row { display: flex; align-items: flex-start; gap: 7px; padding: 7px 0 0 3px; }.s-ico { width: 17px; flex: 0 0 17px; text-align: center; font-size: 11px; }.tc-btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }.invite-message { padding: 5px 0 2px; line-height: 1.5; white-space: normal; }.log-box { max-height: 210px; margin-top: 8px; padding: 7px 8px; overflow-y: auto; border: 1px solid var(--dash-border); border-radius: 7px; background: #f7f9fd; }.log-line { color: #4a5568; font-family: Consolas, monospace; font-size: 9px; line-height: 1.6; overflow-wrap: anywhere; }.invite-unavailable { padding: 10px 2px; border-bottom: 0; }.invite-unavailable .mini-btn { margin-top: 8px; }
@keyframes dashboard-browser-spin { to { transform: rotate(360deg); } }
@media (max-width: 820px) {
  .dashboard-browser-surface { padding: 12px 14px 16px; }
  .dashboard-browser-hint { display: none; }
  .dashboard-browser-panel { width: 244px; min-width: 244px; }
  .dashboard-browser-tab { min-width: 118px; max-width: 200px; }
}
@media (max-width: 680px) {
  .dashboard-browser-surface { gap: 8px; padding: 8px 9px 12px; }
  .dashboard-browser-tabs { min-height: 38px; gap: 4px; padding-bottom: 2px; }
  .dashboard-browser-tab { min-width: 112px; max-width: 180px; min-height: 34px; border-radius: 8px; }
  .dashboard-browser-tab-add { width: 32px; min-width: 32px; }
  .dashboard-browser-address { flex-wrap: wrap; min-height: 70px; padding: 6px; }
  .dashboard-browser-address .dashboard-browser-url { order: 2; flex-basis: 100%; }
  .dashboard-browser-body { flex-direction: column; overflow-y: auto; gap: 8px; }
  .dashboard-browser-main { min-height: min(56vh, 430px); flex: 1 1 auto; }
  .dashboard-browser-panel { width: auto; min-width: 0; min-height: 0; max-height: 42vh; flex: 0 0 auto; }
  .dashboard-browser-panel-tabs { grid-template-columns: repeat(4, minmax(0, 1fr)); position: sticky; top: 0; z-index: 2; }
  .dashboard-browser-panel-body { min-height: 0; max-height: calc(42vh - 46px); }
  .dashboard-browser-surface.picker-mode .dashboard-browser-body { width: 100%; max-width: 100%; height: auto; flex-basis: auto; }
}
@media (max-width: 420px) {
  .dashboard-browser-address { min-height: 104px; }
  .dashboard-browser-address .browser-nav-button { width: 30px; height: 30px; }
  .dashboard-browser-address .home-btn { margin-left: auto; }
  .dashboard-browser-tabs { position: relative; margin-right: -2px; }
  .dashboard-tabs-batch { position: absolute; right: 8px; top: 8px; z-index: 3; }
  .dashboard-browser-panel-tabs button { font-size: 9px; }
}</style>
