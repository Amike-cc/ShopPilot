<script setup lang="ts">
/**
 * 商品列表分页器（v4 §4.3）。
 *
 * offset 分页 + 页码窗口（最多 7 个页码格）——数据量级 < 10 万行的场景下，
 * 游标分页换不到什么收益，页码可达性反而更重要（运营要"跳到第几页"）。
 */
import { computed } from 'vue'

const props = defineProps<{ total: number; limit: number; offset: number }>()
const emit = defineEmits<{ (e: 'page', offset: number): void }>()

const pageCount = computed(() => Math.max(1, Math.ceil(props.total / Math.max(props.limit, 1))))
const current = computed(() => Math.min(Math.floor(props.offset / Math.max(props.limit, 1)) + 1, pageCount.value))

const pages = computed(() => {
  const total = pageCount.value
  const windowSize = 7
  let start = Math.max(1, current.value - 3)
  const end = Math.min(total, start + windowSize - 1)
  start = Math.max(1, end - windowSize + 1)
  const list: number[] = []
  for (let i = start; i <= end; i += 1) list.push(i)
  return list
})

function go(page: number): void {
  const clamped = Math.min(Math.max(page, 1), pageCount.value)
  if (clamped === current.value) return
  emit('page', (clamped - 1) * props.limit)
}
</script>

<template>
  <div v-if="total > 0" class="product-pager" data-test="product-pager">
    <button type="button" class="pager-btn" :disabled="current <= 1" @click="go(current - 1)">‹ 上一页</button>
    <button v-for="page in pages" :key="page" type="button" class="pager-btn"
            :class="{ active: page === current }" :data-test="'product-pager-' + page" @click="go(page)">{{ page }}</button>
    <button type="button" class="pager-btn" :disabled="current >= pageCount" @click="go(current + 1)">下一页 ›</button>
    <span class="pager-info" data-test="product-pager-info">第 {{ current }} / {{ pageCount }} 页 · 共 {{ total }} 条</span>
  </div>
</template>

<style scoped>
.product-pager{display:flex;align-items:center;gap:6px;padding:12px 16px;border-top:1px solid var(--dash-border);flex-wrap:wrap}
.pager-btn{min-height:28px;padding:0 10px;border:1px solid var(--dash-border);border-radius:7px;background:#fff;color:var(--dash-text-soft);font-size:12px;cursor:pointer}
.pager-btn:hover:not(:disabled){border-color:rgba(151,120,255,.7);color:var(--dash-text)}
.pager-btn.active{border-color:#5b3df5;background:#6d4aff;color:#fff}
.pager-btn:disabled{opacity:.45;cursor:default}
.pager-info{margin-left:auto;color:var(--dash-text-muted);font-size:11px}
</style>
