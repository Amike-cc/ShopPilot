<template>
  <div class="ct-editor" data-test="custom-editor">
    <div class="ct-bar">
      <span class="ct-count" data-test="custom-step-count">共 {{ steps.length }} 步</span>
      <span class="row-sub">每步只暴露引擎真正接受的字段，拼不出 schema 之外的键</span>
    </div>

    <div v-if="!steps.length" class="ct-empty" data-test="custom-empty">
      还没有步骤。点下面的「添加步骤」开始——建议第一步先「打开网址」，
      否则任务会从店铺当前停留的页面开始跑。
    </div>

    <div v-for="(s, i) in steps" :key="i" class="ct-step" :data-test="`custom-step-${i}`">
      <div class="ct-step-head">
        <span class="ct-idx">{{ i + 1 }}</span>
        <span class="ct-label">{{ entryOf(s)?.label || s.type }}</span>
        <span class="ct-group">{{ entryOf(s)?.group }}</span>
        <span class="ct-grow"></span>
        <button class="ct-mini" :disabled="i === 0" title="上移" :data-test="`custom-up-${i}`" @click="move(i, -1)">↑</button>
        <button class="ct-mini" :disabled="i === steps.length - 1" title="下移" :data-test="`custom-down-${i}`" @click="move(i, 1)">↓</button>
        <button class="ct-mini ct-del" title="删除这一步" :data-test="`custom-del-${i}`" @click="removeAt(i)">✕</button>
      </div>
      <div class="ct-desc">{{ entryOf(s)?.desc }}</div>

      <div v-if="entryOf(s)?.fields.length" class="ct-fields">
        <div v-for="f in entryOf(s)?.fields || []" :key="f.key" class="ct-field">
          <span class="ct-flabel">
            {{ f.label }}<em v-if="f.required" class="ct-req">必填</em>
          </span>

          <label v-if="f.kind === 'boolean'" class="ct-check">
            <input
              type="checkbox"
              :checked="!!s.input[f.key]"
              :data-test="`custom-f-${i}-${f.key}`"
              @change="setField(i, f.key, ($event.target as HTMLInputElement).checked)"
            />
            <span class="row-sub">勾选启用</span>
          </label>

          <select
            v-else-if="f.kind === 'select'"
            :value="s.input[f.key] ?? ''"
            :data-test="`custom-f-${i}-${f.key}`"
            @change="setField(i, f.key, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">（未选）</option>
            <option v-for="o in f.options || []" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>

          <input
            v-else-if="f.kind === 'number'"
            type="number"
            :min="f.min"
            :max="f.max"
            :value="s.input[f.key] ?? ''"
            :placeholder="f.placeholder || (f.min !== undefined ? `${f.min} ~ ${f.max ?? '不限'}` : '')"
            :data-test="`custom-f-${i}-${f.key}`"
            @input="setField(i, f.key, ($event.target as HTMLInputElement).value)"
          />

          <!-- within：限定查找范围（选择器 与 文案+上溯 二选一） -->
          <div v-else-if="f.kind === 'within'" class="ct-within">
            <input
              type="text"
              placeholder="选择器（与下面的文案二选一）"
              :value="withinOf(s, 'selector')"
              :data-test="`custom-f-${i}-${f.key}-selector`"
              @input="setWithin(i, f.key, 'selector', ($event.target as HTMLInputElement).value)"
            />
            <div class="ct-within-row">
              <input
                type="text"
                placeholder="行标签文案"
                :value="withinOf(s, 'text')"
                :data-test="`custom-f-${i}-${f.key}-text`"
                @input="setWithin(i, f.key, 'text', ($event.target as HTMLInputElement).value)"
              />
              <input
                type="number"
                min="0"
                max="6"
                placeholder="上溯层数"
                :value="withinOf(s, 'climb')"
                :data-test="`custom-f-${i}-${f.key}-climb`"
                @input="setWithin(i, f.key, 'climb', ($event.target as HTMLInputElement).value)"
              />
            </div>
          </div>

          <input
            v-else
            type="text"
            :value="s.input[f.key] ?? ''"
            :placeholder="f.placeholder || ''"
            :data-test="`custom-f-${i}-${f.key}`"
            @input="setField(i, f.key, ($event.target as HTMLInputElement).value)"
          />

          <span v-if="f.hint" class="row-sub">{{ f.hint }}</span>
        </div>
      </div>

      <!-- 提交动作标记：这是开放步骤编辑器的安全前提，只有副作用步骤才出现 -->
      <label v-if="entryOf(s)?.sideEffect" class="ct-submit">
        <input
          type="checkbox"
          :checked="!!s.submit"
          :data-test="`custom-submit-${i}`"
          @change="setSubmit(i, ($event.target as HTMLInputElement).checked)"
        />
        <span>这一步是<b>提交动作</b>（发出后不可撤销）→ 系统会要求它前面有一道人工确认门禁</span>
      </label>
    </div>

    <div class="ct-add">
      <select v-model="addType" data-test="custom-add-type">
        <option value="">添加步骤…</option>
        <optgroup v-for="g in groups" :key="g" :label="g">
          <option v-for="e in entriesOf(g)" :key="e.type" :value="e.type">{{ e.label }}</option>
        </optgroup>
      </select>
      <button class="ct-addbtn" :disabled="!addType" data-test="custom-add" @click="add">添加</button>
    </div>

    <div v-if="issues.length" class="ct-issues" data-test="custom-issues">
      <div v-for="(is, k) in issues" :key="k" :class="['ct-issue', is.level]">
        <b>{{ is.level === 'error' ? '✕' : '!' }}</b> {{ is.message }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 自定义任务的步骤编排器。
 *
 * 【它存在的理由与它必须防住的事】
 * 「新建任务」原先刻意不给步骤编辑器，因为让用户自己拼步骤必然拼出跑不通的半成品。
 * 这个组件要开放那个能力，就必须把当初那条理由逐条堵上：
 *   - 参数不再手写 JSON，而是**按目录渲染表单**（字段名与主进程 Zod 一一对应，
 *     有单测钉住不许漂移）→ 拼不出 schema 之外的键；
 *   - 每一步都显示中文标签、分组与"这步做什么"→ 用户知道自己在拼什么；
 *   - 副作用步骤要求用户**显式标记"提交动作"**，校验强制它前面有确认门禁
 *     → 不会拼出"无人值守直接发出不可撤销操作"的任务。
 *
 * 校验结果由父组件传入（父组件要用它决定"创建"按钮是否可点），
 * 这里只负责展示——避免两处各算一遍导致"显示能点、点了却被拒"。
 */
import { ref } from 'vue'
import {
  STEP_CATALOG, catalogGroups, findCatalogEntry, makeDraftStep,
  type CustomStepDraft, type CustomStepIssue
} from '@shared/custom-task'

const props = defineProps<{
  steps: CustomStepDraft[]
  issues: CustomStepIssue[]
}>()

const emit = defineEmits<{ (e: 'update:steps', v: CustomStepDraft[]): void }>()

const groups = catalogGroups()
const addType = ref('')

function entriesOf(group: string) {
  return STEP_CATALOG.filter(e => e.group === group)
}
function entryOf(s: CustomStepDraft) {
  return findCatalogEntry(s.type)
}

/** 每次都产出新数组再 emit：父组件持有的是 ref，原地改不会触发重渲染 */
function commit(next: CustomStepDraft[]) {
  emit('update:steps', next)
}

function setField(i: number, key: string, value: unknown) {
  const next = props.steps.map((s, k) => (k === i ? { ...s, input: { ...s.input, [key]: value } } : s))
  commit(next)
}

function setSubmit(i: number, on: boolean) {
  commit(props.steps.map((s, k) => (k === i ? { ...s, submit: on } : s)))
}

/**
 * within 的子字段写入。
 * 关键点：选择器与文案是**互斥**的（Zod 有 refine 二选一）。填了其中一个就清掉另一个，
 * 而不是两个都留着让校验去报错——用户意图很明确（刚填的那个），留着旧的只会让表单看起来"填好了"却被拒。
 */
function setWithin(i: number, key: string, sub: 'selector' | 'text' | 'climb', value: string) {
  const s = props.steps[i]
  const cur = { ...((s.input[key] as Record<string, unknown>) || {}) }
  if (sub === 'selector') {
    delete cur.text
    delete cur.climb
    if (value) cur.selector = value
    else delete cur.selector
  } else if (sub === 'text') {
    delete cur.selector
    if (value) cur.text = value
    else { delete cur.text; delete cur.climb }
  } else {
    if (value === '') delete cur.climb
    else cur.climb = Number(value)
  }
  const input = { ...s.input, [key]: cur }
  if (!Object.keys(cur).length) delete input[key]
  commit(props.steps.map((x, k) => (k === i ? { ...s, input } : x)))
}

function withinOf(s: CustomStepDraft, sub: string): string {
  const w = (s.input.within as Record<string, unknown>) || {}
  const v = w[sub]
  return v === undefined || v === null ? '' : String(v)
}

function add() {
  if (!addType.value) return
  commit([...props.steps, makeDraftStep(addType.value)])
  addType.value = ''
}

function removeAt(i: number) {
  commit(props.steps.filter((_, k) => k !== i))
}

function move(i: number, delta: number) {
  const j = i + delta
  if (j < 0 || j >= props.steps.length) return
  const next = props.steps.slice()
  const [item] = next.splice(i, 1)
  next.splice(j, 0, item)
  commit(next)
}
</script>

<style scoped>
.ct-editor { display: flex; flex-direction: column; gap: 10px; }
.ct-bar { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.ct-count { font-size: 13px; color: var(--color-text-primary); }
.ct-empty {
  padding: 14px; font-size: 12px; color: var(--color-text-secondary);
  background: var(--color-bg-tertiary); border: 1px dashed var(--color-border); border-radius: var(--radius-sm);
}
.ct-step {
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary); padding: 10px;
}
.ct-step-head { display: flex; align-items: center; gap: 8px; }
.ct-idx {
  width: 20px; height: 20px; flex: 0 0 auto; border-radius: 50%;
  background: var(--color-primary); color: #fff; font-size: 11px;
  display: inline-flex; align-items: center; justify-content: center;
}
.ct-label { font-size: 13px; color: #fff; }
.ct-group {
  font-size: 10px; color: var(--color-text-secondary);
  border: 1px solid var(--color-border); border-radius: 3px; padding: 0 4px;
}
.ct-grow { flex: 1 1 auto; }
.ct-mini {
  width: 22px; height: 22px; font-size: 12px; line-height: 1;
  color: var(--color-text-secondary); border: 1px solid var(--color-border);
  border-radius: 4px; background: var(--color-bg-secondary);
}
.ct-mini:hover:not(:disabled) { color: #fff; border-color: var(--color-primary); }
.ct-mini:disabled { opacity: .35; cursor: not-allowed; }
.ct-del:hover:not(:disabled) { color: #fff; border-color: var(--color-error); background: rgba(239, 68, 68, .18); }
.ct-desc { font-size: 11px; color: var(--color-text-secondary); margin: 6px 0 8px 28px; }
.ct-fields { display: flex; flex-direction: column; gap: 8px; margin-left: 28px; }
.ct-field { display: flex; flex-direction: column; gap: 3px; }
.ct-flabel { font-size: 11px; color: var(--color-text-secondary); }
.ct-req { font-style: normal; color: var(--color-warning); margin-left: 4px; font-size: 10px; }
.ct-field input[type="text"], .ct-field input[type="number"], .ct-field select, .ct-within input {
  width: 100%; padding: 5px 8px; font-size: 12px; font-family: inherit;
  color: var(--color-text-primary); background: var(--color-bg-secondary);
  border: 1px solid var(--color-border); border-radius: 4px;
}
.ct-field input:focus, .ct-field select:focus, .ct-within input:focus { outline: none; border-color: var(--color-primary); }
.ct-check { display: flex; align-items: center; gap: 6px; }
.ct-within { display: flex; flex-direction: column; gap: 5px; }
.ct-within-row { display: flex; gap: 5px; }
.ct-within-row input:first-child { flex: 1 1 auto; }
.ct-within-row input:last-child { flex: 0 0 92px; }
.ct-submit {
  display: flex; align-items: flex-start; gap: 6px; margin: 9px 0 0 28px;
  font-size: 11px; color: var(--color-warning); cursor: pointer;
}
.ct-submit input { margin-top: 1px; }
.ct-submit b { color: #fff; }
.ct-add { display: flex; gap: 6px; }
.ct-add select {
  flex: 1 1 auto; padding: 6px 8px; font-size: 12px; font-family: inherit;
  color: var(--color-text-primary); background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
}
.ct-addbtn {
  padding: 6px 14px; font-size: 12px; border-radius: var(--radius-sm);
  color: #fff; background: var(--color-primary);
}
.ct-addbtn:disabled { opacity: .4; cursor: not-allowed; }
.ct-issues { display: flex; flex-direction: column; gap: 5px; }
.ct-issue {
  font-size: 11px; line-height: 1.55; padding: 6px 8px;
  border-radius: 4px; border: 1px solid transparent;
}
.ct-issue.error { color: #fca5a5; background: rgba(239, 68, 68, .12); border-color: rgba(239, 68, 68, .35); }
.ct-issue.warning { color: #fcd34d; background: rgba(245, 158, 11, .1); border-color: rgba(245, 158, 11, .3); }
</style>
