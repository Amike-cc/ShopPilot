<template>
      <div class="invite-records-toolbar">
        <label class="invite-store-select">
          <span>状态</span>
          <select v-model="statusFilter" data-test="invite-v2-record-status">
            <option value="">全部状态</option>
            <option value="sent">已发送</option>
            <option value="accepted">已接受</option>
            <option value="rejected">已拒绝</option>
            <option value="unknown">状态未知</option>
            <option value="skipped_already_invited">已跳过（7 天内已邀）</option>
          </select>
        </label>
        <span class="invite-tab-meta">共 {{ records.length }} 条（最多显示 100 条）</span>
        <button type="button" class="invite-mini" data-test="invite-v2-export" :disabled="!records.length" @click="exportRecordsCsv">导出 CSV</button>
      </div>
      <div v-if="!records.length" class="invite-empty" data-test="invite-v2-records-empty">
        <h2>还没有逐人记录</h2>
        <p>批次发送成功后，引擎会按实际勾选/点击的达人逐人写入记录；发送失败或无法确认的会显示为未知。</p>
      </div>
      <div v-else class="invite-record-table" data-test="invite-v2-records">
        <div class="invite-record-head">
          <span>达人</span><span>店铺/批次</span><span>状态</span><span>来源</span><span>时间</span><span>动作</span>
        </div>
        <div v-for="record in records" :key="record.id" class="invite-record-row" data-test="invite-v2-record-row">
          <span class="invite-record-name">
            <strong>{{ record.nickname }}</strong>
            <small>{{ record.identityLevel === 'username' ? '用户名匹配' : '仅昵称匹配' }}</small>
          </span>
          <span>{{ record.storeName || storeName(record.storeId) }}<small>{{ record.campaignName || '无批次' }}</small></span>
          <span><em class="invite-chip" :class="recordStatusTone(record.status)">{{ recordStatusLabel(record.status) }}</em></span>
          <span>{{ record.statusSource === 'platform' ? '平台回读' : record.statusSource === 'manual' ? '人工修正' : '本地记录' }}</span>
          <span>{{ formatTime(record.invitedAt || record.createdAt) }}</span>
          <span><button type="button" class="invite-mini" @click="openStore(record.storeId)">打开店铺</button></span>
        </div>
      </div>
</template>

<script setup lang="ts">
import { inject } from 'vue'
import { INVITE_PAGE_KEY } from '../invite-page-context'

const page = inject(INVITE_PAGE_KEY)!
const { statusFilter, records, exportRecordsCsv, recordStatusTone, recordStatusLabel, storeName, formatTime, openStore } = page
</script>
