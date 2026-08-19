<template>
  <div class="tab-content">
    <section class="settings-section">
      <h3 class="section-title">
        Installed Plugins
      </h3>
      <p class="section-desc">
        Plugins extend onething with custom tools, commands, and event handlers.
        Plugins live in <code>~/.onething/plugins/</code>
      </p>

      <!-- 提示音总开关(M1)。声音是通知的一个受限参数,不是单独的能力 ——
           所以主权控件放在这里,而不是给它开一道声明门。关掉只掐声音,
           插件的通知横幅照常显示。 -->
      <SettingsGroup>
        <SettingRow
          label="Plugin notification sounds"
          description="Plugins can attach one of a small set of built-in sounds to a notification. Muting never hides the notification itself — only the sound."
        >
          <div class="notify-sound-control">
            <Button
              unstyled
              class="btn-sm"
              :disabled="!notifySoundsEnabled"
              @click="previewNotifySound"
            >
              Test
            </Button>
            <Switch
              variant="ledger"
              :model-value="notifySoundsEnabled"
              aria-label="Enable plugin notification sounds"
              @update:model-value="setNotifySoundsEnabled"
            />
          </div>
        </SettingRow>
      </SettingsGroup>

      <!-- 氛围效果总闸(G2 —— 全窗动画覆盖)。一键关掉所有插件的氛围层
           (整窗飘雪之类)。氛围是**内容之上、每层浮层之下**、点击穿透的纯视觉,
           关掉不影响插件的任何别的能力。每插件的开关在各自卡片上。 -->
      <SettingsGroup>
        <SettingRow
          label="Plugin ambient effects"
          description="Plugins can draw animated effects over the whole window (e.g. falling snow). Effects never intercept clicks and always sit below menus and dialogs. Turning this off stops every plugin's ambient layer at once."
        >
          <Switch
            variant="ledger"
            :model-value="ambientEnabled"
            aria-label="Enable plugin ambient effects"
            @update:model-value="setAmbientEnabled"
          />
        </SettingRow>
      </SettingsGroup>

      <!-- Loading -->
      <div
        v-if="loading"
        class="loading-row"
      >
        <div class="spinner" />
        <span>Loading plugins...</span>
      </div>

      <!-- Error -->
      <ErrorNote
        v-else-if="error"
        variant="block"
        :message="error"
      >
        <template #actions>
          <Button
            unstyled
            class="btn-sm"
            @click="loadPlugins"
          >
            Retry
          </Button>
        </template>
      </ErrorNote>

      <!-- Empty -->
      <div
        v-else-if="plugins.length === 0"
        class="empty-state"
      >
        <p>No plugins installed.</p>
        <p class="hint">
          Create a plugin in <code>~/.onething/plugins/&lt;name&gt;/plugin-entry.js</code>
          or symlink <code>sample-plugins/</code> directories, then click <strong>Refresh</strong>.
        </p>
        <Button
          unstyled
          class="btn-sm"
          @click="refreshPlugins"
        >
          <RefreshCw :size="13" />
          <span>Refresh</span>
        </Button>
      </div>

      <!-- Plugin list -->
      <div
        v-else
        class="settings-card plugin-list"
      >
        <div class="plugin-list-header">
          <span class="plugin-count">{{ plugins.length }} plugin{{ plugins.length > 1 ? 's' : '' }}</span>
          <Button
            unstyled
            class="btn-sm refresh-btn"
            @click="refreshPlugins"
          >
            <RefreshCw :size="13" />
            <span>Refresh</span>
          </Button>
        </div>
        <div
          v-for="plugin in plugins"
          :key="plugin.id"
          class="plugin-item"
          :class="{ disabled: !plugin.enabled }"
        >
          <div class="plugin-body">
            <div class="plugin-header">
              <div class="plugin-name-row">
                <span class="plugin-name">{{ plugin.name }}</span>
                <span class="plugin-version">v{{ plugin.version }}</span>
                <span
                  class="status-badge"
                  :class="statusOf(plugin).tone"
                >
                  {{ statusOf(plugin).label }}
                </span>
              </div>
              <p
                v-if="plugin.description"
                class="plugin-desc"
              >
                {{ plugin.description }}
              </p>
              <ErrorNote
                v-if="plugin.error"
                size="sm"
                :message="plugin.error"
              />
              <!-- 运行期健康:加载成功之后才出现的失败(钩子超时、事件 handler
                   抛错、熔断自动禁用)。之前这类错只进 console,卡片永远 Active。 -->
              <ErrorNote
                v-if="runtimeFault(plugin)"
                size="sm"
                :message="runtimeFault(plugin)"
              />
              <div class="plugin-meta">
                <span
                  v-if="plugin.author"
                  class="meta-tag"
                >by {{ plugin.author }}</span>
                <span
                  v-if="plugin.source === 'builtin'"
                  class="meta-tag builtin"
                >Built-in</span>
                <!-- "有更新"徽标:checkPluginUpdates 的数据源是市场索引。 -->
                <span
                  v-if="updateOffers.has(plugin.id)"
                  class="meta-tag update-available"
                >v{{ updateOffers.get(plugin.id)!.latest }} available</span>
                <span
                  v-if="plugin.commands.length"
                  class="meta-tag"
                >
                  {{ plugin.commands.length }} command{{ plugin.commands.length > 1 ? 's' : '' }}
                  <span class="cmd-list">({{ plugin.commands.join(', ') }})</span>
                </span>
                <span class="meta-tag path">{{ plugin.id }}</span>
              </div>
              <!-- 声明先于代码:manifest 的 contributes 摘要。宿主不执行一行
                   插件代码就能说出它要贡献什么(消费者在 R3/R5)。 -->
              <div
                v-if="contributesSummary(plugin).length"
                class="plugin-meta contributes"
              >
                <span
                  v-for="item in contributesSummary(plugin)"
                  :key="item"
                  class="meta-tag declares"
                >{{ item }}</span>
              </div>
            </div>

            <!-- 配置区(R3)。schema 单源在 manifest,存储与校验在宿主 ——
               所以**未启用的插件也能配**,这一块不依赖插件代码跑起来。 -->
            <div
              v-if="hasConfigArea(plugin)"
              class="plugin-config"
            >
              <div class="plugin-config-head">
                <span class="plugin-config-title">{{ plugin.configTitle || 'Configuration' }}</span>
                <span
                  v-if="!isConfigEditable(plugin)"
                  class="meta-tag readonly"
                >{{ plugin.configValuesAreDefaults ? 'read-only on web — defaults shown' : 'read-only on web' }}</span>
              </div>
              <p
                v-if="!isConfigEditable(plugin) && plugin.configValuesAreDefaults"
                class="plugin-config-note"
              >
                These are the schema defaults, not this plugin's values on your desktop — plugins run on the
                desktop host only, so the values there may differ.
              </p>

              <ErrorNote
                v-if="plugin.configUnsupportedReasons?.length"
                size="sm"
                :message="`This plugin's settings schema is not supported: ${plugin.configUnsupportedReasons.join('; ')}`"
              />

              <SettingsGroup v-else>
                <template
                  v-for="field in plugin.configFields"
                  :key="field.key"
                >
                  <!-- boolean 走 SettingRow:标签+描述在左、开关在右,与其余 tab 对齐。 -->
                  <SettingRow
                    v-if="field.control === 'switch'"
                    :label="field.label + (field.required ? ' *' : '')"
                    :description="fieldError(plugin, field.key) || field.hint"
                  >
                    <Switch
                      variant="ledger"
                      :model-value="Boolean(draftFor(plugin)[field.key])"
                      :disabled="!isConfigEditable(plugin)"
                      :aria-label="field.label"
                      @update:model-value="setDraft(plugin, field.key, Boolean($event))"
                    />
                  </SettingRow>

                  <SettingsField
                    v-else
                    :label="field.label + (field.required ? ' *' : '')"
                    :hint="fieldError(plugin, field.key) || field.hint"
                  >
                    <!-- 非整数字段不给 step 就会回退成 1,0~1 的比例字段(透明度、
                         模糊度一类)于是只能在 0 和 1 之间跳,箭头点不出中间值。
                         量程落在 0~1 时给 0.05,其余非整数维持默认。 -->
                    <InputNumber
                      v-if="field.control === 'number'"
                      :model-value="Number(draftFor(plugin)[field.key])"
                      :min="field.minimum"
                      :max="field.maximum"
                      :step="numberFieldStep(field)"
                      :disabled="!isConfigEditable(plugin)"
                      :aria-label="field.label"
                      @update:model-value="setDraft(plugin, field.key, Number($event))"
                    />
                    <Select
                      v-else-if="field.control === 'select'"
                      variant="ledger"
                      size="small"
                      teleported
                      fit-input-width
                      :model-value="String(draftFor(plugin)[field.key] ?? '')"
                      :options="field.options || []"
                      :disabled="!isConfigEditable(plugin)"
                      :aria-label="field.label"
                      @update:model-value="setDraft(plugin, field.key, String($event))"
                    />
                    <!-- string-list 编辑期间只维护**原始文本**:每敲一键就
                         split+trim+filter 再 join 回去是有损往返 —— 键入逗号
                         当场被自己吃掉,根本打不出第二项。blur 时才 parse。 -->
                    <Input
                      v-else-if="field.control === 'string-list'"
                      variant="ledger"
                      :model-value="stringListDraft(plugin, field.key)"
                      :disabled="!isConfigEditable(plugin)"
                      :aria-label="field.label"
                      placeholder="Comma separated"
                      @update:model-value="setStringListText(plugin, field.key, String($event))"
                      @blur="commitStringList(plugin, field.key)"
                    />
                    <!-- 文件导入:配置类的"选文件"住这里,不住工作台面板。
                         按钮 + 当前值,值是**地址**不是路径 —— 用户磁盘上的
                         原路径一步也不到这一层。 -->
                    <div
                      v-else-if="field.control === 'file-import'"
                      class="plugin-config-file"
                    >
                      <Button
                        unstyled
                        class="btn-sm"
                        :disabled="!isConfigEditable(plugin) || pickingFields.has(fieldKey(plugin, field.key))"
                        :aria-label="field.label"
                        @click="pickConfigFile(plugin, field)"
                      >
                        {{ pickingFields.has(fieldKey(plugin, field.key)) ? 'Choosing…' : 'Choose file…' }}
                      </Button>
                      <span class="plugin-config-file-value">{{ fileValueLabel(plugin, field.key) }}</span>
                      <!-- 清空钮:值非空才在。Reset 只丢草稿,清不掉**已保存**
                           的值 —— 没有这一钮,一个存过的 file 字段在设置页里
                           就是有进无出(想回缺省只能停用插件或再换一张图)。 -->
                      <Button
                        v-if="hasFileValue(plugin, field.key)"
                        unstyled
                        class="btn-sm plugin-config-file-clear"
                        :disabled="!isConfigEditable(plugin)"
                        :aria-label="`Clear ${field.label}`"
                        @click="clearConfigFile(plugin, field.key)"
                      >
                        ×
                      </Button>
                    </div>
                    <!-- 选目录(schema `format: 'directory-pick'`,F1 外部根):
                         原生目录对话框 + 当前路径回显。值就是绝对路径本身
                         (与 file-import 的 storage: 地址语义不同,见
                         shared/ipc/plugins.ts 的 directoryPick 注释),走普通
                         draft→Save 保存路径,不为它发明第二条提交语义。 -->
                    <div
                      v-else-if="field.control === 'directory-pick'"
                      class="plugin-config-file"
                    >
                      <Button
                        unstyled
                        class="btn-sm"
                        :disabled="!isConfigEditable(plugin)"
                        :aria-label="field.label"
                        @click="pickConfigDirectory(plugin, field)"
                      >
                        Choose folder…
                      </Button>
                      <span class="plugin-config-file-value">{{ String(draftFor(plugin)[field.key] ?? '') || 'No folder chosen' }}</span>
                      <Button
                        v-if="hasFileValue(plugin, field.key)"
                        unstyled
                        class="btn-sm plugin-config-file-clear"
                        :disabled="!isConfigEditable(plugin)"
                        :aria-label="`Clear ${field.label}`"
                        @click="setDraft(plugin, field.key, '')"
                      >
                        ×
                      </Button>
                    </div>
                    <Input
                      v-else
                      variant="ledger"
                      :model-value="String(draftFor(plugin)[field.key] ?? '')"
                      :disabled="!isConfigEditable(plugin)"
                      :aria-label="field.label"
                      @update:model-value="setDraft(plugin, field.key, String($event))"
                    />
                  </SettingsField>
                </template>
              </SettingsGroup>

              <ErrorNote
                v-if="generalErrors(plugin).length"
                size="sm"
                :message="generalErrors(plugin).join('; ')"
              />

              <div
                v-if="isConfigEditable(plugin) && plugin.configFields?.length"
                class="plugin-config-actions"
              >
                <Button
                  unstyled
                  class="btn-sm"
                  :disabled="!isDirty(plugin) || savingPlugins.has(plugin.id)"
                  @click="saveConfig(plugin)"
                >
                  {{ savingPlugins.has(plugin.id) ? 'Saving…' : 'Save' }}
                </Button>
                <Button
                  v-if="isDirty(plugin)"
                  unstyled
                  class="btn-sm"
                  @click="resetDraft(plugin)"
                >
                  Reset
                </Button>
                <span
                  v-if="savedPlugins.has(plugin.id)"
                  class="plugin-config-saved"
                >Saved</span>
              </div>
            </div>
          </div>

          <!-- 启用开关是 .plugin-item 的**直接子节点**:它靠
               `.plugin-item{align-items:flex-start}` 锚在卡片右上角。挪进
               .plugin-body 里(配置区之后)会让它掉到底部左侧,那条对齐规则
               和 .plugin-toggle{flex-shrink:0} 一起变成死样式。 -->
          <div class="plugin-toggle">
            <Switch
              variant="ledger"
              :model-value="plugin.enabled"
              :disabled="uninstallingPlugins.has(plugin.id)"
              :aria-label="`Enable ${plugin.name}`"
              @update:model-value="togglePlugin(plugin)"
            />
            <!-- 每插件静音(M1)。总开关关着时这一条无意义,所以整个藏起来 ——
                 置灰会让人以为点了有用。静音是**用户对插件的主权**,与插件自己的
                 config 无关,所以它存在 app settings 而不是插件目录。 -->
            <Tooltip
              v-if="notifySoundsEnabled"
              :text="isMuted(plugin.id) ? `Unmute ${plugin.name}'s notification sounds` : `Mute ${plugin.name}'s notification sounds`"
            >
              <Button
                unstyled
                class="btn-sm mute-btn"
                :class="{ muted: isMuted(plugin.id) }"
                :aria-label="isMuted(plugin.id) ? `Unmute ${plugin.name}` : `Mute ${plugin.name}`"
                :aria-pressed="isMuted(plugin.id)"
                @click="toggleMute(plugin.id)"
              >
                <component
                  :is="isMuted(plugin.id) ? BellOff : Bell"
                  :size="13"
                />
              </Button>
            </Tooltip>
            <!-- 每插件氛围开关(G2)。只在插件声明了氛围、且总闸开着时出现 ——
                 关掉只撤这一层动效,插件其余能力照常。与提示音静音同规:主权存
                 app settings,不进插件目录。 -->
            <Tooltip
              v-if="ambientEnabled && plugin.contributes?.ambient"
              :text="isAmbientMuted(plugin.id) ? `Show ${plugin.name}'s ambient effects` : `Hide ${plugin.name}'s ambient effects`"
            >
              <Button
                unstyled
                class="btn-sm mute-btn"
                :class="{ muted: isAmbientMuted(plugin.id) }"
                :aria-label="isAmbientMuted(plugin.id) ? `Show ${plugin.name} ambient` : `Hide ${plugin.name} ambient`"
                :aria-pressed="isAmbientMuted(plugin.id)"
                @click="toggleAmbientMute(plugin.id)"
              >
                <component
                  :is="isAmbientMuted(plugin.id) ? EyeOff : Eye"
                  :size="13"
                />
              </Button>
            </Tooltip>
            <!-- 有更新才出现;无 npm 时置灰(裁决 8)。 -->
            <Tooltip
              v-if="updateOffers.has(plugin.id)"
              :text="npmAvailable === false ? 'npm is not available on this machine' : `Update to v${updateOffers.get(plugin.id)!.latest}`"
            >
              <Button
                unstyled
                class="btn-sm update-btn"
                :disabled="npmAvailable === false || updatingPlugins.has(plugin.id)"
                @click="updatePlugin(plugin)"
              >
                {{ updatingPlugins.has(plugin.id) ? 'Updating…' : 'Update' }}
              </Button>
            </Tooltip>
            <!-- 仅用户插件可卸载:内置插件与 app 同一份构建,没有"源目录"可删。 -->
            <Button
              v-if="canUninstall(plugin)"
              unstyled
              class="btn-sm uninstall-btn"
              :disabled="uninstallingPlugins.has(plugin.id)"
              @click="confirmUninstall(plugin)"
            >
              {{ uninstallingPlugins.has(plugin.id) ? 'Uninstalling…' : 'Uninstall' }}
            </Button>
          </div>
        </div>
      </div>
    </section>

    <!-- Market(P3):声明先于代码在分发环节的延伸 —— 装前确认看到的就是
         manifest 的 contributes/permissions,不是营销文案。断网回上次缓存并明示过期。 -->
    <section class="settings-section">
      <h3 class="section-title">
        Plugin Market
      </h3>
      <p class="section-desc">
        The official market. What you review before installing is the plugin's manifest —
        its declared contributions and permissions.
      </p>

      <!-- 连缓存都没有才是真失败;有缓存时主进程走 success+stale,不会到这。 -->
      <ErrorNote
        v-if="marketError && marketEntries.length === 0"
        variant="block"
        size="sm"
        :message="marketError"
      >
        <template #actions>
          <Button
            unstyled
            class="btn-sm"
            @click="loadMarket(true)"
          >
            Retry
          </Button>
        </template>
      </ErrorNote>

      <template v-else-if="marketEntries.length || !marketLoading">
        <div class="market-toolbar">
          <Input
            v-model="marketQuery"
            variant="ledger"
            placeholder="Search by name, description, or author"
            aria-label="Search the plugin market"
          />
          <Button
            unstyled
            class="btn-sm refresh-btn"
            :disabled="marketLoading"
            @click="loadMarket(true)"
          >
            <RefreshCw :size="13" />
            <span>{{ marketLoading ? 'Refreshing…' : 'Refresh' }}</span>
          </Button>
        </div>
        <p
          v-if="marketStale"
          class="hint market-stale"
        >
          Couldn't refresh{{ marketStaleReason ? ` (${marketStaleReason})` : '' }} —
          showing the index fetched at {{ marketFetchedAtText }} (may be outdated).
        </p>

        <div
          v-if="filteredMarket.length === 0"
          class="empty-state"
        >
          <p>No plugins match your search.</p>
        </div>

        <div
          v-else
          class="settings-card plugin-list market-list"
        >
          <div
            v-for="entry in filteredMarket"
            :key="entry.id"
            class="plugin-item"
          >
            <div class="plugin-body">
              <div class="plugin-header">
                <div class="plugin-name-row">
                  <span class="plugin-name">{{ entry.id }}</span>
                  <span class="plugin-version">v{{ entry.version }}</span>
                  <span
                    v-if="entry.installedVersion && !entry.hasUpdate"
                    class="status-badge loaded"
                  >Installed</span>
                  <span
                    v-if="entry.hasUpdate"
                    class="status-badge warning"
                  >v{{ entry.version }} available</span>
                </div>
                <p
                  v-if="entry.description"
                  class="plugin-desc"
                >
                  {{ entry.description }}
                </p>
                <div class="plugin-meta">
                  <span
                    v-if="entry.author"
                    class="meta-tag"
                  >by {{ entry.author }}</span>
                  <span class="meta-tag">{{ entry.pkg }}</span>
                </div>
                <ErrorNote
                  v-if="entry.versionBlockedReason"
                  size="sm"
                  :message="`Cannot install: ${entry.versionBlockedReason}`"
                />

                <!-- 装前确认:用户点头前看到的就是 manifest -->
                <div
                  v-if="confirmingMarket === entry.id"
                  class="market-confirm"
                >
                  <p class="market-confirm-title">
                    This plugin declares:
                  </p>
                  <ul class="market-confirm-list">
                    <li
                      v-for="item in marketDeclares(entry)"
                      :key="item"
                    >
                      {{ item }}
                    </li>
                    <li v-if="marketDeclares(entry).length === 0">
                      No contributions declared.
                    </li>
                  </ul>
                  <p
                    v-if="entry.integrity"
                    class="hint"
                  >
                    Integrity (sha512) will be verified against the market index.
                  </p>
                  <p
                    v-else
                    class="hint"
                  >
                    No integrity hash published — verification will be skipped.
                  </p>
                  <div class="market-confirm-actions">
                    <Button
                      unstyled
                      class="btn-sm install-btn"
                      :disabled="installingMarket.has(entry.id)"
                      @click="installFromMarket(entry)"
                    >
                      {{ installingMarket.has(entry.id) ? 'Installing…' : 'Confirm install' }}
                    </Button>
                    <Button
                      unstyled
                      class="btn-sm"
                      @click="confirmingMarket = null"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <div class="plugin-toggle">
              <Tooltip
                v-if="entry.installedVersion && entry.hasUpdate"
                :text="npmAvailable === false ? 'npm is not available on this machine' : `Update to v${entry.version}`"
              >
                <Button
                  unstyled
                  class="btn-sm update-btn"
                  :disabled="npmAvailable === false || updatingPlugins.has(entry.id)"
                  @click="updateMarketPlugin(entry)"
                >
                  {{ updatingPlugins.has(entry.id) ? 'Updating…' : 'Update' }}
                </Button>
              </Tooltip>
              <Tooltip
                v-else-if="!entry.installedVersion"
                :text="npmAvailable === false
                  ? 'npm is not available on this machine'
                  : (entry.versionBlockedReason ?? 'Review the manifest, then install')"
              >
                <Button
                  unstyled
                  class="btn-sm install-btn"
                  :disabled="npmAvailable === false || Boolean(entry.versionBlockedReason) || installingMarket.has(entry.id)"
                  @click="confirmingMarket = confirmingMarket === entry.id ? null : entry.id"
                >
                  Install
                </Button>
              </Tooltip>
            </div>
          </div>
        </div>
      </template>

      <div
        v-else
        class="loading-row"
      >
        <div class="spinner" />
        <span>Loading the market…</span>
      </div>
    </section>

    <!-- Install(P1:npm 形态命令链;file: 开发通道 —— 选中 tarball 即可安装:
         包名写在包里,宿主自己读得出来,不该让人再抄一遍) -->
    <section class="settings-section">
      <h3 class="section-title">
        Install Plugin
      </h3>
      <div class="settings-card">
        <div class="card-row">
          <!-- 裁决 8:v1 依赖本机 npm —— 无 npm 置灰并说明,而不是点了才炸。 -->
          <ErrorNote
            v-if="npmAvailable === false"
            variant="block"
            size="sm"
            message="npm is not available on this machine. Plugin installation and updates need a local npm (v1 targets developers); install Node.js/npm and restart the app."
          />
          <!-- 逐条绑定而不是 v-on="handlers":对象形式的 v-on 走 toHandlers,
               `onDrop` 这样的键会被再加一次前缀,监听器落在一个不存在的事件上。 -->
          <div
            class="install-form"
            :class="{ 'is-drop-target': isTarballDragActive }"
            @dragenter="tarballDropHandlers.dragenter"
            @dragover="tarballDropHandlers.dragover"
            @dragleave="tarballDropHandlers.dragleave"
            @drop="tarballDropHandlers.drop"
          >
            <Input
              v-model="installPath"
              variant="ledger"
              placeholder="Local .tgz — or drop one here (file: dev channel)"
              :disabled="npmAvailable === false || installing"
              aria-label="Local plugin tarball path"
              @update:model-value="onInstallPathInput"
            />
            <div class="install-actions">
              <Button
                unstyled
                class="btn-sm"
                :disabled="npmAvailable === false || installing"
                @click="chooseTarball"
              >
                Choose file…
              </Button>
              <Button
                unstyled
                class="btn-sm install-btn"
                :disabled="installableEntries.length === 0 || npmAvailable === false || installing"
                @click="installPlugin"
              >
                {{ installLabel }}
              </Button>
            </div>
          </div>

          <!-- 拖投里解析不出本机路径的文件走这条表单级错误(不属于任何一个 tarball)。 -->
          <ErrorNote
            v-if="installError"
            size="sm"
            :message="installError"
          />
          <!-- 批量装前确认:每个待装 tarball 一行 —— 与市场同一套披露口径,点头前
               看到的就是 manifest。预读中/失败/成功三态各自呈现;失败的条目单独
               标红,不阻塞其它能装的。 -->
          <div
            v-if="installEntries.length"
            class="install-entries"
          >
            <div
              v-for="(entry, index) in installEntries"
              :key="index"
              class="install-entry"
            >
              <p
                v-if="entry.reading"
                class="hint"
              >
                Reading {{ entry.path }}…
              </p>
              <ErrorNote
                v-else-if="entry.error"
                size="sm"
                :message="entry.error"
              />
              <div
                v-else-if="entry.summary"
                class="market-confirm"
              >
                <p class="market-confirm-title">
                  {{ entry.summary.pkg }} v{{ entry.summary.version }} declares:
                </p>
                <ul class="market-confirm-list">
                  <li
                    v-for="item in entryDeclares(entry.summary)"
                    :key="item"
                  >
                    {{ item }}
                  </li>
                  <li v-if="entryDeclares(entry.summary).length === 0">
                    No contributions declared.
                  </li>
                </ul>
                <ErrorNote
                  v-if="entry.summary.manifestIssue"
                  size="sm"
                  :message="entry.summary.manifestIssue"
                />
              </div>
            </div>
            <p
              v-if="installableEntries.length"
              class="hint"
            >
              No integrity hash on the dev channel — after install each package name is
              re-checked against its tarball, and anything that fails a gate is rolled back.
            </p>
          </div>

          <p class="hint install-hint">
            Installs run through npm with lifecycle scripts disabled (<code>--ignore-scripts</code>);
            packages must ship fully bundled. Dropping a folder into <code>~/.onething/plugins/</code>
            no longer installs anything — since 2026-08-09 the npm ledger is the only way in.
          </p>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import ErrorNote from '@/components/common/ErrorNote.vue'
