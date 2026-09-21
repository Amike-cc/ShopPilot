<template>
  <div class="ct-editor" data-test="custom-editor">
    <!-- 左栏：步骤目录。常驻列表而不是下拉框——加步骤是编排里最高频的动作，
         藏进下拉每次都要点开再找，真机验收时就因为下拉弹层点偏过两次。

         筛选框是必须的：目录共 22 项、分 6 组，栏内可视高度装不下（实测 748px 内容 / 356px 可视），
         而**没有任何提示说明还能往下滚**——实测反馈就是"点击元素怎么添加"（它在折叠线以下）。
         加筛选后任何一步都能两步定位，也不再依赖窗口高度。 -->
    <section class="ct-col ct-palette">
      <div class="ct-col-h">
        <span>步骤目录</span>
        <span class="row-sub">{{ filteredTotal }} 项</span>
      </div>
      <input
        v-model="paletteQuery"
        class="ct-filter"
        type="text"
        placeholder="筛选步骤…"
        data-test="custom-step-filter"
      />
      <div class="ct-palette-body">
        <div v-if="!filteredGroups.length" class="ct-empty">没有匹配的步骤</div>
        <div v-for="g in filteredGroups" :key="g.name" class="ct-group">
          <div class="ct-group-h">{{ g.name }}</div>
          <button
            v-for="e in g.entries"
            :key="e.type"
            class="ct-pal-item"
            :title="e.desc"
            :data-test="`custom-palette-${e.type}`"
            @click="add(e.type)"
          >{{ e.label }}</button>
        </div>
      </div>
    </section>

    <!-- 中栏：已编排的步骤序列 -->
    <section class="ct-col ct-seq">
      <div class="ct-col-h">
        <span data-test="custom-step-count">共 {{ steps.length }} 步</span>
        <span class="row-sub">点一步编辑它的参数</span>
      </div>
      <div class="ct-seq-body">
        <div v-if="!steps.length" class="ct-empty" data-test="custom-empty">
          还没有步骤。从左侧目录点一个开始——建议第一步先「打开网址」，
          否则任务会从店铺当前停留的页面开始跑。
        </div>
        <div
          v-for="(s, i) in steps"
          :key="i"
          :class="['ct-step', { on: i === selected }]"
          :data-test="`custom-step-${i}`"
          @click="selected = i"
        >
          <span class="ct-idx">{{ i + 1 }}</span>
          <span class="ct-step-main">
            <span class="ct-step-t">
              {{ entryOf(s)?.label || s.type }}
              <em v-if="s.submit" class="ct-tag-submit" title="已标记为提交动作">提交</em>
            </span>
            <span class="ct-step-s">{{ summarize(s) }}</span>
          </span>
          <span class="ct-step-btns">
            <button class="ct-mini" :disabled="i === 0" title="上移" :data-test="`custom-up-${i}`" @click.stop="move(i, -1)">↑</button>
            <button class="ct-mini" :disabled="i === steps.length - 1" title="下移" :data-test="`custom-down-${i}`" @click.stop="move(i, 1)">↓</button>
            <button class="ct-mini ct-del" title="删除这一步" :data-test="`custom-del-${i}`" @click.stop="removeAt(i)">✕</button>
          </span>
        </div>
      </div>
    </section>

    <!-- 右栏：选中步骤的参数 + 整单校验 -->
    <section class="ct-col ct-params">
      <div class="ct-col-h">
        <span>参数</span>
        <span v-if="curStep" class="row-sub">{{ entryOf(curStep)?.group }}</span>
      </div>
      <div class="ct-params-body">
        <div v-if="!curStep" class="ct-empty">
          从左侧添加步骤，或在中栏点一步，这里显示它的参数。
        </div>
        <template v-else>
          <div class="ct-params-title">{{ entryOf(curStep)?.label || curStep.type }}</div>
          <div class="ct-desc">{{ entryOf(curStep)?.desc }}</div>

          <div v-if="!entryOf(curStep)?.fields.length" class="ct-empty">这一步没有参数。</div>
          <div v-else class="ct-fields">
            <!-- 拾取按钮存在时先说明它怎么用。不写这一句的话，用户看到「拾取」
                 会以为是"在页面上找已经填好的东西"，而实际是"对话框会先收起、
                 你去点一下目标元素、我替你填回来"。 -->
            <div v-if="hasPickableField" class="ct-pick-hint" data-test="custom-pick-hint">
              点字段旁的<b>拾取</b> → 编排器保留在右侧 → 在左侧店铺页面上点目标元素 →
              自动填回来（按 Esc 取消）
            </div>
            <div v-for="f in entryOf(curStep)?.fields || []" :key="f.key" class="ct-field">
              <span class="ct-flabel">
                {{ f.label }}<em v-if="f.required" class="ct-req">必填</em>
              </span>

              <label v-if="f.kind === 'boolean'" class="ct-check">
                <input
                  type="checkbox"
                  :checked="!!curStep.input[f.key]"
                  :data-test="`custom-f-${selected}-${f.key}`"
                  @change="setField(selected, f.key, ($event.target as HTMLInputElement).checked)"
                />
                <span class="row-sub">勾选启用</span>
              </label>

              <select
                v-else-if="f.kind === 'select'"
                :value="curStep.input[f.key] ?? ''"
                :data-test="`custom-f-${selected}-${f.key}`"
                @change="setField(selected, f.key, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">（未选）</option>
                <option v-for="o in f.options || []" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>

              <input
                v-else-if="f.kind === 'number'"
                type="number"
                :min="f.min"
                :max="f.max"
                :value="curStep.input[f.key] ?? ''"
                :placeholder="f.placeholder || (f.min !== undefined ? `${f.min} ~ ${f.max ?? '不限'}` : '')"
                :data-test="`custom-f-${selected}-${f.key}`"
                @input="setField(selected, f.key, ($event.target as HTMLInputElement).value === '' ? '' : Number(($event.target as HTMLInputElement).value))"
              />

              <!-- within：限定查找范围（选择器 与 文案+上溯 二选一） -->
              <div v-else-if="f.kind === 'within'" class="ct-within">
                <!-- within 的两个分支也都是"页面上的锚点"，所以也能拾取。
                     点行内任意位置会取回**整行**（表格行/列表项）的锚点——这正是 within 要的东西，
                     点按钮本身反而取到的是按钮。 -->
                <div class="ct-pick-row">
                  <input
                    type="text"
                    placeholder="选择器（与下面的文案二选一）"
                    :value="withinOf(curStep, 'selector')"
                    :data-test="`custom-f-${selected}-${f.key}-selector`"
                    @input="setWithin(selected, f.key, 'selector', ($event.target as HTMLInputElement).value)"
                  />
                  <button
                    class="ct-pick"
                    type="button"
                    :disabled="picking"
                    title="到店铺页面上点一下：取该行（表格行/列表项）的选择器"
                    :data-test="`custom-pick-${selected}-${f.key}-selector`"
                    @click="pick(selected, f.key, 'selector', 'selector')"
                  >拾取</button>
                </div>
                <div class="ct-within-row">
                  <div class="ct-pick-row">
                    <input
                      type="text"
                      placeholder="行标签文案"
                      :value="withinOf(curStep, 'text')"
                      :data-test="`custom-f-${selected}-${f.key}-text`"
                      @input="setWithin(selected, f.key, 'text', ($event.target as HTMLInputElement).value)"
                    />
                    <button
                      class="ct-pick"
                      type="button"
                      :disabled="picking"
                      title="到店铺页面上点一下：取该行的整行文案"
                      :data-test="`custom-pick-${selected}-${f.key}-text`"
                      @click="pick(selected, f.key, 'text', 'text')"
                    >拾取</button>
                  </div>
                  <input
                    type="number"
                    min="0"
                    max="6"
                    placeholder="上溯"
                    :value="withinOf(curStep, 'climb')"
                    :data-test="`custom-f-${selected}-${f.key}-climb`"
                    @input="setWithin(selected, f.key, 'climb', ($event.target as HTMLInputElement).value)"
                  />
                </div>
              </div>

              <!-- 文本字段：指向页面元素的那些（f.pick）旁边给一个「拾取」按钮。
                   这是自定义任务最大的摩擦点——此前只能右键采一次、再去开 DevTools 抄，
                   而新建任务对话框一打开页面就被原生视图摘掉了，根本没法边建边看。 -->
              <div v-else-if="f.pick" class="ct-pick-row">
                <input
                  type="text"
                  :value="curStep.input[f.key] ?? ''"
                  :placeholder="f.placeholder || ''"
                  :data-test="`custom-f-${selected}-${f.key}`"
                  @input="setField(selected, f.key, ($event.target as HTMLInputElement).value)"
                />
                <button
                  class="ct-pick"
                  type="button"
                  :disabled="picking"
                  :title="f.pick === 'text' ? '到店铺页面上点一下：取该元素的文案' : '到店铺页面上点一下：取该元素的选择器'"
                  :data-test="`custom-pick-${selected}-${f.key}`"
                  @click="pick(selected, f.key, f.pick)"
                >拾取</button>
              </div>

              <input
                v-else
                type="text"
                :value="curStep.input[f.key] ?? ''"
                :placeholder="f.placeholder || ''"
                :data-test="`custom-f-${selected}-${f.key}`"
                @input="setField(selected, f.key, ($event.target as HTMLInputElement).value)"
              />

              <span v-if="f.hint" class="row-sub">{{ f.hint }}</span>
            </div>
          </div>

          <!-- 提交动作标记：这是开放步骤编辑器的安全前提，只有副作用步骤才出现 -->
          <label v-if="entryOf(curStep)?.sideEffect" class="ct-submit">
            <input
              type="checkbox"
              :checked="!!curStep.submit"
              :data-test="`custom-submit-${selected}`"
              @change="setSubmit(selected, ($event.target as HTMLInputElement).checked)"
            />
            <span>这一步是<b>提交动作</b>（发出后不可撤销）→ 系统会要求它前面有一道人工确认门禁</span>
          </label>
        </template>
      </div>

      <!-- 校验固定为右栏页脚（不随参数滚动）。
           它解释的是"为什么创建按钮是灰的"，参数一多若被挤出视野，用户就只看到按钮点不动、
           不知道去哪儿改——这是从单列改成三栏时最容易丢掉的可用性。 -->
      <div v-if="issues.length" class="ct-issues" data-test="custom-issues">
        <div v-for="(is, k) in issues" :key="k" :class="['ct-issue', is.level]">
          <b>{{ is.level === 'error' ? '✕' : '!' }}</b> {{ is.message }}
        </div>
      </div>
      <div v-else-if="steps.length" class="ct-ok" data-test="custom-ok">✓ 校验通过，可以创建</div>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 自定义任务的步骤编排器（三栏：目录 / 序列 / 参数）。
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
 * 【为什么是三栏】
 * 加步骤、排顺序、改参数是三件**互相独立**的事，单列纵向堆叠时它们挤在一起：
 * 步骤一多就要滚动，改中间某一步的参数得先滚到它；加步骤还得点开下拉再找（真机验收时
 * 下拉弹层就点偏过两次）。拆成三栏后：左边常驻目录（点即加）、中间看全局顺序、右边只渲染
 * **选中那一步**的参数——三件事各占一块，互不遮挡。
 *
 * 校验结果由父组件传入（父组件要用它决定"创建"按钮是否可点），
 * 这里只负责展示——避免两处各算一遍导致"显示能点、点了却被拒"。
 */
