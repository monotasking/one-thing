<template>
  <!-- 描述树的渲染器。**UI 永不执行插件代码** —— 插件交出的是纯数据,
       这里全部用宿主自己的原语画出来(窄腰在 UI 侧的落地)。 -->
  <div
    v-if="node.type === 'stack'"
    class="panel-stack"
    :class="`gap-${node.gap || 'medium'}`"
  >
    <PluginPanelNode
      v-for="(child, index) in node.children"
      :key="index"
      :node="child"
      :plugin-id="pluginId"
      @action="emit('action', $event)"
    />
  </div>

  <div
    v-else-if="node.type === 'row'"
    class="panel-row"
  >
    <PluginPanelNode
      v-for="(child, index) in node.children"
      :key="index"
      :node="child"
      :plugin-id="pluginId"
      @action="emit('action', $event)"
    />
  </div>

  <section
    v-else-if="node.type === 'list'"
    class="panel-list"
  >
    <h4
      v-if="node.title"
      class="panel-list-title"
    >
      {{ node.title }}
    </h4>
    <p
      v-if="!node.items.length"
      class="panel-list-empty"
    >
      {{ node.emptyText || 'Nothing here yet.' }}
    </p>
    <!-- 进出场过渡是**宿主给的**(B 期 B2):描述树里没有动画表达,插件只换数据。 -->
    <TransitionGroup
      v-else
      tag="ul"
      name="panel-list-item"
      class="panel-list-items"
    >
      <li
        v-for="item in node.items"
        :key="item.id"
        class="panel-list-item"
        :class="{ 'is-clickable': Boolean(item.actionId) }"
      >
        <component
          :is="item.actionId ? 'button' : 'div'"
          class="panel-list-row"
          :type="item.actionId ? 'button' : undefined"
          @click="item.actionId && emit('action', { actionId: item.actionId, payload: item.payload })"
        >
          <span class="panel-list-main">
            <span class="panel-list-item-title">{{ item.title }}</span>
            <span
              v-if="item.subtitle"
              class="panel-list-item-subtitle"
            >{{ item.subtitle }}</span>
          </span>
          <span
            v-if="item.badge"
            class="panel-list-badge"
          >{{ item.badge }}</span>
        </component>
      </li>
    </TransitionGroup>
  </section>

  <!-- markdown:插件给的是**文本**,不是 HTML —— 渲染由宿主做。 -->
  <div
    v-else-if="node.type === 'markdown'"
    class="panel-markdown"
  >
    <MessageMarkdown
      :content="node.text"
      :is-user="false"
      :live="false"
      :is-streaming="false"
    />
  </div>

  <Button
    v-else-if="node.type === 'button'"
    unstyled
    class="panel-button"
    :class="{ 'is-danger': node.variant === 'danger' }"
    :disabled="node.disabled"
    @click="emit('action', { actionId: node.actionId, payload: node.payload })"
  >
    {{ node.label }}
  </Button>

  <SettingsGroup
    v-else-if="node.type === 'form'"
    class="panel-form"
  >
    <SettingsField
      v-for="field in node.fields"
      :key="field.key"
      :label="field.label"
      :hint="field.hint"
    >
      <Switch
        v-if="field.control === 'switch'"
        variant="ledger"
        :model-value="Boolean(formState[field.key])"
        :aria-label="field.label"
        @update:model-value="formState[field.key] = Boolean($event)"
      />
      <InputNumber
        v-else-if="field.control === 'number'"
        :model-value="Number(formState[field.key])"
        :aria-label="field.label"
        @update:model-value="formState[field.key] = Number($event)"
      />
      <Select
        v-else-if="field.control === 'select'"
        variant="ledger"
        size="small"
        teleported
        fit-input-width
        :model-value="String(formState[field.key] ?? '')"
        :options="field.options || []"
        :aria-label="field.label"
        @update:model-value="formState[field.key] = String($event)"
      />
      <!-- v2 控件(R5.x-b)—— 与 R3 设置页同一套宿主原语 -->
      <Input
        v-else-if="field.control === 'textarea'"
        type="textarea"
        :model-value="String(formState[field.key] ?? '')"
        :aria-label="field.label"
        @update:model-value="formState[field.key] = String($event)"
      />
      <span
        v-else-if="field.control === 'slider'"
        class="panel-slider"
      >
        <input
          type="range"
          min="0"
          max="100"
          :value="Number(formState[field.key] ?? 0)"
          :aria-label="field.label"
          @input="formState[field.key] = Number(($event.target as HTMLInputElement).value)"
        >
        <span class="panel-slider-value">{{ Number(formState[field.key] ?? 0) }}</span>
      </span>
      <span
        v-else-if="field.control === 'checkbox-group'"
        class="panel-choice-group"
      >
        <label
          v-for="option in field.options || []"
          :key="option"
          class="panel-choice"
        >
          <input
            type="checkbox"
            :checked="Array.isArray(formState[field.key]) && (formState[field.key] as string[]).includes(option)"
            @change="toggleCheckbox(field.key, option, ($event.target as HTMLInputElement).checked)"
          >
          <span>{{ option }}</span>
        </label>
      </span>
      <span
        v-else-if="field.control === 'radio'"
        class="panel-choice-group"
      >
        <label
          v-for="option in field.options || []"
          :key="option"
          class="panel-choice"
        >
          <input
            type="radio"
            :name="`panel-radio-${field.key}`"
            :checked="String(formState[field.key] ?? '') === option"
            @change="formState[field.key] = option"
          >
          <span>{{ option }}</span>
        </label>
      </span>
      <input
        v-else-if="field.control === 'date'"
        type="date"
        class="panel-native-input"
        :value="String(formState[field.key] ?? '')"
        :aria-label="field.label"
        @input="formState[field.key] = ($event.target as HTMLInputElement).value"
      >
      <input
        v-else-if="field.control === 'color'"
        type="color"
        class="panel-native-input panel-color-input"
        :value="formState[field.key] === undefined ? undefined : String(formState[field.key])"
        :aria-label="field.label"
        @input="formState[field.key] = ($event.target as HTMLInputElement).value"
      >
      <!-- string-list 编辑期间只维护**原始文本**:每敲一键就 split+trim+filter
           再 join 回去是有损往返 —— 键入的逗号当场被自己吃掉,第二项永远打不
           出来。blur 时才 parse(与 R3 设置页同一配方)。 -->
      <Input
        v-else-if="field.control === 'string-list'"
        :model-value="stringListText[field.key] ?? ''"
        :aria-label="field.label"
        placeholder="Comma separated"
        @update:model-value="stringListText[field.key] = String($event)"
        @blur="commitStringList(field.key)"
      />
      <Input
        v-else
        :model-value="String(formState[field.key] ?? '')"
        :aria-label="field.label"
        @update:model-value="formState[field.key] = String($event)"
      />
    </SettingsField>
    <div
      v-if="node.submitActionId"
      class="panel-form-actions"
    >
      <Button
        unstyled
        class="panel-button"
        @click="submitForm(node.submitActionId)"
      >
        {{ node.submitLabel || 'Save' }}
      </Button>
    </div>
  </SettingsGroup>

  <!-- ── v2 节点(R5.x-b)—— 全部宿主原语,零插件代码 ── -->

  <div
    v-else-if="node.type === 'table'"
    class="panel-table-wrap"
  >
    <table class="panel-table">
      <thead>
        <tr>
          <th
            v-for="column in node.columns"
            :key="column.key"
            :style="column.width ? { width: `${column.width}px` } : undefined"
          >
            {{ column.label }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="!node.rows.length">
          <td
            class="panel-table-empty"
            :colspan="node.columns.length"
          >
            {{ node.emptyText || 'Nothing here yet.' }}
          </td>
        </tr>
        <tr
          v-for="row in node.rows"
          :key="row.key"
        >
          <td
            v-for="column in node.columns"
            :key="column.key"
          >
            {{ row.cells[column.key] ?? '' }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div
    v-else-if="node.type === 'tabs'"
    class="panel-tabs"
  >
    <div
      class="panel-tabs-bar"
      role="tablist"
    >
      <button
        v-for="item in node.items"
        :key="item.id"
        type="button"
        role="tab"
        class="panel-tab"
        :class="{ 'is-active': activeTabId === item.id }"
        :aria-selected="activeTabId === item.id"
        @click="activeTabId = item.id"
      >
        {{ item.label }}
      </button>
    </div>
    <!-- 页签内容的淡入是宿主的(B 期 B2):out-in 保证同一时刻只有一棵子树
         挂着 —— 两棵并存时插件的 action 绑定会重复,那是协议层的坑不是动效。 -->
    <Transition
      name="panel-tab-body"
      mode="out-in"
    >
      <PluginPanelNode
        v-if="activeTabBody"
        :key="activeTabId || ''"
        :node="activeTabBody"
        :plugin-id="pluginId"
        @action="emit('action', $event)"
      />
    </Transition>
  </div>

  <div
    v-else-if="node.type === 'progress'"
    class="panel-progress"
  >
    <div
      class="panel-progress-track"
      role="progressbar"
      :aria-valuenow="node.indeterminate ? undefined : (node.value ?? 0)"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <div
        class="panel-progress-fill"
        :class="{ 'is-indeterminate': node.indeterminate }"
        :style="node.indeterminate ? undefined : { width: `${Math.min(100, Math.max(0, node.value ?? 0))}%` }"
      />
    </div>
    <span
      v-if="node.label"
      class="panel-progress-label"
    >{{ node.label }}</span>
  </div>

  <span
    v-else-if="node.type === 'spinner'"
    class="panel-spinner"
  >
    <span class="panel-spinner-dot" />
    <span v-if="node.label">{{ node.label }}</span>
  </span>

  <span
    v-else-if="node.type === 'badge'"
    class="panel-badge"
    :class="`tone-${node.tone || 'default'}`"
  >{{ node.text }}</span>

  <img
    v-else-if="node.type === 'image'"
    class="panel-image"
    :src="node.url"
    :alt="node.alt"
    :style="node.maxWidth ? { maxWidth: `${node.maxWidth}px` } : undefined"
    referrerpolicy="no-referrer"
  >

  <button
    v-else-if="node.type === 'link'"
    type="button"
    class="panel-link"
    @click="onLinkClick(node)"
  >
    {{ node.text }}
  </button>

  <pre
    v-else-if="node.type === 'code'"
    class="panel-code"
    :data-language="node.language"
  ><code>{{ node.text }}</code></pre>

  <hr
    v-else-if="node.type === 'divider'"
    class="panel-divider"
  >

  <!-- file-pick(B 期,用户壁纸):宿主自己的按钮 + 宿主自己的原生对话框。
       插件只声明"这里有个选文件的按钮",拿不到路径、更拿不到字节。
       没有 pluginId 就置灰而不是隐藏 —— 一个消失的按钮说不清为什么消失。 -->
  <Button
    v-else-if="node.type === 'file-pick'"
    unstyled
    class="panel-button"
    :disabled="picking || !pluginId"
    @click="onFilePick(node)"
  >
    {{ picking ? 'Choosing…' : node.label }}
  </Button>

  <SettingsEmptyState
    v-else-if="node.type === 'empty-state'"
    :title="node.title"
    :description="node.description"
  >
    <template
      v-if="node.actionId"
      #actions
    >
      <Button
        unstyled
        class="panel-button"
        @click="emit('action', { actionId: node.actionId, payload: undefined })"
      >
        {{ node.actionLabel || 'Continue' }}
      </Button>
    </template>
  </SettingsEmptyState>

  <!-- 认不出的节点类型。通道守卫会先拒掉它,所以这里只在守卫被绕开时才可见 ——
       但"看得见的占位"和"静默空白"是两种事故:后者只会让人以为面板坏了。 -->
  <p
    v-else
    class="panel-unknown"
  >
    Unsupported panel element "{{ (node as { type?: string }).type ?? 'unknown' }}" — this plugin may need a newer app.
  </p>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watchEffect } from 'vue'
import { platformApi } from '@/platform'
import { pluginsApi } from '@/platform/plugins-client'
import { toPlainData } from '@/workspace/plain-data'
import { toast } from '@/composables/useToast'
import Button from '@/components/common/Button.vue'
import Input from '@/components/common/Input.vue'
import InputNumber from '@/components/common/InputNumber.vue'
import Select from '@/components/common/Select.vue'
import Switch from '@/components/common/Switch.vue'
import MessageMarkdown from '@/components/chat/message/MessageMarkdown.vue'
import { SettingsEmptyState, SettingsField, SettingsGroup } from '@/components/settings/settings-primitives'
import type { PluginPanelNodeData } from '@/workspace/plugin-panel-types'

const props = defineProps<{
  node: PluginPanelNodeData
  /**
   * 这棵树属于哪个插件(B 期,用户壁纸)。
   *
   * 只有 `file-pick` 用得上它:导入的落点是**那个插件的**数据目录,所以宿主
   * 必须在发起对话框时说得出是谁。可选是为了不动既有调用方的形状 —— 缺了它,
   * file-pick 按钮置灰(而不是弹一个查不出归属的对话框)。
   */
  pluginId?: string
}>()

const emit = defineEmits<{
  action: [payload: { actionId: string; payload?: unknown }]
}>()

/**
 * 表单的本地状态。
 *
 * 描述树给的是初值,编辑期间的值只活在这里 —— 每敲一个字符就往插件回一次
 * action 既慢又会让插件被迫处理半成品输入。提交时整份 payload 一次带过去。
 */
const formState = reactive<Record<string, unknown>>(
  props.node.type === 'form'
    ? Object.fromEntries(props.node.fields.map(field => [field.key, field.value ?? '']))
    : {},
)

/**
 * string-list 的编辑期文本态(与 formState 分开)。
 *
 * 只存原始字符串;blur 时才 parse 回数组写进 formState。提交前再 parse 一次,
 * 因为用户完全可能打完最后一项直接点保存 —— 那时 blur 还没来得及发生,
 * 少了这一步提交上去的就是上一次 blur 的旧值。
 */
const stringListText = reactive<Record<string, string>>(
  props.node.type === 'form'
    ? Object.fromEntries(
      props.node.fields
        .filter(field => field.control === 'string-list')
        .map(field => [field.key, Array.isArray(field.value) ? field.value.join(', ') : String(field.value ?? '')]),
    )
    : {},
)

function commitStringList(key: string): void {
  formState[key] = (stringListText[key] ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

/** checkbox-group 的勾选切换;formState 里存 string[]。 */
function toggleCheckbox(key: string, option: string, checked: boolean): void {
  const current = Array.isArray(formState[key]) ? [...(formState[key] as string[])] : []
  formState[key] = checked ? [...new Set([...current, option])] : current.filter(item => item !== option)
}

/**
 * tabs 的当前页签。
 *
 * 页签切换是**纯前端状态**(v2 的 tabs 就是给"点击展开/切换"这类交互的
 * 零往返答案):切换不重拉 render,也不通知插件。新树过来时若当前页签已
 * 不存在,回落到第一个。
 */
const activeTabId = ref('')
watchEffect(() => {
  if (props.node.type !== 'tabs') return
  if (!props.node.items.some(item => item.id === activeTabId.value)) {
    activeTabId.value = props.node.items[0]?.id ?? ''
  }
})

/** 当前页签的 body —— `<Transition>` 只收一个子节点,所以先在这里选好。 */
const activeTabBody = computed(() => {
  if (props.node.type !== 'tabs') return null
  return props.node.items.find(item => item.id === activeTabId.value)?.body ?? null
})

/**
 * link 节点:有 actionId 走动作通道,否则经宿主打开外链(与消息正文同一条
 * 路径)。scheme 白名单在通道守卫已拦,这里不再判第二遍。
 */
function onLinkClick(node: { url?: string; actionId?: string; payload?: unknown }): void {
  if (node.actionId) {
    emit('action', { actionId: node.actionId, payload: node.payload })
    return
  }
  // 走 platformApi 而不是 `window.platformApi` —— 后者从来没有被赋值过,
  // 于是在此之前带 url 的 link 节点点下去**什么也不发生**(静默死路)。
  if (node.url) void platformApi.openExternal?.(node.url)
}

/**
 * file-pick 的一次点击(B 期,用户壁纸)。
 *
 * 三条出口,与宿主契约逐字对应:
 *  - **取消** → 什么也不做(不发 action:插件不该因为用户按了 Esc 被叫醒);
 *  - **闸不过**(超限 / 扩展名不符)→ toast 那句人话,仍然不发 action,
 *    **不计熔断**(用户选错文件不是插件的失败);
 *  - **成功** → 发 action,payload 是**地址**:{ path, name, size }。
 *
 * 字节与用户的原路径一步也不进这个组件 —— 主进程拷完只回一个 `storage:` 地址。
 */
const picking = ref(false)

async function onFilePick(node: { label: string; accept?: string[]; maxBytes?: number; actionId: string }): Promise<void> {
  if (picking.value || !props.pluginId) return
  picking.value = true
  try {
    // accept 来自响应式树,是 Vue 的 Proxy —— 原样递进 主进程 invoke 会炸
    // "An object can't be cloned"。边界铁律见 toPlainData 的文档(同病已犯两次)。
    const result = await pluginsApi.pickPluginFile(toPlainData({
      pluginId: props.pluginId,
      accept: node.accept,
      maxBytes: node.maxBytes,
      label: node.label,
    }))
    if (result?.canceled) return
    if (result?.error) {
      toast.error(result.error)
      return
    }
    if (!result?.path) return
    emit('action', {
      actionId: node.actionId,
      payload: { path: result.path, name: result.name, size: result.size },
    })
  } catch (e) {
    toast.error((e as Error)?.message || 'That file could not be imported.')
  } finally {
    picking.value = false
  }
}

function submitForm(actionId: string): void {
  // 先把还没 blur 的 string-list 落定,再打包 —— 否则最后一次输入会丢。
  for (const key of Object.keys(stringListText)) commitStringList(key)
  emit('action', { actionId, payload: { ...formState } })
}
</script>

<style scoped>
.panel-stack {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.panel-stack.gap-none { gap: 0; }
.panel-stack.gap-small { gap: 8px; }
.panel-stack.gap-medium { gap: 16px; }

.panel-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.panel-list {
  min-width: 0;
}

.panel-list-title {
  margin: 0 0 8px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--ui-text-muted-fg);
}

.panel-list-empty {
  margin: 0;
  font-size: 12px;
  color: var(--ui-text-muted-fg);
}

.panel-list-items {
  /* 离场项绝对定位的参照系(见 .panel-list-item-leave-active)。 */
  position: relative;
  margin: 0;
  padding: 0;
  list-style: none;
}

.panel-list-item {
  border-bottom: 1px solid color-mix(in srgb, var(--ui-border-default-border) 55%, transparent);
}

/* 列表项进出场(B 期 B2):进入淡入 + 一点点下沉,离场只淡出。
   离场绝对定位,免得剩下的项在动画期间跳位。 */
.panel-list-item-enter-active,
.panel-list-item-leave-active {
  transition: opacity var(--duration-fast) var(--ease-default),
    transform var(--duration-fast) var(--ease-default);
}

.panel-list-item-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}

.panel-list-item-leave-to {
  opacity: 0;
}

.panel-list-item-leave-active {
  position: absolute;
  width: 100%;
}

.panel-list-item-move {
  transition: transform var(--duration-fast) var(--ease-default);
}

.panel-list-item:last-child {
  border-bottom: none;
}

.panel-list-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  font: inherit;
}

.panel-list-item.is-clickable .panel-list-row {
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default);
}