import Input from '@/components/common/Input.vue'
import InputNumber from '@/components/common/InputNumber.vue'
import Select from '@/components/common/Select.vue'
import Switch from '@/components/common/Switch.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import { SettingRow, SettingsField, SettingsGroup } from './settings-primitives'
import type {
  PluginConfigErrorDetail,
  PluginConfigFieldDescriptor,
  PluginTarballSummary,
} from '@shared/ipc/plugins.js'
// 叶子路径,不走桶(与 platform/electron.ts 同规:桶会把 node-only 的 loader 拖进
// 浏览器包)。取的是权限披露文案的单一事实源。
import { describePluginPermission } from '@onething/core/plugins/sessions'
import { ref, computed, onBeforeUnmount, onMounted } from 'vue'
import { Bell, BellOff, Eye, EyeOff, RefreshCw } from 'lucide-vue-next'
import { platformApi } from '@/platform'
import { useSettingsStore } from '@/stores/settings'
import { previewPluginNotifySound } from '@/services/plugin-notify-sound'
import { isUiSlotTruncated } from '@/workspace/ui-anchor-registry'
import { toPlainData } from '@/workspace/plain-data'
import { useConfirm } from '@/composables/useConfirm'
import { useFileDrop } from '@/composables/useFileDrop'
import { toast } from '@/composables/useToast'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.plugins')