import { computed, ref, watch } from 'vue'
import {
  STEP_CATALOG, catalogGroups, findCatalogEntry, makeDraftStep,
  WITHIN_LIMITS,
  type CustomStepDraft, type CustomStepIssue
} from '@shared/custom-task'
import { describePickResult, type ElementPickResult, type PickMode } from '@shared/element-pick'

const props = defineProps<{
  steps: CustomStepDraft[]
  issues: CustomStepIssue[]
  /**
   * 发起一次拾取：父组件切到 picker-mode（编排器贴右、浏览器视图让出右侧 560px）
   * → 调 IPC 在页面内挂拾取层 → 返回锚点。
   *
   * 为什么由父组件做：拾取要改的是 workbench 级布局（对话框位置、原生视图显隐、
   * 遮挡状态），而"对话框开没开/选中第几步"是父组件的状态。编辑器只管"填到哪个字段"。
   */
  pickElement: (mode: PickMode) => Promise<ElementPickResult>
}>()

const emit = defineEmits<{
  (e: 'update:steps', v: CustomStepDraft[]): void
  (e: 'notify', text: string, kind: 'info' | 'success' | 'error'): void
}>()

const groups = catalogGroups()

/** 目录筛选关键词（按步骤名或分组名匹配——输「交互」也能把整组带出来） */
const paletteQuery = ref('')

