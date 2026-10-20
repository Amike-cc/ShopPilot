<template>
      <div class="invite-assets-note">
        资产按店铺保存。当前：<b>{{ assetStore ? assetStore.name : '未选择店铺' }}</b><template v-if="assetPlatform"> · {{ assetPlatform }}</template>
        <span v-if="!storeId && assetStore">（全部店铺视图默认使用第一家）</span>
      </div>
      <div v-if="!assetStore" class="invite-empty">
        <h2>先选择一家店铺</h2>
        <p>话术和商品 ID 都属于具体店铺，不跨店共享。</p>
      </div>
      <div v-else class="invite-asset-grid">
        <section class="invite-asset-card">
          <h2>话术库</h2>
          <input v-model="scriptDraft.name" class="invite-asset-input" maxlength="60" placeholder="话术名称，如：美妆高佣版" data-test="invite-v2-script-name" />
          <textarea v-model="scriptDraft.template" class="invite-asset-textarea" maxlength="2000" rows="4" placeholder="话术内容；支持变量占位（由使用方自行替换）" data-test="invite-v2-script-template"></textarea>
          <div class="invite-asset-actions">
            <select v-model="scriptDraft.mode" class="invite-asset-select" data-test="invite-v2-script-mode">
              <option value="manual">手动话术</option>
              <option value="ai">AI 生成模板</option>
            </select>
            <button type="button" class="invite-mini" data-test="invite-v2-script-save" :disabled="!scriptDraft.name.trim() || !scriptDraft.template.trim()" @click="saveScript">保存话术</button>
          </div>
          <div v-if="!scripts.length" class="invite-asset-empty">还没有话术</div>
          <article v-for="script in scripts" :key="script.id" class="invite-asset-row" data-test="invite-v2-script-row">
            <div><strong>{{ script.name }}</strong><small>{{ script.mode === 'ai' ? 'AI 模板' : '手动话术' }} · {{ script.template.length }} 字</small></div>
            <button type="button" class="invite-mini" @click="removeScript(script)">删除</button>
          </article>
        </section>
        <section class="invite-asset-card">
          <h2>商品集</h2>
          <input v-model="productSetDraft.name" class="invite-asset-input" maxlength="60" placeholder="商品集名称，如：主推 3 款" data-test="invite-v2-product-set-name" />
          <textarea v-model="productSetDraft.productIds" class="invite-asset-textarea" rows="4" placeholder="一行一个商品 ID，或用逗号/空格分隔（最多 30 个）" data-test="invite-v2-product-set-ids"></textarea>
          <div class="invite-asset-actions">
            <span class="invite-tab-meta">{{ parseProductIds(productSetDraft.productIds).length }} 个 ID</span>
            <button type="button" class="invite-mini" data-test="invite-v2-product-set-save" :disabled="!productSetDraft.name.trim() || !parseProductIds(productSetDraft.productIds).length" @click="saveProductSet">保存商品集</button>
          </div>
          <div v-if="!productSets.length" class="invite-asset-empty">还没有商品集</div>
          <article v-for="set in productSets" :key="set.id" class="invite-asset-row" data-test="invite-v2-product-set-row">
            <div><strong>{{ set.name }}</strong><small>{{ set.productIds.length }} 个商品 · {{ set.productIds.slice(0, 2).join(' / ') }}{{ set.productIds.length > 2 ? ' …' : '' }}</small></div>
            <button type="button" class="invite-mini" @click="removeProductSet(set)">删除</button>
          </article>
        </section>
      </div>
</template>

<script setup lang="ts">
import { inject } from 'vue'
import { INVITE_PAGE_KEY } from '../invite-page-context'

const page = inject(INVITE_PAGE_KEY)!
const { assetStore, assetPlatform, storeId, scriptDraft, productSetDraft, scripts, productSets, saveScript, removeScript, saveProductSet, removeProductSet, parseProductIds } = page
</script>