interface PluginInfo {
  id: string
  source?: 'builtin' | 'user'
  name: string
  version: string
  description: string
  author: string
  loaded: boolean
  enabled: boolean
  commands: string[]
  error: string
  dirPath: string
  healthStatus?: string
  healthFailures?: number
  healthReason?: string
  /** 降级中的界面(R7):某个面板不可用,而插件其余能力照常。 */
  degradedSurfaces?: Array<{ surface: string; reason: string }>
  minAppVersion?: string
  requestActions?: string[]
  contributes?: {
    commands?: string[]
    /**
     * 面板(R5)。C 期起逐条带形态与判决:`view` 是 descriptor / webview,
     * `unsupported` = 这条 webview 声明非法(该面板不渲染),`reason` 是人话。
     */
    panels?: Array<{
      id: string
      label: string
      view?: string
      entry?: string
      unsupported?: boolean
      reason?: string
    }>
    /** `lifetime` 是消息态落盘的闸门声明(见 slotIsPersistent);市场那条路是 manifest 原文。 */
    uiSlots?: Array<{ anchor: string; id: string; label: string; unsupported?: boolean; lifetime?: string }>
    /**
     * 主题 token 覆盖(B 期,L2)—— **投影后的逐条裁决**,不是 manifest 原文。
     * 谁压谁要看全体插件,renderer 只拿到单张卡片判不出来,所以裁决在主进程
     * 的清单投影里做完再下来(市场那条路走 manifest 原文,形状不同,见 MarketContributes)。
     */
    theme?: Array<{
      token: string
      value: string
      status: 'active' | 'shadowed' | 'inactive' | 'invalid'
      reason?: 'unknown-token' | 'invalid-color'
      shadowedBy?: string
    }>
    /**
     * 皮肤包(H3)—— 同样是**投影后的逐条裁决**,四态与 token 覆盖同一套词。
     * 值是**档位名**而不是 CSS 值:插件选档,宿主查表。
     */
    skin?: Array<{
      knob: string
      tier: string
      status: 'active' | 'shadowed' | 'inactive' | 'invalid'
      reason?: 'unknown-knob' | 'unknown-tier'
      shadowedBy?: string
    }>
    /**
     * 背景层(G 期,L2.5)—— 同样是**投影后的裁决**,`null` = 没声明。
     * 背景全局只有一块,所以这里是单条而不是数组。
     */
    background?: {
      status: 'active' | 'shadowed' | 'inactive' | 'invalid'
      image: string
      darkImage: string
      opacity: number
      blur: number
      fit: string
      reason?: string
      shadowedBy?: string
    } | null
    /**
     * 氛围层(G2 —— 全窗动画覆盖)—— 同样是**投影后的裁决**,`null` = 没声明。
     * 氛围全窗只有一层,所以这里是单条而不是数组。
     */
    ambient?: {
      status: 'active' | 'shadowed' | 'inactive' | 'invalid'
      entry: string
      reason?: string
      shadowedBy?: string
    } | null
    hasSettingsSchema?: boolean
    permissions?: string[]
    activationEvents?: string[]
  }
  configFields?: PluginConfigFieldDescriptor[]
  configTitle?: string
  configValues?: Record<string, unknown>
  configUnsupportedReasons?: string[]
  configValuesAreDefaults?: boolean
  configEditable?: boolean
}

/**
 * 配置区草稿。
 *
 * 编辑先落在本地草稿上、Save 才过 IPC ——「保存即生效」而不是「每敲一个字符就
 * 写一次盘并推一遍 onChange」。
 */
const drafts = ref<Record<string, Record<string, unknown>>>({})
const configErrors = ref<Record<string, PluginConfigErrorDetail[]>>({})
/**
 * string-list 的编辑期文本态。
 *
 * 只存原始字符串:每敲一键就 split+trim+filter 再 join 回去是有损往返,
 * 输入的逗号会被自己吃掉,第二项永远打不出来。blur 时才 parse 成数组。
 */
const stringListText = ref<Record<string, string>>({})
// per-plugin 而不是单个 id:两个插件同时保存时,单值状态会互相顶掉。
const savingPlugins = ref<Set<string>>(new Set())
const savedPlugins = ref<Set<string>>(new Set())
const savedTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * 可编辑性以**投影字段**为准,环境只作缺省。
 * 宿主自己最清楚它能不能写(方案 A 下 server 侧投影会给 false)。
 */
function isConfigEditable(plugin: PluginInfo): boolean {
  return plugin.configEditable ?? (platformApi.environment !== 'web')
}

/**
 * InputNumber 的 step:整数字段 1;量程恰好落在 0~1 的比例字段(插件里的
 * 透明度、模糊度一类)给 0.05 —— 不给 step 会回退成 1,箭头只能在 0 和 1
 * 之间跳,中间值根本点不出来。其余非整数字段维持组件默认。
 */
function numberFieldStep(field: PluginConfigFieldDescriptor): number | undefined {
  if (field.integer) return 1
  if (field.minimum === 0 && field.maximum === 1) return 0.05
  return undefined
}

function fieldKey(plugin: PluginInfo, key: string): string {
  return `${plugin.id}::${key}`
}

function fieldError(plugin: PluginInfo, key: string): string {
  return configErrors.value[plugin.id]?.find(item => item.key === key)?.message ?? ''
}

function generalErrors(plugin: PluginInfo): string[] {
  return (configErrors.value[plugin.id] ?? []).filter(item => !item.key).map(item => item.message)
}

function hasConfigArea(plugin: PluginInfo): boolean {
  return Boolean(plugin.configFields?.length) || Boolean(plugin.configUnsupportedReasons?.length)
}

function baselineFor(plugin: PluginInfo): Record<string, unknown> {
  return plugin.configValues ?? {}
}

function draftFor(plugin: PluginInfo): Record<string, unknown> {
  return drafts.value[plugin.id] ?? baselineFor(plugin)
}

function setDraft(plugin: PluginInfo, key: string, value: unknown): void {
  drafts.value = {
    ...drafts.value,
    [plugin.id]: { ...draftFor(plugin), [key]: value },
  }
  savedPlugins.value = withoutId(savedPlugins.value, plugin.id)
}

function resetDraft(plugin: PluginInfo): void {
  const { [plugin.id]: _dropped, ...rest } = drafts.value
  drafts.value = rest
  stringListText.value = Object.fromEntries(
    Object.entries(stringListText.value).filter(([key]) => !key.startsWith(`${plugin.id}::`)),
  )
  configErrors.value = { ...configErrors.value, [plugin.id]: [] }
}

function isDirty(plugin: PluginInfo): boolean {
  const draft = drafts.value[plugin.id]
  if (!draft) return false
  return JSON.stringify(draft) !== JSON.stringify(baselineFor(plugin))
}

function parseStringList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

/** 编辑中显示本地文本;没在编辑就由数组现算。 */
function stringListDraft(plugin: PluginInfo, key: string): string {
  const pending = stringListText.value[fieldKey(plugin, key)]
  if (pending !== undefined) return pending
  const value = draftFor(plugin)[key]
  return Array.isArray(value) ? value.join(', ') : ''
}