.panel-list-item.is-clickable .panel-list-row:hover {
  color: var(--ui-accent-primary-fg);
}

.panel-list-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}

.panel-list-item-title {
  font-size: 13px;
  color: var(--ui-text-primary-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-list-item-subtitle {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--ui-text-muted-fg);
}

.panel-list-badge {
  flex-shrink: 0;
  padding: 1px 7px;
  border: 1px solid var(--ui-border-default-border);
  border-radius: 999px;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--ui-text-muted-fg);
}

.panel-markdown {
  min-width: 0;
  font-size: 13px;
}

.panel-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid var(--ui-border-default-border);
  border-radius: 0;
  background: transparent;
  color: var(--ui-text-secondary-fg, var(--ui-text-primary-fg));
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.panel-button:hover:not(:disabled) {
  border-color: var(--ui-text-muted-fg);
  color: var(--ui-text-primary-fg);
}

.panel-button.is-danger:hover:not(:disabled) {
  border-color: var(--ui-status-danger-border, var(--ui-status-danger-fg));
  color: var(--ui-status-danger-fg);
}

.panel-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.panel-unknown {
  margin: 0;
  padding: 8px 10px;
  border: 1px dashed var(--ui-border-default-border);
  font-size: 12px;
  color: var(--ui-text-muted-fg);
}