/**
 * 筛选后的目录。空关键词时就是完整目录（顺序与分组沿用 STEP_CATALOG）。
 * 同时匹配分组名：用户往往记得"它在交互那一组"而不是准确步骤名。
 */
const filteredGroups = computed(() => {
  const q = paletteQuery.value.trim().toLowerCase()
  const out: Array<{ name: string; entries: typeof STEP_CATALOG }> = []
  for (const name of groups) {
    const all = STEP_CATALOG.filter(e => e.group === name)
    const hit = !q
      ? all
      : all.filter(e => e.label.toLowerCase().includes(q) || e.type.toLowerCase().includes(q))
    if (!hit.length) continue
    // 分组名本身命中时，把该组整组给出（用户想看"交互里有什么"）
    const groupHit = !!q && name.toLowerCase().includes(q)
    out.push({ name, entries: (groupHit ? all : hit) as typeof STEP_CATALOG })
  }
  return out
})

/** 当前筛选结果里的步骤总数（给左栏表头显示） */
const filteredTotal = computed(() => filteredGroups.value.reduce((n, g) => n + g.entries.length, 0))

/**
 * 当前编辑的是第几步（右栏参数只渲染它）。
 *
 * 由父组件持有（v-model:selected）：拾取期间编辑器实例靠 v-if 条件保留，
 * 一旦条件写错导致卸载，子组件局部状态会清零。若选中项跟着归零，用户在**第 7 步**点拾取、
 * 回来却看到第 1 步的参数，会以为"我填的东西没了"。所以选中项必须由父组件持有、活过拾取。
 */