function setStringListText(plugin: PluginInfo, key: string, text: string): void {
  stringListText.value = { ...stringListText.value, [fieldKey(plugin, key)]: text }
  savedPlugins.value = withoutId(savedPlugins.value, plugin.id)
}

function commitStringList(plugin: PluginInfo, key: string): void {
  const pending = stringListText.value[fieldKey(plugin, key)]
  if (pending === undefined) return
  const { [fieldKey(plugin, key)]: _dropped, ...rest } = stringListText.value
  stringListText.value = rest
  setDraft(plugin, key, parseStringList(pending))
}

/**
 * 文件导入字段(schema `format: 'file-import'`)。
 *
 * **判例**:选文件是配置,配置的家是设置页;面板留给活内容。此前宿主的
 * schema 子集没有文件控件,于是"选图"只能借 file-pick 节点落进工作台面板 ——
 * 能力缺口把 UX 拽错了位置。这一段就是把那条路补回设置页。
 *
 * 走的是**既有**的托管导入链:宿主拉原生对话框、宿主校验、宿主拷进这个插件
 * 的数据目录,回来的只有一个 `storage:` 地址。字节与用户的原路径一步也不进
 * 这一层,所以"选一张壁纸"不需要给插件开任何读文件的权限。
 */
const pickingFields = ref<Set<string>>(new Set())

/** 有值才有得清。空值照旧显示 `No file chosen`,那时钮不该在。 */
function hasFileValue(plugin: PluginInfo, key: string): boolean {
  const value = draftFor(plugin)[key]
  return typeof value === 'string' && value.length > 0
}

/**
 * 清空一个已选文件(恢复默认闭环,2026-08-10)。
 *
 * 置**空字符串**而不是删键:字段类型是 string、schema 缺省也是空串 ——
 * 删键会让保存时的形状看起来像"这个字段没提过",而用户表达的是"我把它清掉了"。
 * 空串走的是与选中完全相同的那条 Save 路径(setPluginConfig),不为清空发明
 * 第二条保存语义。
 *
 * **孤儿文件不删**:字节在"选中"那一刻就已经拷进插件数据目录了,清空只撤引用。
 * 数据的归宿是卸载时的归档语义(与 pickConfigFile 里那条判例逐字同规)——
 * 一次清空就去删磁盘上的文件,等于让设置页替插件做数据生命周期的决定,而这个
 * 地址插件可能还存在自己的 store 里。
 */
function clearConfigFile(plugin: PluginInfo, key: string): void {
  if (!isConfigEditable(plugin)) return
  setDraft(plugin, key, '')
}

/** 值是 `storage:imports/<name>` 这样的地址 —— 显示尾段(文件名)就够了。 */
function fileValueLabel(plugin: PluginInfo, key: string): string {
  const value = draftFor(plugin)[key]
  if (typeof value !== 'string' || !value) return 'No file chosen'
  const tail = value.split('/').pop()
  return tail || value
}

/**
 * 选目录字段(schema `format: 'directory-pick'`,F1 外部根)。
 *
 * 与 pickConfigFile 的关键差别:file-import 走托管导入(字节拷进插件数据目录,
 * 值是 storage: 地址);这里的值**就是用户目录的绝对路径**——插件经
 * `storage:external-root` 权限读写它,卸载不动它。所以这条路没有导入、没有
 * 校验裁决,只有一次原生对话框 + 写 draft,保存走普通 Save。
 */