.panel-form-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

/* ── v2 节点(R5.x-b)──────────────────────────── */

.panel-table-wrap {
  overflow-x: auto;
  min-width: 0;
}

.panel-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.panel-table th,
.panel-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--ui-table-border-border, var(--ui-border-default-border));
  text-align: left;
}

.panel-table th {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--ui-text-muted-fg);
  background: var(--ui-table-header-bg, transparent);
}

.panel-table-empty {
  color: var(--ui-text-muted-fg);
}

.panel-tabs-bar {
  display: flex;
  gap: 2px;
  margin-bottom: 10px;
  border-bottom: 1px solid var(--ui-border-default-border);
}

.panel-tab {
  padding: 5px 10px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--ui-text-muted-fg);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default),
    border-bottom-color var(--duration-fast) var(--ease-default);
}

.panel-tab.is-active {
  border-bottom-color: var(--ui-accent-primary-fg, var(--color-primary));
  color: var(--ui-text-primary-fg);
}

/* 页签内容切换:只做透明度,不做位移 —— 描述树的内容高度不可预知,
   位移动效会把整块面板抖起来。 */
.panel-tab-body-enter-active,
.panel-tab-body-leave-active {
  transition: opacity var(--duration-fast) var(--ease-default);
}

.panel-tab-body-enter-from,
.panel-tab-body-leave-to {
  opacity: 0;
}