const selected = defineModel<number>('selected', { default: 0 })

/** 拾取进行中：期间按钮置灰，避免连点两次叠加两次让位 */
const picking = ref(false)

const curStep = computed<CustomStepDraft | null>(() => props.steps[selected.value] || null)

/** 当前这一步是否有可拾取的字段（有才显示那句用法说明） */
const hasPickableField = computed(() => {
  const e = curStep.value ? entryOf(curStep.value) : null
  return !!e && e.fields.some(f => !!f.pick || f.kind === 'within')
})

// 步骤数变少（删除）时把选中项夹回范围内，否则右栏会空白且参数写到一个不存在的下标上
watch(() => props.steps.length, (n) => {
  if (n === 0) selected.value = 0
  else if (selected.value > n - 1) selected.value = n - 1
})

function entryOf(s: CustomStepDraft) {
  return findCatalogEntry(s.type)
}

/** 中栏的一行摘要：显示"这一步最关键的那个参数"，让不点开也能认出是哪一步 */
function summarize(s: CustomStepDraft): string {
  const e = entryOf(s)
  if (!e) return s.type
  for (const key of ['url', 'text', 'selector', 'label', 'textIncludes', 'message', 'urlIncludes', 'path', 'ms']) {
    const v = s.input?.[key]
    if (v !== undefined && v !== null && v !== '') return `${key}: ${String(v).slice(0, 40)}`
  }
  return e.desc
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

/**
 * 拾取一个锚点填进字段。
 *
 * 三种目标：普通选择器字段 / 普通文案字段 / within 的两个子字段。
 * within 与其他不同：它要的是**整行**的锚点（表格行、列表项），所以优先取结果里的
 * rowSelector / rowText，取不到才退回元素自身——用户点的往往是行内的按钮，
 * 直接取按钮的选择器当"查找范围"会得到只有一个按钮那么大的范围，等于限定死了。
 */
async function pick(
  stepIndex: number,
  key: string,
  mode: PickMode,
  sub?: 'selector' | 'text'
) {
  if (picking.value) return
  picking.value = true
  try {
    const r = await props.pickElement(mode)
    if (!r || !r.ok) return  // 父组件已经提示过原因（取消/超时/注入失败）
    if (sub) {
      const wanted = sub === 'selector'
        ? (r.rowSelector || r.selector || '')
        : (r.rowText || r.text || '')
      const limit = sub === 'selector' ? WITHIN_LIMITS.selector : WITHIN_LIMITS.text
      if (!wanted) {
        emit('notify', sub === 'selector'
          ? '这个元素取不到可用于"限定范围"的选择器，请点它所在的那一行'
          : '这个元素取不到文字，请点它所在的那一行', 'error')
        return
      }
      if (wanted.length > limit) {
        // 截断会得到一个永远匹配不上的锚点，比不填更糟——如实说明并让用户换目标
        emit('notify', `这一行的${sub === 'selector' ? '选择器' : '文案'}太长（${wanted.length} 字，上限 ${limit}）` +
          '，请点更靠近目标的那一行', 'error')
        return
      }
      setWithin(stepIndex, key, sub, wanted)
      emit('notify', describePickResult(r, mode), 'success')
      return
    }

    const value = mode === 'text' ? (r.text || '') : (r.selector || '')
    const f = entryOf(props.steps[stepIndex])?.fields.find(x => x.key === key)
    if (!value) {
      emit('notify', '这个元素取不到可用锚点，换个目标再试', 'error')
      return
    }
    if (f?.maxLength !== undefined && value.length > f.maxLength) {
      emit('notify', `拾取到的长度 ${value.length} 字超过该字段上限 ${f.maxLength}，` +
        '请点更具体的目标元素（越小越准）', 'error')
      return
    }
    setField(stepIndex, key, value)
    emit('notify', describePickResult(r, mode), 'success')
  } catch (e: any) {
    emit('notify', '拾取失败：' + String(e?.message || e), 'error')
  } finally {
    picking.value = false
  }
}

/** 添加并选中它——加完紧接着就要填参数，不选中等于让用户再点一次 */
function add(type: string) {
  commit([...props.steps, makeDraftStep(type)])
  selected.value = props.steps.length
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
  // 跟着被移动的那一步走：移动后用户想继续编辑的仍是同一步，不是同一个位置
  if (selected.value === i) selected.value = j
  else if (selected.value === j) selected.value = i
}
</script>

<style scoped>
/* 三栏：目录定宽 / 序列自适应 / 参数定宽。
   min-height 让空态也有稳定的框，不至于三栏高低参差。 */
.ct-editor {
  display: grid;
  /* 左栏 176：目录条目名最长 9 个汉字（「切到已打开的标签页」），156 会折行 */
  grid-template-columns: 176px minmax(190px, 1fr) 262px;
  gap: 10px;
  align-items: stretch;
  /* 撑满父容器给的剩余高度（对话框是 flex 列，只有这一块伸缩），
     再由各栏自己的 overflow 吸收超出——这样「创建任务」按钮与校验始终留在视野里。 */
  flex: 1 1 auto;
  min-height: 260px;
}
.ct-col {
  display: flex; flex-direction: column; min-width: 0; min-height: 0;
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary); overflow: hidden;
}
.ct-col-h {
  display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
  padding: 7px 9px; border-bottom: 1px solid var(--color-border);
  font-size: 12px; color: var(--color-text-primary); background: var(--color-bg-secondary);
}
.ct-col-h .row-sub { font-size: 10px; }
.ct-palette-body, .ct-seq-body, .ct-params-body {
  flex: 1 1 auto; overflow-y: auto; padding: 7px; min-height: 0;
}
.ct-params-body { display: flex; flex-direction: column; gap: 8px; }

