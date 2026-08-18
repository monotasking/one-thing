<template>
  <div class="cred-rows">
    <div class="settings-row">
      <span class="row-label api-key-label">
        API Key
        <span
          v-if="envBadge"
          class="env-detected-badge"
        >
          <Terminal :size="12" />
          Env {{ envBadge.varName }}
          <span v-if="envBadge.keyPreview">
            · {{ envBadge.keyPreview }}
          </span>
        </span>
      </span>
      <Input
        :model-value="apiKey"
        type="password"
        show-password
        variant="ledger"
        class="row-input"
        :placeholder="apiKeyPlaceholder"
        :spellcheck="false"
        aria-label="API key"
        @update:model-value="$emit('update:apiKey', String($event))"
      />
    </div>

    <div class="settings-row">
      <span class="row-label">Base URL</span>
      <Input
        :model-value="baseUrl"
        type="text"
        variant="ledger"
        class="row-input"
        :placeholder="baseUrlPlaceholder"
        :spellcheck="false"
        aria-label="Base URL"
        @update:model-value="$emit('update:baseUrl', String($event))"
      />
    </div>

    <!-- provider 专属旋钮。表在 provider-dials.ts,两种空间下读的是同一张。 -->
    <template v-if="dials">
      <div
        v-if="showRegion"
        class="settings-row"
      >
        <span class="row-label">{{ dials.region!.label }}</span>
        <Select
          variant="ledger"
          size="small"
          teleported
          fit-input-width
          class="row-select"
          :model-value="regionValue"
          :options="dials.region!.options"
          :aria-label="dials.region!.ariaLabel"
          @update:model-value="$emit('update:region', String($event))"
        />
      </div>
      <div class="settings-row">
        <span class="row-label">{{ dials.apiMode.label }}</span>
        <Select
          variant="ledger"
          size="small"
          teleported
          fit-input-width
          class="row-select"
          :model-value="apiModeValue"
          :options="dials.apiMode.options"
          :aria-label="dials.apiMode.ariaLabel"
          @update:model-value="$emit('update:apiMode', String($event))"
        />
      </div>
      <p
        v-if="dials.note"
        class="row-note"
      >
        {{ dials.note }}
      </p>
    </template>

    <slot name="footer" />
  </div>
</template>

<script setup lang="ts">
/**
 * 一个 provider 的凭证行组(批 B10)—— **default 空间与空间凭证池共用这一份模板**。
 *
 * 用户 08-18 的裁决:「同一张设置页,切空间只换数据、不换外观。」B7 把数据源折进了
 * 连接卡片,但外观没跟上 —— 非默认空间下凭证区整块换成了另一副样子(条目列表 +
 * 三格添加表单 + 「本空间」措辞),用户切个空间就以为自己点错了页面。
 *
 * 所以这里只做一件事:**把那两行 + 旋钮行做成一个组件**,由两边各自把自己的数据
 * 源接进来。样式必须住在本文件里 —— 父级的 scoped CSS 只命中子组件的**根元素**,
 * 把 `.settings-row` 留在 ConnectionsSection 里会让空间那一支画出一堆裸行。
 *
 * 这里**不认识空间**:它拿到的是「显示什么值 / 用户改了什么」,谁去落盘是调用方的事。
 */
import { computed } from "vue";
import { Terminal } from "lucide-vue-next";
import Input from "@/components/common/Input.vue";
import Select from "@/components/common/Select.vue";
import {
	providerDialsOf,
	regionRowApplies,
	resolveDialValue,
} from "./provider-dials";

const props = defineProps<{
	providerId: string;
	/**
	 * 输入框里显示的值。default 空间给的是 settings 里那把 key 的原文;
	 * 空间池给的是**空串**(密钥原文永不回读,已存的那把走 placeholder 报掩码)。
	 */
	apiKey: string;
	apiKeyPlaceholder: string;
	baseUrl: string;
	baseUrlPlaceholder: string;
	/** 存下来的档位/地区。缺席 = 这家 provider 自己的缺省(由归一函数给)。 */
	apiMode?: string;
	region?: string;
	/** 「这把 key 来自环境变量」的徽章。机器级的东西,只有 default 空间给得出。 */
	envBadge?: { varName: string; keyPreview: string } | null;
}>();

defineEmits<{
	(e: "update:apiKey", value: string): void;
	(e: "update:baseUrl", value: string): void;
	(e: "update:apiMode", value: string): void;
	(e: "update:region", value: string): void;
}>();

const dials = computed(() => providerDialsOf(props.providerId));

const apiModeValue = computed(() =>
	dials.value ? resolveDialValue(dials.value.apiMode, props.apiMode) : "",
);

const regionValue = computed(() =>
	dials.value?.region
		? resolveDialValue(dials.value.region, props.region)
		: "",
);

const showRegion = computed(() =>
	dials.value ? regionRowApplies(dials.value, apiModeValue.value) : false,
);
</script>

<style scoped>
/* 逐字搬自 ConnectionsSection 的同名规则 —— 「像素级同构」在这里是字面意思。 */
.cred-rows {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.settings-row {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) minmax(0, 2fr);
  align-items: center;
  gap: 24px;
}

.row-label {
  font-size: 14px;
  color: var(--settings-ink-2, var(--ui-text-primary-fg));
  flex-shrink: 0;
  font-weight: 520;
}

.api-key-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.env-detected-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 1px 7px 2px;
  border: 1px solid var(--ui-status-success-border, var(--ui-status-success-fg));
  border-radius: 999px;
  background: transparent;
  color: var(--ui-status-success-fg);
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  font-weight: 560;
  line-height: 1.3;
  white-space: nowrap;
}

.row-input {
  width: 100%;
  min-width: 0;
}

.row-select {
  width: 100%;
  min-width: 0;
}

/* Full-width note under the selects it warns about. Deliberately NOT a
   settings-row: the row grid's control column inherits single-line ellipsis,
   which silently truncated this sentence mid-word. */
.row-note {
  overflow: visible;
  margin: 0;
  color: var(--settings-ink-3, var(--ui-text-secondary-fg));
  font-size: 12px;
  line-height: 1.5;
  text-overflow: clip;
  white-space: normal;
}
</style>