.panel-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.panel-progress-track {
  flex: 1;
  height: 4px;
  min-width: 40px;
  overflow: hidden;
  background: var(--ui-border-default-border);
}

.panel-progress-fill {
  height: 100%;
  background: var(--ui-accent-primary-fg, var(--color-primary));
  transition: width var(--duration-fast) var(--ease-default);
}

/* indeterminate 是 v2 唯一带的动画:宿主 CSS 原语,插件只声明状态。 */
.panel-progress-fill.is-indeterminate {
  width: 40%;
  animation: panel-progress-slide 1.2s ease-in-out infinite;
}

@keyframes panel-progress-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(250%); }
}

.panel-progress-label {
  font-size: 11px;
  color: var(--ui-text-muted-fg);
  white-space: nowrap;
}

.panel-spinner {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ui-text-muted-fg);
}

.panel-spinner-dot {
  width: 10px;
  height: 10px;
  border: 2px solid var(--ui-border-default-border);
  border-top-color: var(--ui-accent-primary-fg, var(--color-primary));
  border-radius: 50%;
  animation: panel-spinner-rotate 0.8s linear infinite;
}

@keyframes panel-spinner-rotate {
  to { transform: rotate(360deg); }
}

.panel-badge {
  display: inline-block;
  padding: 1px 8px;
  border: 1px solid var(--ui-border-default-border);
  border-radius: 999px;
  font-size: 11px;
  line-height: 16px;
  color: var(--ui-text-muted-fg);
  /* tone 变化只过渡**颜色**(B 期 B2 第 3 条):徽标常常在流式里每秒换几次,
     位移动效会让它抖成一团。 */
  transition: color var(--duration-fast) var(--ease-default),
    border-color var(--duration-fast) var(--ease-default);
}