async function pickConfigDirectory(plugin: PluginInfo, field: PluginConfigFieldDescriptor): Promise<void> {
  try {
    const result = await platformApi.showOpenDialog({
      title: field.label,
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return
    setDraft(plugin, field.key, result.filePaths[0])
  } catch {
    // 对话框打不开(如 web 宿主):保持现状,文本框兜底路径仍可用。
  }
}

async function pickConfigFile(plugin: PluginInfo, field: PluginConfigFieldDescriptor): Promise<void> {
  const id = fieldKey(plugin, field.key)
  if (pickingFields.value.has(id) || !isConfigEditable(plugin)) return
  pickingFields.value = withId(pickingFields.value, id)
  try {
    // accept 来自响应式的字段表,是 Vue 的 Proxy —— 原样递过边界会炸
    // "An object can't be cloned"。边界铁律见 toPlainData 的文档(同病已犯两次)。
    const result = await platformApi.pickPluginFile(toPlainData({
      pluginId: plugin.id,
      accept: field.accept,
      maxBytes: field.maxBytes,
      label: field.label,
    }))
    // 取消 = **不是失败**:什么也不做,草稿不脏。
    if (result?.canceled) return
    if (result?.error) {
      toast.error(result.error)
      return
    }
    if (!result?.path) return
    // 只写草稿:与其余字段同一条路,Save 才落盘(setPluginConfig)。
    // 代价是诚实的 —— 字节在"选中"那一刻就已经拷进插件数据目录了,选完又
    // Reset 会在 imports/ 里留下一个没人引用的文件。宁可留一份孤儿数据,
    // 也不要为一个字段破例发明"点一下就直接落盘"的第二条保存语义。
    setDraft(plugin, field.key, result.path)
  } catch (e) {
    toast.error((e as Error)?.message || 'That file could not be imported.')
  } finally {
    pickingFields.value = withoutId(pickingFields.value, id)
  }
}

function withId(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  next.add(id)
  return next
}

function withoutId(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  next.delete(id)
  return next
}

async function saveConfig(plugin: PluginInfo): Promise<void> {
  // 先把编辑中的文本态收敛成数组,否则刚敲完还没失焦的那一项会丢。
  for (const field of plugin.configFields ?? []) {
    if (field.control === 'string-list') commitStringList(plugin, field.key)
  }

  savingPlugins.value = withId(savingPlugins.value, plugin.id)
  configErrors.value = { ...configErrors.value, [plugin.id]: [] }
  // 快照本次要保存的草稿:飞行期用户可能接着改,那份新脏态不该被 reset 抹掉。
  const submitted = JSON.stringify(draftFor(plugin))
  try {
    const result = await platformApi.setPluginConfig(plugin.id, JSON.parse(submitted))
    if (result?.success) {
      plugin.configValues = result.config ?? JSON.parse(submitted)
      if (JSON.stringify(draftFor(plugin)) === submitted) resetDraft(plugin)
      markSaved(plugin.id)
      emit('plugins-changed')
    } else {
      configErrors.value = {
        ...configErrors.value,
        [plugin.id]: result?.errors?.length
          ? result.errors
          : [{ message: result?.error || 'Failed to save plugin config' }],
      }
    }
  } catch (e: any) {
    configErrors.value = {
      ...configErrors.value,
      [plugin.id]: [{ message: e?.message || 'Failed to save plugin config' }],
    }
  } finally {
    savingPlugins.value = withoutId(savingPlugins.value, plugin.id)
  }
}

const uninstallingPlugins = ref<Set<string>>(new Set())
const { confirm } = useConfirm()

/** 内置插件没有卸载;web 端(方案 A)也不提供。 */
function canUninstall(plugin: PluginInfo): boolean {
  return plugin.source === 'user' && platformApi.environment !== 'web'
}

/**
 * 卸载 —— 措辞必须把"停用 vs 卸载"的差别说清楚:
 * 停用保留数据原地,卸载归档数据并删掉插件代码。
 */
/**
 * 把足迹说成人话。
 *
 * R4 已经能枚举"这个插件在盘上占了什么",但那份清单一直没有出口 ——
 * 用户在确认框里只能读到一句"数据会被归档",却看不到归档的是**什么**。
 * 这里把它摊开:目录条目数 / 是否有历史 KV / 设置键数。
 */
async function describeFootprint(pluginId: string): Promise<string> {
  try {
    const result = await platformApi.getPluginFootprint(pluginId)
    if (!result?.success || !result.footprint) return ''
    const { dataDirExists, entries, legacyKvExists, settingsKeys } = result.footprint
    const parts: string[] = []
    if (dataDirExists && entries.length) {
      // "items" 而不是 "files":entries 是目录的**顶层条目**,插件自建的子目录
      // 也算一条。说成 "3 files" 而用户点进去看到两个文件夹,数字就变成谎话。
      parts.push(entries.length === 1 ? '1 item in its data folder' : `${entries.length} items in its data folder`)
    }
    if (legacyKvExists) parts.push('its key-value store')
    // settingsKeys 是 plugin-settings 里的三个键(enabled / config / health),
    // 但只有 config 是**用户存的设置** —— enabled 是启停位、health 是熔断台账,
    // 把它们数进 "saved settings" 会让一个从没配置过的插件显示 "2 saved settings"。
    if (settingsKeys.includes('config')) parts.push('its saved configuration')
    // 什么都没写过的插件,如实说"没有数据" —— 比含糊的"数据会被归档"更可信。
    if (!parts.length) return 'It has not stored any data.'
    return `Will be archived: ${parts.join(', ')}.`
  } catch {
    // 足迹只是知情用的补充说明,读不到不该拦住卸载本身。
    return ''
  }
}

async function confirmUninstall(plugin: PluginInfo): Promise<void> {
  const footprint = await describeFootprint(plugin.id)
  const accepted = await confirm({
    title: 'Uninstall plugin',
    // 路径不硬编码:store 根由 ONETHING_STORE_PATH 决定,写死 ~/.onething 会在
    // 自定义 store 下变成一句假话。相对表述对用户同样够用。
    message: `Uninstall "${plugin.name}"? Its package is removed and its data folder is moved into `
      + 'the plugins backup folder. Disabling instead keeps both in place.'
      // 确认框的正文是单段落(ConfirmHost 不保留换行),所以足迹接成同段的下一句,
      // 而不是塞一个会被折叠掉的空行。
      + (footprint ? ` ${footprint}` : ''),
    confirmText: 'uninstall',
    danger: true,
    variant: 'paper',
  })
  if (!accepted) return

  uninstallingPlugins.value = withId(uninstallingPlugins.value, plugin.id)
  try {
    const result = await platformApi.uninstallPlugin(plugin.id)
    if (result?.success) {
      toast.success(result.archivePath
        ? `Uninstalled ${plugin.name}. Data archived to ${result.archivePath}`
        : `Uninstalled ${plugin.name}`)
      await loadPlugins()
      emit('plugins-changed')
    } else {
      toast.error(result?.error || `Failed to uninstall ${plugin.name}`)
    }
  } catch (e: any) {
    toast.error(e?.message || `Failed to uninstall ${plugin.name}`)
  } finally {
    uninstallingPlugins.value = withoutId(uninstallingPlugins.value, plugin.id)
  }
}

/** Saved 提示是一次性的反馈,不是一种状态 —— 让它自己退场。 */
function markSaved(pluginId: string): void {
  savedPlugins.value = withId(savedPlugins.value, pluginId)
  clearTimeout(savedTimers.get(pluginId))
  const timer = setTimeout(() => {
    savedPlugins.value = withoutId(savedPlugins.value, pluginId)
    savedTimers.delete(pluginId)
  }, 2500)
  savedTimers.set(pluginId, timer)
}

/**
 * 消息态生命期披露(plugin-message-state-2026-08 §3.2)。
 *
 * 判据与宿主闸门逐字相同(`lifetime === 'persistent'`),而且**只在这里判一次** ——
 * 已装卡片走投影后的清单、市场确认页走未投影的 manifest 原文,两条路的形状不同
 * 但语义必须是同一句话:声明 persistent 的块会在用户的消息上留下持久内容。
 * 未知的未来值天然读成非持久,与宿主降级同规。
 */
function slotIsPersistent(slot: { lifetime?: string }): boolean {
  return slot.lifetime === 'persistent'
}

/** 披露文案 —— 用户看的是"会在我的消息上留下东西",不是 lifetime 这个词。 */
const PERSISTENT_SLOT_NOTE = 'leaves persistent content on your messages'

/**
 * 主题覆盖披露(B 期,L2)。
 *
 * 与 PERSISTENT_SLOT_NOTE 同规:**一句话只说一次**,已装卡片与装前确认页
 * 共用同一句措辞,只是取数的形状不同(卡片吃投影后的裁决,市场吃 manifest 原文)。
 * 用户要知道的是"这插件会改我的界面配色,改哪几处"。
 */
function themeOverrideNote(tokens: string[]): string {
  return `overrides theme colors (${tokens.join(', ')})`
}

/**
 * 皮肤包披露(H3)。
 *
 * 与 themeOverrideNote 同规:一句话只说一次,已装卡片与装前确认页共用同一句
 * 措辞。用户要知道的是"这插件会改界面的**形状**,改哪几处" —— 与"改配色"分开说,
 * 因为它们是两种不同的改动(颜色能被主题吞掉,形不能)。档位名一起念出来:
 * 用户对 `round` 是有直觉的,对 `bubbleRadius=round` 也是。
 */
function skinNote(entries: Array<{ knob: string; tier: string }>): string {
  const pairs = entries.map(entry => `${SKIN_KNOB_LABELS[entry.knob] ?? entry.knob}: ${entry.tier}`)
  return `changes UI shape (${pairs.join(', ')})`
}

/**
 * 旋钮名 → 用户读得懂的说法。未登记的旋钮原样显示(向前兼容:未来的宿主
 * 可能认识它,而这一版的界面不该假装它不存在)。
 */
const SKIN_KNOB_LABELS: Record<string, string> = {
  bubbleRadius: 'bubble corners',
}

/**
 * webview 面板披露(C 期,L3)。
 *
 * 与上面两句同规:一句话只说一次,已装卡片与装前确认页共用同一句措辞。
 * 用户要知道的是"这插件会在应用里跑它自己的界面代码" —— 沙箱、无网络、
 * 只能 postMessage 这些细节不进这句话(它们是宿主的保证,不是用户的选择)。
 */
const WEBVIEW_PANEL_NOTE = 'runs sandboxed UI code'

/**
 * 背景层披露(G 期,L2.5)。
 *
 * 与上面三句同规:一句话只说一次,已装卡片与装前确认页共用同一句措辞。
 * 用户要知道的是"这插件会给应用铺一张背景图" —— 图从哪来(包内资产、
 * 走 onething-plugin:// 协议、不出网)是宿主的保证,不进这句话。
 */
const BACKGROUND_NOTE = 'sets an app background image'

/**
 * 氛围层披露(G2 —— 全窗动画覆盖)。
 *
 * 与上面几句同规:一句话只说一次,已装卡片与装前确认页共用同一句措辞。
 * 用户要知道的是"这插件会在整个窗口上画动效"—— 沙箱、点击穿透、内容之上、
 * 每层浮层之下这些是宿主的保证,不进这句话。
 */
const AMBIENT_NOTE = 'draws animated effects over the window'

/**
 * 权限披露(N1)。
 *
 * 与上面四句同规:一句话只说一次,已装卡片与装前确认页共用同一句措辞。
 * 枚举名(`sessions:trigger`)是给作者看的,用户要读的是"它能对我的会话做什么"——
 * 口径的单一事实源在 core 的 `PLUGIN_SESSION_PERMISSION_NOTES`,这里只是调用点,
 * 于是新增一个权限枚举时不会出现"宿主判了、界面没说"的漂移。未登记的权限名
 * 原样显示(向前兼容:未来的宿主可能认识它)。
 */
function permissionNotes(permissions: string[]): string {
  return `permissions: ${permissions.map(describePluginPermission).join('; ')}`
}

/** 判据只在这里判一次:已装卡片走投影后的清单,市场走 manifest 原文。 */
function isWebviewPanel(panel: { view?: string }): boolean {
  return panel.view === 'webview'
}

/**
 * manifest 声明的贡献点摘要 —— 一行标签,不是 UI 工程。
 * R2 只让它可见;渲染面板、渲染设置表单分别是 R5 与 R3 的事。
 */
function contributesSummary(plugin: PluginInfo): string[] {
  const contributes = plugin.contributes
  const summary: string[] = []
  // 非法的 webview 声明:面板不渲染,但"为什么没出现"必须能查到 ——
  // 与未知锚点同一条呈现规矩(降级不拒载,理由留在卡片上)。
  for (const panel of contributes?.panels ?? []) {
    if (panel.unsupported) {
      summary.push(`panel "${panel.label}" dropped — ${panel.reason || 'invalid declaration'}`)
    }
  }
  const livePanels = (contributes?.panels ?? []).filter(panel => !panel.unsupported)
  if (livePanels.length) {
    summary.push(`declares ${livePanels.length} panel${livePanels.length > 1 ? 's' : ''}`)
  }
  // L3 披露(C 期):webview 面板里跑的是插件自己的前端代码 —— 沙箱化、
  // 无网络、只能 postMessage,但它终究是**代码**,与描述树面板不是一回事。
  if (livePanels.some(isWebviewPanel)) summary.push(WEBVIEW_PANEL_NOTE)
  // 锚点块(R5.x):未知锚点(unsupported)与因容量被截断的块都要说得出来 ——
  // 它们不占界面,但用户得能在某处看到"这块为什么没出现"。
  for (const slot of contributes?.uiSlots ?? []) {
    if (slot.unsupported) {
      summary.push(`ui slot "${slot.label}" on unknown anchor "${slot.anchor}" (unsupported by this app version)`)
    } else if (isUiSlotTruncated(plugin.id, slot.anchor, slot.id)) {
      summary.push(`ui slot "${slot.label}" hidden — anchor "${slot.anchor}" is full`)
    }
  }
  const visibleSlots = (contributes?.uiSlots ?? [])
    .filter(slot => !slot.unsupported && !isUiSlotTruncated(plugin.id, slot.anchor, slot.id))
  if (visibleSlots.length) {
    summary.push(`declares ${visibleSlots.length} ui slot${visibleSlots.length > 1 ? 's' : ''}`)
  }
  // 生命期披露:装完之后也看得见(装前确认页只出现一次,卡片是长期可查的那一处)。
  const persistentSlots = (contributes?.uiSlots ?? []).filter(slotIsPersistent)
  if (persistentSlots.length) {
    summary.push(PERSISTENT_SLOT_NOTE)
  }
  // 主题 token 覆盖(B 期):覆盖是**全局**的,所以卡片必须把三件事都说出来 ——
  // 改了哪几个 token、哪几条被更后的插件压过、哪几条根本不合法被丢了。
  // 顺序固定(生效 → 被压 → 非法),同一插件集合两次渲染逐字节一致。
  const themeEntries = contributes?.theme ?? []
  const activeTokens = themeEntries.filter(entry => entry.status === 'active').map(entry => entry.token)
  if (activeTokens.length) summary.push(themeOverrideNote(activeTokens))
  const inactiveTokens = themeEntries.filter(entry => entry.status === 'inactive').map(entry => entry.token)
  if (inactiveTokens.length) {
    summary.push(`${themeOverrideNote(inactiveTokens)} — inactive while disabled`)
  }
  for (const entry of themeEntries.filter(item => item.status === 'shadowed')) {
    summary.push(`theme "${entry.token}" overridden by "${entry.shadowedBy}"`)
  }
  for (const entry of themeEntries.filter(item => item.status === 'invalid')) {
    summary.push(entry.reason === 'unknown-token'
      ? `theme override "${entry.token}" dropped — not a theme token`
      : `theme override "${entry.token}" dropped — not an allowed color value`)
  }
  // 皮肤包(H3):与 token 覆盖同一条呈现规矩,顺序也一样(生效 → 被压 → 非法)。
  // 皮肤是**全局**的(一个旋钮全窗一个档位),所以卡片同样必须把三件事说全。
  const skinEntries = contributes?.skin ?? []
  const activeSkin = skinEntries.filter(entry => entry.status === 'active')
  if (activeSkin.length) summary.push(skinNote(activeSkin))
  const inactiveSkin = skinEntries.filter(entry => entry.status === 'inactive')
  if (inactiveSkin.length) {
    summary.push(`${skinNote(inactiveSkin)} — inactive while disabled`)
  }
  for (const entry of skinEntries.filter(item => item.status === 'shadowed')) {
    summary.push(`skin "${entry.knob}" overridden by "${entry.shadowedBy}"`)
  }
  for (const entry of skinEntries.filter(item => item.status === 'invalid')) {
    summary.push(entry.reason === 'unknown-knob'
      ? `skin "${entry.knob}" dropped — not a skin option`
      : `skin "${entry.knob}" dropped — "${entry.tier}" is not one of its presets`)
  }
  // 背景层(G 期):与 token 覆盖同一条呈现规矩 —— 生效 / 被压 / 停用中 / 非法,
  // 四态都要说得出来。背景全局只有一块,所以这里是单条而不是一串。
  const background = contributes?.background
  if (background) {
    if (background.status === 'active') summary.push(BACKGROUND_NOTE)
    else if (background.status === 'inactive') summary.push(`${BACKGROUND_NOTE} — inactive while disabled`)
    else if (background.status === 'shadowed') summary.push(`background overridden by "${background.shadowedBy}"`)
    else summary.push(`background dropped — ${background.reason || 'invalid declaration'}`)
  }
  // 氛围层(G2):与背景层同一条呈现规矩 —— 生效 / 被压 / 停用中 / 非法,四态都
  // 要说得出来。氛围全窗只有一层,所以这里是单条而不是一串。用户的总闸 / 每插件
  // 静音是**另一码事**(它决定"要不要画",不改这条"声明合不合法")。
  const ambient = contributes?.ambient
  if (ambient) {
    if (ambient.status === 'active') summary.push(AMBIENT_NOTE)
    else if (ambient.status === 'inactive') summary.push(`${AMBIENT_NOTE} — inactive while disabled`)
    else if (ambient.status === 'shadowed') summary.push(`ambient overridden by "${ambient.shadowedBy}"`)
    else summary.push(`ambient dropped — ${ambient.reason || 'invalid declaration'}`)
  }
  if (contributes?.commands?.length) {
    summary.push(`declares ${contributes.commands.length} command${contributes.commands.length > 1 ? 's' : ''}`)
  }
  if (contributes?.hasSettingsSchema) summary.push('declares settings')
  if (contributes?.permissions?.length) {
    summary.push(permissionNotes(contributes.permissions))
  }
  if (contributes?.activationEvents?.length) {
    summary.push(`activation: ${contributes.activationEvents.join(', ')}`)
  }
  if (plugin.requestActions?.length) {
    summary.push(`actions: ${plugin.requestActions.join(', ')}`)
  }
  if (plugin.minAppVersion) summary.push(`needs app >= ${plugin.minAppVersion}`)
  return summary
}

/** 运行期故障文案:熔断说明优先,其次最后一次失败。'' = 没有故障。 */
function runtimeFault(plugin: PluginInfo): string {
  // 界面降级要如实说成"某个面板不可用",不能说成插件坏了 —— 插件的工具/命令/
  // 提示词此刻完全正常。但它**不能盖掉自动禁用的原因**:那是 R1 花一整期
  // 持久化并暴露出来的字段,被一句面板文案顶掉就等于从 UI 上消失了。
  // 两者都在时并列显示,禁用原因排前面(它更严重)。
  const degraded = plugin.degradedSurfaces ?? []
  const degradedLine = degraded.length
    ? `${degraded.map(entry => entry.surface).join(', ')} switched off — ${degraded[0].reason}`
    : ''

  // 自动禁用的原因**永远优先**:那是 R1 花一整期持久化并暴露的字段,
  // 被一句面板文案顶掉就等于从 UI 上消失。
  if (plugin.healthStatus === 'disabled' && plugin.healthReason) {
    return degradedLine
      ? `Auto-disabled — ${plugin.healthReason} · ${degradedLine}`
      : `Auto-disabled — ${plugin.healthReason}`
  }

  // **纯面板降级只说一句。** healthReason 在没有 disabledReason 时会回退到
  // `lastErrorScope: lastError`,而那恰恰是同一次降级的原始错误 —— 两句都印
  // 会得到 "3 consecutive failure(s) — request:panel:render:logs: boom ·
  // panel:logs switched off — 3 consecutive failures in …",同一件事说两遍。
  if (degradedLine) return degradedLine

  if (!plugin.healthReason) return ''
  if (plugin.healthStatus === 'degraded') {
    return `${plugin.healthFailures ?? 1} consecutive failure(s) — ${plugin.healthReason}`
  }
  return plugin.healthReason
}

function statusOf(plugin: PluginInfo): { label: string; tone: string } {
  if (plugin.healthStatus === 'disabled' && plugin.healthReason) return { label: 'Failed', tone: 'error' }
  // 降级只影响一个界面 —— 卡片说 "Partly degraded",不是 Failed。
  // (排在 disabled 判断之后:插件真被禁用时那才是主要事实。)
  if (plugin.loaded && plugin.degradedSurfaces?.length) return { label: 'Partly degraded', tone: 'warning' }
  if (plugin.error) return { label: 'Error', tone: 'error' }
  if (plugin.loaded && plugin.healthStatus === 'degraded') return { label: 'Degraded', tone: 'warning' }
  if (plugin.loaded) return { label: 'Active', tone: 'loaded' }
  return { label: 'Disabled', tone: 'stopped' }
}

const plugins = ref<PluginInfo[]>([])
const loading = ref(true)
const error = ref('')

const samplePluginsPath = ref('~/data/code/start-electron')

const emit = defineEmits<{
  'plugins-changed': []
}>()

// ── 提示音主权(M1)────────────────────────────────
//
// 存在既有的 app settings(`settings.plugins`),不新造存储:"谁被静音"是宿主的
// 账,插件既读不到也改不了,所以它不该落在插件自己的 config.json 里。

const settingsStore = useSettingsStore()

const notifySoundsEnabled = computed(() => settingsStore.settings.plugins?.notifySoundsEnabled !== false)
const mutedPluginIds = computed(() => settingsStore.settings.plugins?.notifySoundMutedPluginIds ?? [])
// 氛围主权(G2)。与提示音同规:总闸 + 每插件静音,存 app settings 而不是插件目录。
const ambientEnabled = computed(() => settingsStore.settings.plugins?.ambientEnabled !== false)
const ambientMutedPluginIds = computed(() => settingsStore.settings.plugins?.ambientMutedPluginIds ?? [])

function isMuted(pluginId: string): boolean {
  return mutedPluginIds.value.includes(pluginId)
}

function isAmbientMuted(pluginId: string): boolean {
  return ambientMutedPluginIds.value.includes(pluginId)
}

async function savePluginPreferences(patch: {
  notifySoundsEnabled?: boolean
  notifySoundMutedPluginIds?: string[]
  ambientEnabled?: boolean
  ambientMutedPluginIds?: string[]
}): Promise<void> {
  const current = settingsStore.settings
  // 四个字段全带上:plugins 是整体覆盖写,漏一个就被 normalize 填回缺省(把
  // 用户的另一半偏好吃掉)——settings 白名单吞字段的旧坑,这里显式列全。
  await settingsStore.saveSettings({
    ...current,
    plugins: {
      notifySoundsEnabled: notifySoundsEnabled.value,
      notifySoundMutedPluginIds: mutedPluginIds.value,
      ambientEnabled: ambientEnabled.value,
      ambientMutedPluginIds: ambientMutedPluginIds.value,
      ...patch,
    },
  })
}

// Switch 的 model 是 SwitchValue(布尔开关与分段控件共用一个组件),所以这里
// 收窄成布尔而不是直接标注 boolean。
async function setNotifySoundsEnabled(enabled: unknown): Promise<void> {
  await savePluginPreferences({ notifySoundsEnabled: enabled === true })
}

async function setAmbientEnabled(enabled: unknown): Promise<void> {
  await savePluginPreferences({ ambientEnabled: enabled === true })
}

async function toggleMute(pluginId: string): Promise<void> {
  const next = isMuted(pluginId)
    ? mutedPluginIds.value.filter(id => id !== pluginId)
    : [...mutedPluginIds.value, pluginId]
  await savePluginPreferences({ notifySoundMutedPluginIds: next })
}

async function toggleAmbientMute(pluginId: string): Promise<void> {
  const next = isAmbientMuted(pluginId)
    ? ambientMutedPluginIds.value.filter(id => id !== pluginId)
    : [...ambientMutedPluginIds.value, pluginId]
  await savePluginPreferences({ ambientMutedPluginIds: next })
}

/** 试听走 `chime` —— 六个音里最"叫人"的那个,最能听出开关有没有生效。 */
function previewNotifySound(): void {
  previewPluginNotifySound('chime')
}

async function loadPlugins() {
  // 加载行只给"屏上还没有列表"的场合(首载、出错重试)。启停/装卸/熔断推送后的
  // 重拉都是背景对账 —— 列表还在屏上,置 loading 会整屏换成加载行再换回来,
  // 肉眼就是一次闪烁。
  loading.value = plugins.value.length === 0
  error.value = ''
  try {
    const result = await platformApi.getPlugins()
    if (result?.success) {
      plugins.value = result.plugins || []
    } else {
      error.value = result?.error || 'Failed to load plugins'
    }
  } catch (e: any) {
    error.value = e.message || 'Unknown error'
  } finally {
    loading.value = false
  }
}

async function togglePlugin(plugin: PluginInfo) {
  const wasEnabled = plugin.enabled
  try {
    if (wasEnabled) {
      const result = await platformApi.disablePlugin(plugin.id)
      if (result?.success) {
        // 乐观置位让开关立刻落位(enable 分支同款);清账仍在后端
        // (disableOnethingPluginForIpc 清 tracker),随后重拉拿后端的事实。
        plugin.enabled = false
        await loadPlugins()
        emit('plugins-changed')
      } else {
        log.error('plugin disable failed', { pluginId: plugin.id, error: result?.error })
      }
    } else {
      const result = await platformApi.enablePlugin(plugin.id)
      if (result?.success) {
        plugin.enabled = true
        // Reload list to get updated state
        await loadPlugins()
        emit('plugins-changed')
      } else {
        log.error('plugin enable failed', { pluginId: plugin.id, error: result?.error })
      }
    }
  } catch (e: any) {
    log.error('plugin toggle failed', { pluginId: plugin.id }, e)
  }
}

async function refreshPlugins() {
  try {
    const result = await platformApi.refreshPlugins()
    if (!result?.success) {
      log.error('plugin refresh failed', { error: result?.error })
    }
  } catch (e: any) {
    log.error('plugin refresh failed', {}, e)
  }
  await loadPlugins()
  emit('plugins-changed')
}

// ── P1:npm 生命周期 —— 装/更/查更新 + 无 npm 置灰(裁决 8)。──

/** null = 还在探测;false = 无 npm,Install/Update 置灰并说明。 */
const npmAvailable = ref<boolean | null>(null)
const installPath = ref('')
const installing = ref(false)
/**
 * 批量装前预读出来的清单 —— 一次可选/拖投多个 tarball(file: 开发通道)。
 * 每条各自带预读态:`reading` 时显示进度,`error` 时单独标红(不阻塞其它能装的),
 * `summary` 就绪时给披露摘要。**包名不再由用户手输** —— 它写在 tarball 里的
 * package.json,宿主读得到;安装链装后还会拿包内 name 再校一次,预读只是把这份
 * 情报提前到用户点头之前(它不是信任来源)。
 */
interface InstallEntry {
  path: string
  reading: boolean
  summary?: PluginTarballSummary
  error?: string
}
const installEntries = ref<InstallEntry[]>([])
/** 表单级错误(不属于任何一个 tarball,如拖投里解析不出本机路径)。 */
const installError = ref('')
/** 手贴路径边打边预读没有意义;停手 300ms 才读。选文件/拖投则立刻读。 */
let tarballReadTimer: ReturnType<typeof setTimeout> | null = null
/** 预读是异步的,路径可能已经又变了 —— 只认最后一次发出的那一轮。 */
let tarballReadSeq = 0
/** 有摘要即可装(manifestIssue 不拦:装得上但不会加载,让用户自己判)。 */
const installableEntries = computed(() => installEntries.value.filter(entry => entry.summary))
const installLabel = computed(() => {
  if (installing.value) return 'Installing…'
  const count = installableEntries.value.length
  return count > 1 ? `Install ${count} plugins` : 'Install'
})
/** pluginId → { current, latest };"有更新"徽标与 Update 按钮的数据源。 */
const updateOffers = ref<Map<string, { current: string; latest: string }>>(new Map())
const updatingPlugins = ref<Set<string>>(new Set())

async function loadLifecycleInfo(): Promise<void> {
  try {
    const info = await platformApi.getPluginLifecycleInfo()
    npmAvailable.value = info?.success ? info.npmAvailable : false
  } catch {
    npmAvailable.value = false
  }
}

async function loadUpdateOffers(): Promise<void> {
  try {
    const result = await platformApi.checkPluginUpdates()
    if (result?.success) {
      updateOffers.value = new Map(
        (result.offers ?? []).map(offer => [offer.pluginId, { current: offer.current, latest: offer.latest }]),
      )
    }
  } catch {
    // 徽标缺席不挡页面 —— 无市场索引时更新通道本来就是关的。
  }
}

/**
 * 批量预读一组本地 .tgz:每个各自出包名/版本/声明。
 *
 * 预读是只读的(不碰账本),所以并行 —— 串行留给真正会写 plugins/package.json
 * 的安装环节。失败一律照实说(结构化原因由主进程给),而且**逐条**失败:一个
 * 读不了不该拖垮其它能装的。装到一半被回滚比装之前被拒绝贵得多。
 */
async function readEntries(paths: string[]): Promise<void> {
  const seq = ++tarballReadSeq
  installEntries.value = paths.map(path => ({ path, reading: true }))
  await Promise.all(paths.map(async (path, index) => {
    try {
      const result = await platformApi.readPluginTarball(path.trim())
      if (seq !== tarballReadSeq) return
      const entry = installEntries.value[index]
      if (!entry) return
      if (result?.success && result.summary) {
        entry.summary = result.summary
        entry.error = undefined
      } else {
        entry.error = result?.error || 'Could not read this tarball'
      }
      entry.reading = false
    } catch (e: any) {
      if (seq !== tarballReadSeq) return
      const entry = installEntries.value[index]
      if (!entry) return
      entry.error = e?.message || 'Could not read this tarball'
      entry.reading = false
    }
  }))
}

function readNow(paths: string[]): void {
  if (tarballReadTimer) clearTimeout(tarballReadTimer)
  tarballReadTimer = null
  void readEntries(paths)
}

function onInstallPathInput(value: string | number): void {
  const path = String(value ?? '')
  // 打字中先把旧摘要撤下来:摘要与输入框对不上是最坏的那种"看着像对的"。
  installEntries.value = []
  installError.value = ''
  if (tarballReadTimer) clearTimeout(tarballReadTimer)
  tarballReadTimer = setTimeout(() => {
    tarballReadTimer = null
    void readEntries(path.trim() ? [path] : [])
  }, 300)
}

/** 原生选择器:过滤 .tgz(npm pack 的产物),一次可多选批量装。 */
async function chooseTarball(): Promise<void> {
  if (npmAvailable.value === false || installing.value) return
  try {
    const result = await platformApi.showOpenDialog({
      title: 'Select a plugin tarball',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Plugin package', extensions: ['tgz'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return
    // 选一个时路径回填输入框(观感与从前一致);多选则清空输入框,由下面的条目
    // 列表承担呈现 —— 一个框装不下多条路径。
    installPath.value = result.filePaths.length === 1 ? result.filePaths[0] : ''
    installError.value = ''
    readNow(result.filePaths)
  } catch (e: any) {
    installError.value = e?.message || 'Could not open the file picker'
  }
}

// 拖投等价于"选中":复用聊天区那套 drop 状态机,别再造一个。一次可拖多个。
const { isDragActive: isTarballDragActive, dropHandlers: tarballDropHandlers } = useFileDrop({
  isDisabled: () => npmAvailable.value === false || installing.value,
  onFiles: files => {
    if (!files.length) return
    // file: 通道要的是本机路径;浏览器宿主拿不到路径,那里本来也不能装。
    const paths = files.map(file => platformApi.getPathForFile(file)).filter(Boolean)
    if (!paths.length) {
      installEntries.value = []
      installError.value = 'Could not resolve a local path for the dropped file'
      return
    }
    installPath.value = paths.length === 1 ? paths[0] : ''
    installError.value = ''
    readNow(paths)
  },
})

/** 每个待装 tarball 的声明清单 —— 与市场那条路同一个拼装器。 */
function entryDeclares(summary: PluginTarballSummary): string[] {
  return declaredContributions({
    contributes: summary.contributes as MarketContributes | undefined,
    ...(summary.minAppVersion ? { minAppVersion: summary.minAppVersion } : {}),
  })
}

async function installPlugin(): Promise<void> {
  const entries = installableEntries.value
  if (!entries.length || installing.value || npmAvailable.value === false) return
  installing.value = true
  // 串行装:账本是 plugins/package.json 单文件,并发 npm 会写账本竞态。单个失败
  // 不中断后续 —— 继续装剩下的,最后汇总一条。
  const installed: string[] = []
  let failed = 0
  try {
    for (const entry of entries) {
      // 包名用预读出来的 —— 安装链装后仍会拿包内 package.json 的 name 再校一次,
      // 对不上照旧回滚。这里省掉的是用户的抄写,不是那道闸。
      const { pkg, path } = entry.summary!
      try {
        const result = await platformApi.installPlugin({ pkg, path })
        if (result?.success) {
          installed.push(result.pluginId ?? pkg)
        } else {
          failed++
          toast.error(result?.error || `Failed to install ${pkg}`)
        }
      } catch (e: any) {
        failed++
        toast.error(e?.message || `Failed to install ${pkg}`)
      }
    }
    // 汇总:单个成功照旧报名字;批量全成报数;有成有败报 "Installed N, M failed"。
    // 全失败则只留上面逐条的 error toast,不再补一条空的成功。
    if (installed.length === 1 && !failed) {
      toast.success(`Installed ${installed[0]}`)
    } else if (installed.length && !failed) {
      toast.success(`Installed ${installed.length} plugins`)
    } else if (installed.length && failed) {
      toast.success(`Installed ${installed.length}, ${failed} failed`)
    }
    // 只要装上了至少一个就清场 + 刷一次列表(全部结束后统一刷,不是每装一个刷
    // 一次);全失败则保留条目原样,方便用户重试。
    if (installed.length) {
      installPath.value = ''
      installEntries.value = []
      installError.value = ''
      await loadPlugins()
      emit('plugins-changed')
    }
  } finally {
    installing.value = false
  }
}

async function updatePlugin(plugin: PluginInfo): Promise<void> {
  if (updatingPlugins.value.has(plugin.id) || npmAvailable.value === false) return
  updatingPlugins.value = new Set(updatingPlugins.value).add(plugin.id)
  try {
    const result = await platformApi.updatePlugin(plugin.id)
    if (result?.success) {
      toast.success(`Updated ${plugin.name} to v${result.version}`)
    } else {
      toast.error(result?.error || `Failed to update ${plugin.name}`)
    }
    await loadPlugins()
    await loadUpdateOffers()
    emit('plugins-changed')
  } catch (e: any) {
    toast.error(e?.message || `Failed to update ${plugin.name}`)
  } finally {
    const next = new Set(updatingPlugins.value)
    next.delete(plugin.id)
    updatingPlugins.value = next
  }
}

// ── P3:市场 —— 索引视图主进程 join 好,这里只渲染与过滤。──

/** 共享契约的 renderer 本地形:contributes 收窄成结构化声明。 */
/**
 * 市场条目带的是 **manifest 原文**(未投影)。
 *
 * 绝大部分字段与投影后的形状巧合地一致,但 `theme` 不是:投影后是逐条裁决的
 * 数组(需要全体插件才算得出谁压谁),manifest 原文是 `{ overrides: {...} }`。
 * 装前确认页只能说"它声明要改哪几个 token" —— 还没装,谈不上生效与被压。
 */
type MarketContributes = Omit<
  NonNullable<PluginInfo['contributes']>,
  'theme' | 'background' | 'ambient' | 'skin'
> & {
  // `skin` 同理(H3):投影后是逐条裁决的数组,manifest 原文是 `{ 旋钮: 档位 }`。
  theme?: {
    overrides?: Record<string, string>
    background?: { image?: string }
    skin?: Record<string, string>
  }
  // 氛围层(G2):市场那条路吃 manifest 原文,声明形状是 `{ entry }`,不是投影后
  // 的裁决 —— 装前只能说"它声明要在窗口上画动效",还没装,谈不上生效与被压。
  ambient?: { entry?: string }
}

interface MarketEntry {
  id: string
  pkg: string
  version: string
  description?: string
  author?: string
  minAppVersion?: string
  contributes?: MarketContributes
  tarballUrl: string
  integrity?: string
  repository?: string
  installedVersion: string | null
  hasUpdate: boolean
  versionBlockedReason: string | null
}

const marketEntries = ref<MarketEntry[]>([])
// 初值 true:首帧是加载中而不是闪一下"无匹配"(挂载即拉取,loading 先到)。
const marketLoading = ref(true)
const marketError = ref('')
/** 主进程把"展示的是上次缓存"算好送过来(stale),renderer 不猜。 */
const marketStale = ref(false)
/** stale 的失败原因(主进程随快照带来)。 */
const marketStaleReason = ref('')
const marketFetchedAt = ref<number | null>(null)
const marketQuery = ref('')
/** 装前确认展开中的条目 id —— 一次只确认一个,心智负担小。 */
const confirmingMarket = ref<string | null>(null)
const installingMarket = ref<Set<string>>(new Set())

const marketFetchedAtText = computed(() =>
  marketFetchedAt.value ? new Date(marketFetchedAt.value).toLocaleString() : 'unknown time')

/** 纯前端过滤(§8.2):id/description/author,索引就这么大,不值得服务端。 */
const filteredMarket = computed(() => {
  const query = marketQuery.value.trim().toLowerCase()
  if (!query) return marketEntries.value
  return marketEntries.value.filter(entry =>
    entry.id.toLowerCase().includes(query)
    || (entry.description ?? '').toLowerCase().includes(query)
    || (entry.author ?? '').toLowerCase().includes(query))
})

/**
 * 装前确认页的声明清单 —— contributesSummary 的"未装版"(无截断,无运行期事实)。
 *
 * 市场条目与本地 tarball 预读吃的都是 manifest **原文**,所以两条路共用这一个
 * 拼装器:同一份声明在哪条通道装,用户读到的字句就该一模一样。
 */
function declaredContributions(entry: { contributes?: MarketContributes; minAppVersion?: string }): string[] {
  const contributes = entry.contributes
  const declares: string[] = []
  if (contributes?.panels?.length) {
    declares.push(`${contributes.panels.length} panel${contributes.panels.length > 1 ? 's' : ''}`)
  }
  // L3 披露:装之前就要说清"它会在应用里跑自己的界面代码"。
  // 市场这条路吃的是 manifest 原文(未投影),所以判据直接看声明的 view。
  if ((contributes?.panels ?? []).some(isWebviewPanel)) declares.push(WEBVIEW_PANEL_NOTE)
  for (const slot of contributes?.uiSlots ?? []) {
    // 生命期跟在它所属的那一条槽后面 —— 用户要知道的是"哪一块会留下东西",
    // 不是"这插件某处会留下东西"。
    const lifetime = slotIsPersistent(slot) ? ` — ${PERSISTENT_SLOT_NOTE}` : ''
    declares.push(
      slot.unsupported
        ? `ui slot "${slot.label}" on anchor "${slot.anchor}" (unsupported by this app version)${lifetime}`
        : `ui slot "${slot.label}" on anchor "${slot.anchor}"${lifetime}`,
    )
  }
  // 主题 token 覆盖(B 期):装前就要说清"它会改你的界面配色"——
  // 覆盖是全局的,装完再发现比装前拒绝贵得多。
  const declaredTokens = Object.keys(contributes?.theme?.overrides ?? {})
  if (declaredTokens.length) declares.push(themeOverrideNote(declaredTokens))
  // 皮肤包(H3):装前就要说清"它会改界面的形状(气泡圆角…)"。皮肤同样是全局的,
  // 与配色分两句说 —— 用户对"改颜色"和"改形状"的容忍度不是一回事。这条路吃
  // manifest 原文,所以档位合法性要等装上之后才裁决得出,这里照念声明值。
  const declaredSkin = Object.entries(contributes?.theme?.skin ?? {})
    .map(([knob, tier]) => ({ knob, tier: String(tier) }))
  if (declaredSkin.length) declares.push(skinNote(declaredSkin))
  // 背景层(G 期):装前就要说清"它会给你的应用铺一张背景图"。这条路吃的是
  // manifest 原文,所以判据只看"声明了没有" —— 合法性要等装上之后才裁决得出。
  if (contributes?.theme?.background) declares.push(BACKGROUND_NOTE)
  // 氛围层(G2):装前就要说清"它会在整个窗口上画动效"。同样吃 manifest 原文,
  // 只看"声明了没有"。
  if (contributes?.ambient) declares.push(AMBIENT_NOTE)
  if (contributes?.commands?.length) {
    declares.push(`${contributes.commands.length} command${contributes.commands.length > 1 ? 's' : ''}`)
  }
  if (contributes?.hasSettingsSchema) declares.push('settings schema')
  if (contributes?.permissions?.length) {
    declares.push(permissionNotes(contributes.permissions))
  }
  if (contributes?.activationEvents?.length) {
    declares.push(`activation: ${contributes.activationEvents.join(', ')}`)
  }
  if (entry.minAppVersion) declares.push(`needs app >= ${entry.minAppVersion}`)
  return declares
}

/** 市场卡片的调用点(模板里读着更像人话)。 */
function marketDeclares(entry: MarketEntry): string[] {
  return declaredContributions(entry)
}

async function loadMarket(refresh = false): Promise<void> {
  marketLoading.value = true
  try {
    const result = await platformApi.getPluginMarket({ refresh })
    if (result?.success) {
      marketEntries.value = (result.entries ?? []) as MarketEntry[]
      marketStale.value = result.stale
      marketStaleReason.value = result.error ?? ''
      marketFetchedAt.value = result.fetchedAt
      marketError.value = ''
    } else {
      // 真空失败(连缓存都没有)才走这;有缓存时主进程是 success+stale。
      marketError.value = result?.error || 'Failed to load the plugin market'
      marketEntries.value = []
    }
  } catch (e: any) {
    marketError.value = e?.message || 'Failed to load the plugin market'
    marketEntries.value = []
  } finally {
    marketLoading.value = false
  }
}

async function installFromMarket(entry: MarketEntry): Promise<void> {
  if (installingMarket.value.has(entry.id) || npmAvailable.value === false) return
  installingMarket.value = withId(installingMarket.value, entry.id)
  try {
    const result = await platformApi.installPlugin({
      pkg: entry.pkg,
      tarballUrl: entry.tarballUrl,
      ...(entry.integrity ? { integrity: entry.integrity } : {}),
    })
    if (result?.success) {
      toast.success(`Installed ${result.pluginId ?? entry.id}`)
      confirmingMarket.value = null
      await loadPlugins()
      await loadMarket()
      await loadUpdateOffers()
      emit('plugins-changed')
    } else {
      toast.error(result?.error || `Failed to install ${entry.id}`)
    }
  } catch (e: any) {
    toast.error(e?.message || `Failed to install ${entry.id}`)
  } finally {
    installingMarket.value = withoutId(installingMarket.value, entry.id)
  }
}

async function updateMarketPlugin(entry: MarketEntry): Promise<void> {
  if (updatingPlugins.value.has(entry.id) || npmAvailable.value === false) return
  updatingPlugins.value = new Set(updatingPlugins.value).add(entry.id)
  try {
    const result = await platformApi.updatePlugin(entry.id)
    if (result?.success) {
      toast.success(`Updated ${entry.id} to v${result.version}`)
    } else {
      toast.error(result?.error || `Failed to update ${entry.id}`)
    }
    await loadPlugins()
    await loadMarket()
    await loadUpdateOffers()
    emit('plugins-changed')
  } catch (e: any) {
    toast.error(e?.message || `Failed to update ${entry.id}`)
  } finally {
    const next = new Set(updatingPlugins.value)
    next.delete(entry.id)
    updatingPlugins.value = next
  }
}

// 熔断自动禁用发生在后台(没有用户操作),设置页必须被推着刷新,否则卡片
// 会一直停在 Active —— "运行期错误不可见"正是 R1 要治的病。
function handlePluginsChanged(): void {
  void loadPlugins()
}

onMounted(() => {
  loadPlugins()
  loadLifecycleInfo()
  loadUpdateOffers()
  // 启动时拉一次(缓存优先,主进程有缓存则秒回;§8.2 "启动时 + 手动刷新")。
  loadMarket()
  window.addEventListener('onething:plugins-changed', handlePluginsChanged)
})

onBeforeUnmount(() => {
  window.removeEventListener('onething:plugins-changed', handlePluginsChanged)
  for (const timer of savedTimers.values()) clearTimeout(timer)
  savedTimers.clear()
  if (tarballReadTimer) clearTimeout(tarballReadTimer)
})
</script>

<style scoped>
/*
 * Plugins ledger — 画线风.
 * No fills, no radii: rows hang on hairlines, badges are outlined rings.
 * Toggle visuals and .section-title/.settings-card chrome come from the
 * SettingsPage :deep() layer.
 */
.tab-content {
  max-width: 720px;
}

.settings-section {
  margin-bottom: 28px;
}

.section-desc {
  font-size: 12px;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  margin: 0 0 14px;
  line-height: 1.5;
}

.section-desc code,
.empty-state .hint code,
.install-steps code {
  padding: 0;
  border-radius: 0;
  background: transparent;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--settings-ink-2, var(--ui-text-secondary-fg));
}

/* ── Plugin list: ledger rows, no card chrome ── */
.plugin-list {
  display: flex;
  flex-direction: column;
}

.plugin-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 0 8px;
  border-bottom: 1px solid var(--settings-rule, var(--ui-border-default-border));
  background: transparent;
}

.plugin-count {
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
}

.refresh-btn {
  margin-top: 0 !important;
  padding: 2px 8px;
  font-size: 11px;
}

.plugin-item {
  display: flex;
  align-items: flex-start;
  padding: 12px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--settings-rule-soft, var(--ui-border-subtle-border, var(--ui-border-default-border))) 55%, transparent);
}

