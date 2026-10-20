<template>
      <div class="invite-records-toolbar">
        <label class="invite-store-select">
          <span>搜索</span>
          <input v-model="creatorQuery" type="search" placeholder="昵称 / 平台 / 标签" data-test="invite-v2-creator-search" />
        </label>
        <label class="invite-check"><input v-model="creatorBlacklistedOnly" type="checkbox" data-test="invite-v2-creator-blacklist-only" />只看黑名单</label>
        <span class="invite-tab-meta">{{ visibleCreators.length }} 位达人</span>
        <button type="button" class="invite-mini" @click="loadCreators">刷新</button>
      </div>
      <div v-if="!visibleCreators.length" class="invite-empty" data-test="invite-v2-creators-empty">
        <h2>还没有达人记录</h2>
        <p>引擎每发出一位邀约，就会把昵称、身份、最近状态写进达人库；旧记录会在第一次打开时回填。</p>
      </div>
      <div v-else class="invite-creator-table" data-test="invite-v2-creators">
        <div class="invite-creator-head">
          <span>达人</span><span>平台</span><span>最近状态</span><span>最近邀约</span><span>次数</span><span>标签</span><span>操作</span>
        </div>
        <div v-for="creator in visibleCreators" :key="`${creator.storeId}:${creator.platform}:${creator.creatorKey}`" class="invite-creator-row" data-test="invite-v2-creator-row">
          <span class="invite-record-name">
            <strong>{{ creator.nickname }}</strong>
            <small>{{ creator.identityLevel === 'username' ? '用户名匹配' : '仅昵称匹配' }} · {{ storeName(creator.storeId) }}</small>
          </span>
          <span>{{ creator.platform }}</span>
          <span><em class="invite-chip" :class="recordStatusTone(creator.lastStatus || '')">{{ recordStatusLabel(creator.lastStatus || '') }}</em></span>
          <span>{{ formatTime(creator.lastInvitedAt) }}</span>
          <span>{{ creator.inviteCount }}</span>
          <span class="invite-creator-tags">{{ creator.tags.length ? creator.tags.join('、') : '—' }}</span>
          <span>
            <button type="button" class="invite-mini" :class="{ danger: !creator.blacklisted }" data-test="invite-v2-creator-blacklist" @click="toggleBlacklist(creator)">
              {{ creator.blacklisted ? '移出黑名单' : '加入黑名单' }}
            </button>
          </span>
        </div>
      </div>
</template>

<script setup lang="ts">
import { inject } from 'vue'
import { INVITE_PAGE_KEY } from '../invite-page-context'

const page = inject(INVITE_PAGE_KEY)!
const { creatorQuery, creatorBlacklistedOnly, visibleCreators, loadCreators, recordStatusTone, recordStatusLabel, formatTime, storeName, toggleBlacklist } = page
</script>