.panel-badge.tone-accent {
  border-color: var(--ui-accent-primary-fg, var(--color-primary));
  color: var(--ui-accent-primary-fg, var(--color-primary));
}

.panel-badge.tone-danger {
  border-color: var(--ui-status-danger-fg);
  color: var(--ui-status-danger-fg);
}

.panel-badge.tone-success {
  border-color: var(--ui-status-success-fg);
  color: var(--ui-status-success-fg);
}

.panel-image {
  display: block;
  max-width: 100%;
  height: auto;
}

.panel-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ui-accent-primary-fg, var(--color-primary));
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}

.panel-code {
  margin: 0;
  padding: 8px 10px;
  overflow-x: auto;
  background: var(--ui-surface-elevated-bg, transparent);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  white-space: pre;
}

.panel-divider {
  border: 0;
  border-top: 1px solid var(--ui-border-default-border);
  margin: 4px 0;
}

.panel-slider {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.panel-slider-value {
  min-width: 3ch;
  font-size: 12px;
  color: var(--ui-text-muted-fg);
  text-align: right;
}

.panel-choice-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}

.panel-choice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}

.panel-native-input {
  padding: 4px 8px;
  border: 1px solid var(--ui-border-default-border);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
}

.panel-color-input {
  padding: 2px;
  width: 40px;
  height: 26px;
}
</style>