.plugin-item:last-child {
  border-bottom: none;
}

/* Disabled plugin: faint ink + strike-through, not an opacity veil. */
.plugin-item.disabled .plugin-name {
  color: var(--settings-ink-4, var(--ui-text-faint-fg, var(--ui-text-muted-fg)));
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--settings-ink-4, var(--ui-text-faint-fg, var(--ui-text-muted-fg))) 60%, transparent);
}

.plugin-item.disabled .plugin-desc {
  color: var(--settings-ink-4, var(--ui-text-faint-fg, var(--ui-text-muted-fg)));
}

.plugin-body {
  flex: 1;
  min-width: 0;
}

.plugin-toggle {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  margin-left: 14px;
  margin-top: 4px;
}

/* 静音按钮:图标态,与同列的 Update / Uninstall 同一把尺寸。
   静音时降到次级前景色 —— 它是"关掉了一件事"的态,不是警告。 */
.mute-btn {
  margin-top: 0 !important;
  padding: 2px 6px;
  display: inline-flex;
  align-items: center;
  color: var(--ui-text-secondary);
}

.mute-btn.muted {
  color: var(--ui-text-tertiary);
}

.notify-sound-control {
  display: flex;
  align-items: center;
  gap: 10px;
}

.uninstall-btn {
  margin-top: 0 !important;
  padding: 2px 8px;
  font-size: 10px;
}