/* ---------- 左栏：目录 ---------- */
/* 筛选框钉在目录上方（不随列表滚动）：找不到某一步时它是最快的出路 */
.ct-filter {
  flex: 0 0 auto; margin: 6px 7px 0; padding: 4px 7px; font-size: 11px; font-family: inherit;
  color: var(--color-text-primary); background: var(--color-bg-secondary);
  border: 1px solid var(--color-border); border-radius: 4px;
}
.ct-filter:focus { outline: none; border-color: var(--color-primary); }
.ct-group + .ct-group { margin-top: 6px; }
.ct-group-h {
  font-size: 10px; color: var(--color-text-muted); padding: 1px 2px 2px;
  border-bottom: 1px dashed var(--color-border); margin-bottom: 2px;
}
/* 条目压紧：目录共 22 项，栏内高度有限，能多露出一项就少一次滚动 */
.ct-pal-item {
  display: block; width: 100%; text-align: left; font-size: 11px; line-height: 1.35;
  padding: 3px 6px; border-radius: 4px; color: var(--color-text-secondary);
  border: 1px solid transparent; background: none;
}
.ct-pal-item:hover { color: #fff; background: var(--color-bg-secondary); border-color: var(--color-primary); }

/* ---------- 中栏：序列 ---------- */
.ct-step {
  display: flex; align-items: flex-start; gap: 6px; padding: 6px 7px;
  border: 1px solid var(--color-border); border-radius: 4px;
  background: var(--color-bg-secondary); cursor: pointer;
}
.ct-step + .ct-step { margin-top: 5px; }
.ct-step.on { border-color: var(--color-primary); background: var(--color-bg-elevated); }
.ct-idx {
  width: 18px; height: 18px; flex: 0 0 auto; border-radius: 50%;
  background: var(--color-primary); color: #fff; font-size: 10px;
  display: inline-flex; align-items: center; justify-content: center; margin-top: 1px;
}
.ct-step-main { flex: 1 1 auto; min-width: 0; }
.ct-step-t { display: block; font-size: 12px; color: #fff; }
.ct-step-s {
  display: block; font-size: 10px; color: var(--color-text-muted); margin-top: 1px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ct-tag-submit {
  font-style: normal; font-size: 9px; color: var(--color-warning);
  border: 1px solid var(--color-warning); border-radius: 3px; padding: 0 3px; margin-left: 4px;
}
.ct-step-btns { display: flex; gap: 3px; flex: 0 0 auto; }
.ct-mini {
  width: 20px; height: 20px; font-size: 11px; line-height: 1;
  color: var(--color-text-secondary); border: 1px solid var(--color-border);
  border-radius: 4px; background: var(--color-bg-tertiary);
}
.ct-mini:hover:not(:disabled) { color: #fff; border-color: var(--color-primary); }
.ct-mini:disabled { opacity: .35; cursor: not-allowed; }
.ct-del:hover:not(:disabled) { color: #fff; border-color: var(--color-error); background: rgba(239, 68, 68, .18); }

/* ---------- 右栏：参数 ---------- */
.ct-params-title { font-size: 12px; color: #fff; }
.ct-desc { font-size: 10px; color: var(--color-text-secondary); line-height: 1.5; }
.ct-fields { display: flex; flex-direction: column; gap: 8px; }
.ct-pick-hint {
  font-size: 10px; line-height: 1.55; color: var(--color-text-secondary);
  padding: 6px 7px; border: 1px dashed var(--color-border); border-radius: 4px;
}
.ct-pick-hint b { color: var(--color-primary); }
.ct-field { display: flex; flex-direction: column; gap: 3px; }
.ct-flabel { font-size: 11px; color: var(--color-text-secondary); }
.ct-req { font-style: normal; color: var(--color-warning); margin-left: 4px; font-size: 10px; }
.ct-field input[type="text"], .ct-field input[type="number"], .ct-field select, .ct-within input {
  width: 100%; padding: 5px 8px; font-size: 12px; font-family: inherit; box-sizing: border-box;
  color: var(--color-text-primary); background: var(--color-bg-secondary);
  border: 1px solid var(--color-border); border-radius: 4px;
}
.ct-field input:focus, .ct-field select:focus, .ct-within input:focus { outline: none; border-color: var(--color-primary); }
.ct-check { display: flex; align-items: center; gap: 6px; }
/* 输入框 + 拾取按钮同一行：按钮必须贴着它要填的输入框，
   参数一多、按钮飘远就会出现"点了拾取却不知道填到哪一格"。 */
.ct-pick-row { display: flex; gap: 5px; align-items: stretch; }
.ct-pick-row input { flex: 1 1 0; width: auto; min-width: 0; }
.ct-pick {
  flex: 0 0 auto; padding: 0 9px; font-size: 11px; font-family: inherit; white-space: nowrap;
  color: var(--color-text-primary); background: var(--color-bg-elevated);
  border: 1px solid var(--color-primary); border-radius: 4px;
}
.ct-pick:hover { color: #fff; background: var(--color-primary); }
.ct-pick:disabled { opacity: .45; cursor: not-allowed; border-color: var(--color-border); }
.ct-within { display: flex; flex-direction: column; gap: 5px; }
.ct-within-row { display: flex; gap: 5px; }
.ct-within-row > .ct-pick-row { flex: 1 1 0; min-width: 0; }
.ct-within-row > input { flex: 0 0 76px; }
.ct-submit {
  display: flex; align-items: flex-start; gap: 6px;
  font-size: 10px; color: var(--color-warning); cursor: pointer; line-height: 1.5;
}
.ct-submit input { margin-top: 2px; flex: 0 0 auto; }
.ct-submit b { color: #fff; }

/* ---------- 空态与校验 ---------- */
.ct-empty {
  font-size: 11px; color: var(--color-text-secondary); line-height: 1.6;
  padding: 8px; border: 1px dashed var(--color-border); border-radius: 4px;
}
.ct-issues {
  display: flex; flex-direction: column; gap: 5px; flex: 0 0 auto;
  max-height: 40%; overflow-y: auto;
  padding: 7px; border-top: 1px solid var(--color-border); background: var(--color-bg-secondary);
}
.ct-issue {
  font-size: 10px; line-height: 1.55; padding: 6px 7px;
  border-radius: 4px; border: 1px solid transparent;
}
.ct-issue.error { color: #fca5a5; background: rgba(239, 68, 68, .12); border-color: rgba(239, 68, 68, .35); }
.ct-issue.warning { color: #fcd34d; background: rgba(245, 158, 11, .1); border-color: rgba(245, 158, 11, .3); }
.ct-ok {
  flex: 0 0 auto; font-size: 10px; color: var(--color-success);
  padding: 7px; border-top: 1px solid var(--color-border); background: var(--color-bg-secondary);
}
</style>