.uninstall-btn:hover {
  border-color: var(--ui-status-danger-border, var(--ui-status-danger-fg));
  color: var(--ui-status-danger-fg);
}

.plugin-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.plugin-name-row {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.plugin-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--settings-ink, var(--ui-text-primary-fg));
}

/* Badges: outlined rings, zero fill. */
.plugin-version {
  flex-shrink: 0;
  padding: 1px 7px;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
  border-radius: 999px;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
}

.status-badge {
  flex-shrink: 0;
  padding: 1px 7px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.status-badge.loaded {
  border-color: var(--ui-status-success-border, var(--ui-status-success-fg));
  color: var(--ui-status-success-fg);
}

.status-badge.error {
  border-color: var(--ui-status-danger-border, var(--ui-status-danger-fg));
  color: var(--ui-status-danger-fg);
}

.status-badge.warning {
  border-color: var(--ui-status-warning-border, var(--ui-status-warning-fg));
  color: var(--ui-status-warning-fg);
}

.status-badge.stopped {
  border-style: dashed;
  border-color: var(--settings-rule, var(--ui-border-default-border));
  color: var(--settings-ink-4, var(--ui-text-faint-fg, var(--ui-text-muted-fg)));
}

.plugin-desc {
  font-size: 12px;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  margin: 0;
  line-height: 1.45;
}

.plugin-meta {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 2px;
}

.meta-tag {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
}

.meta-tag.path {
  color: var(--settings-ink-4, var(--ui-text-faint-fg, var(--ui-text-muted-fg)));
}

/* 声明摘要:比运行态更轻的一行,读起来像清单而不是状态。 */
.plugin-meta.contributes {
  margin-top: 0;
}

.plugin-config {
  margin-top: 12px;
  padding: 12px 0 2px 14px;
  border-left: 1px solid color-mix(in srgb, var(--settings-rule, var(--ui-border-default-border)) 60%, transparent);
}

.plugin-config-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.plugin-config-title {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
}

.plugin-config-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.plugin-config-note {
  margin: 0 0 10px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--settings-ink-4, var(--ui-text-faint-fg, var(--ui-text-muted-fg)));
}

.plugin-config-saved {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--ui-status-success-fg);
}

.plugin-config-file {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* 文件名可能很长:让它自己截断,而不是把这一行的按钮挤出可视区。 */
.plugin-config-file-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
}

/* 清空钮:与 .btn-sm 同一族(画线风的方框),只把它压成一个方钮 ——
   margin-top 归零是因为它与值同行,不是另起一行的动作钮。
   悬停才转 danger 色:删掉一个已有的值是危险动作,但平时不该在那儿嚷。 */
.plugin-config-file-clear {
  flex-shrink: 0;
  margin-top: 0;
  padding: 1px 6px;
  line-height: 1.3;
}

.plugin-config-file-clear:hover {
  border-color: var(--ui-status-danger-fg);
  color: var(--ui-status-danger-fg);
}

.meta-tag.readonly {
  padding: 1px 7px;
  border: 1px dashed var(--settings-rule, var(--ui-border-default-border));
  border-radius: 999px;
  color: var(--settings-ink-4, var(--ui-text-faint-fg, var(--ui-text-muted-fg)));
}

.meta-tag.declares {
  padding: 1px 7px;
  border: 1px dashed var(--settings-rule, var(--ui-border-default-border));
  border-radius: 999px;
  background: transparent;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
}

.meta-tag.update-available {
  padding: 1px 7px;
  border: 1px solid color-mix(in srgb, var(--settings-accent, var(--ui-accent-primary-fg)) 70%, transparent);
  border-radius: 999px;
  background: transparent;
  color: var(--settings-accent, var(--ui-accent-primary-fg));
}

.install-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 460px;
}

.install-actions {
  display: flex;
  gap: 8px;
}

/* 拖投等价于选中:一条发线亮起来就够了,画线风不铺色块。 */
.install-form.is-drop-target {
  outline: 1px dashed var(--settings-accent, var(--ui-accent-primary-fg));
  outline-offset: 6px;
}

/* P3 市场区:与插件台账同一张画线皮,确认区只是卡内的一段发线。 */
.market-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}

.market-toolbar :first-child {
  flex: 1;
}

.market-stale {
  margin: 0 0 8px;
}

.market-confirm {
  margin-top: 8px;
  padding: 8px 0 4px;
  border-top: 1px solid var(--line, currentColor);
}

.market-confirm-title {
  margin: 0 0 4px;
  font-weight: 600;
}

.market-confirm-list {
  margin: 0 0 6px;
  padding-left: 18px;
}

.market-confirm-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

.install-btn {
  align-self: flex-start;
}

.install-hint {
  margin-top: 10px;
}

.meta-tag.builtin {
  padding: 1px 7px;
  border: 1px solid color-mix(in srgb, var(--settings-accent, var(--ui-accent-primary-fg)) 55%, transparent);
  border-radius: 999px;
  background: transparent;
  color: var(--settings-accent, var(--ui-accent-primary-fg));
}

.cmd-list {
  color: var(--settings-ink-4, var(--ui-text-faint-fg, var(--ui-text-muted-fg)));
}

/* ── Empty/Loading/Error ── */
.empty-state,
.loading-row {
  padding: 28px 16px;
  text-align: center;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  font-size: 13px;
}

.empty-state {
  border: 1px dashed var(--settings-rule, var(--ui-border-default-border));
}

.empty-state p {
  margin: 0;
}

.empty-state .hint {
  font-size: 12px;
  margin-top: 8px;
  line-height: 1.6;
}

.loading-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid color-mix(in srgb, var(--settings-ink-4, var(--ui-text-faint-fg, var(--ui-text-muted-fg))) 30%, transparent);
  border-top-color: var(--settings-accent, var(--ui-accent-primary-fg));
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.btn-sm {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 8px;
  padding: 3px 10px;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  border: 1px solid var(--settings-rule, var(--ui-border-default-border));
  border-radius: 0;
  background: transparent;
  color: var(--settings-ink-2, var(--ui-text-secondary-fg, var(--ui-text-primary-fg)));
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.btn-sm:hover {
  background: transparent;
  border-color: var(--settings-ink-3, var(--ui-text-muted-fg));
  color: var(--settings-ink, var(--ui-text-primary-fg));
}

.install-steps {
  margin: 0;
  padding-left: 18px;
  line-height: 1.8;
  color: var(--settings-ink-3, var(--ui-text-muted-fg));
  font-size: 12px;
}
</style>
