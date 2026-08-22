<template>
  <aside
    :class="['sidebar', { collapsed, floating, 'floating-closing': floatingClosing }]"
    :style="sidebarStyle"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <Space
      as="div"
      direction="vertical"
      size="none"
      align="stretch"
      class="sidebar-content"
      :class="{ 'content-hidden': contentHidden }"
      :aria-hidden="contentHidden"
    >
      <!-- Sidebar Header: traffic lights space + 操作按钮(展开态的宿主) -->
      <SidebarHeader>
        <SidebarActionGroup
          :sidebar-visible="!collapsed || floating"
          variant="sidebar"
          @toggle-sidebar="$emit('toggleCollapse')"
          @open-search="$emit('open-search')"
          @create-new-chat="$emit('create-new-chat')"
        />
      </SidebarHeader>

      <!-- 空间(space)切换器 —— 批 B1 的极简形态:一行色点 + 名字,点了就换。
           切换 = 换过滤条件,不做 teardown、不打断任何在跑的流(Arc 式)。
           后端答不上话(web 端本切片没有 /api/spaces)整行不画,只剩默认空间。
           右键 = 重命名 / 删除;「＋」= 新建并切过去。 -->
      <div
        v-if="spacesStore.showSwitcher"
        class="sidebar-space-row"
      >
        <button
          v-for="space in spacesStore.spaces"
          :key="space.id"
          type="button"
          class="sidebar-space-chip"
          :class="{ 'is-on': space.id === spacesStore.currentSpaceId }"
          :aria-pressed="space.id === spacesStore.currentSpaceId"
          @click="selectSpace(space.id)"
          @contextmenu.prevent="openSpaceMenu($event, space.id)"
        >
          <span
            class="sidebar-space-dot"
            :style="{ background: spaceColor(space) }"
            aria-hidden="true"
          />
          <input
            v-if="editingSpaceId === space.id"
            ref="spaceRenameInput"
            v-model="editingSpaceName"
            class="sidebar-space-input"
            type="text"
            @click.stop
            @keydown.enter.stop.prevent="commitSpaceRename"
            @keydown.esc.stop.prevent="cancelSpaceRename"
            @blur="commitSpaceRename"
          >
          <span
            v-else
            class="sidebar-space-name"
          >{{ space.name }}</span>
        </button>
        <button
          type="button"
          class="sidebar-space-add"
          aria-label="新建空间"
          @click="createSpace($event)"
        >
          <Plus
            :size="13"
            :stroke-width="1.9"
            aria-hidden="true"
          />
        </button>
      </div>

      <!-- 形态切换器(U3,样板 ChatGPT 左栏顶部的 `ChatGPT ▾`)。
           一个产品两种形态:对话 = 老模式直聊,协作 = 群聊 + 私聊。
           它只换左栏与「＋」建什么 —— 主区画什么永远由 `session.kind` 推
           (docs/design/product-two-forms-chatgpt-shell.md D1)。
           web 端没有协作形态(rooms 是 desktop-only),单项下拉是死控件,整行不画。 -->
      <div
        v-if="showFormSwitcher"
        class="sidebar-form-row"
      >
        <button
          ref="formSwitcherEl"
          type="button"
          class="sidebar-form-switcher"
          :class="{ 'is-open': formMenuOpen }"
          :aria-expanded="formMenuOpen"
          aria-haspopup="menu"
          @click="toggleFormMenu"
        >
          <b class="sidebar-form-name">{{ formModeLabel }}</b>
          <ChevronDown
            class="sidebar-form-caret"
            :size="14"
            :stroke-width="1.8"
          />
          <!-- 另一形态有未读时在这儿亮一枚点 —— 切过去才看得见的未读,总得有人说。 -->
          <span
            v-if="otherFormUnread"
            class="sidebar-form-badge"
            aria-hidden="true"
          />
        </button>
      </div>

      <!-- 方案三 · rail + 单类面板(样板 docs/design/im-redesign/sidebar-4.html
           第三格)。`.sidebar-split` 是 rail | 面板 的那一横排。

           rail 从 `SidebarHeader` **下面**开始:那一行 44px 是全宽拖拽行,左 70px
           是 macOS 交通灯保留位。rail 若从窗顶起,前两枚图标会被交通灯压住,而且
           整行 `-webkit-app-region: drag`,根本点不动。 -->
      <div
        v-if="formMode === 'collab'"
        class="sidebar-split"
      >
        <div
          class="sidebar-rail"
          role="tablist"
          aria-label="左栏类别"
        >
          <button
            v-for="category in railCategories"
            :key="category.id"
            :ref="(el) => setRailTabEl(category.id, el)"
            type="button"
            class="sidebar-rail-tab"
            :class="{ 'is-on': category.id === railCategory }"
            role="tab"
            :aria-selected="category.id === railCategory"
            :aria-label="category.label"
            @click="selectRailCategory(category.id)"
          >
            <svg
              class="sidebar-rail-glyph"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <!-- 图标随「按意图分格」一起换过一轮:气泡 = 回到某段对话(消息),
                   多人 = 去找谁(通讯录),文件夹 = 按项目翻旧账(会话)。 -->
              <template v-if="category.id === 'recent'">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </template>
              <template v-else-if="category.id === 'active'">
                <path d="M4 17l6-6-6-6M12 19h8" />
              </template>
              <template v-else-if="category.id === 'contacts'">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle
                  cx="9"
                  cy="7"
                  r="4"
                />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              </template>
              <template v-else>
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </template>
            </svg>
            <!-- 样板 `.bdg`:该类有未读或在跑。一枚点不摆数字 —— 系统只知道
                 "有没有",不知道"几条"。 -->
            <span
              v-if="railBadges[category.id]"
              class="sidebar-rail-badge"
              aria-hidden="true"
            />
          </button>

          <span
            class="sidebar-rail-spacer"
            aria-hidden="true"
          />

          <!-- 「⋯」= 五个工作区面板(Memory/Media/Agents/Tasks/Music)的家。
               平铺那一排 dock 在 workbench 下撤掉了,入口一个不少。 -->
          <button
            ref="railMoreEl"
            type="button"
            class="sidebar-rail-tab"
            :class="{ 'is-on': activeWorkspacePanel !== null }"
            aria-label="工作区面板"
            :aria-expanded="workspaceMenu !== null"
            @click="openWorkspaceMenu"
          >
            <MoreVertical
              :size="16"
              :stroke-width="1.6"
            />
          </button>
          <button
            ref="railNewChatEl"
            type="button"
            class="sidebar-rail-tab"
            aria-label="新会话"
            @click="$emit('create-new-chat')"
          >
            <Plus
              :size="16"
              :stroke-width="1.6"
            />
          </button>
          <button
            ref="railSettingsEl"
            type="button"
            class="sidebar-rail-tab"
            aria-label="Settings"
            @click="$emit('open-settings')"
          >
            <Settings
              :size="15"
              :stroke-width="1.6"
            />
          </button>
        </div>

        <!-- rail 是**纯图标**:名字只能靠浮层说出口。浮层不能包在按钮外面 ——
             `role="tab"` 与 `role="tablist"` 之间夹一层 div 会切断从属关系,
             30px 方钮外面多一个盒子也会把这一竖条撑歪。`trigger-el` 让 Tooltip
             自己 `display:none`,只托管浮层,rail 的 DOM 一个节点都不动。 -->
        <Tooltip
          v-for="category in railCategories"
          :key="`rail-tip-${category.id}`"
          :trigger-el="railTabEls[category.id] ?? null"
          :text="category.label"
          position="right"
        />
        <Tooltip
          :trigger-el="railMoreEl"
          text="工作区面板"
          position="right"
        />
        <Tooltip
          :trigger-el="railNewChatEl"
          text="新会话"
          position="right"
        />
        <Tooltip
          :trigger-el="railSettingsEl"
          text="Settings"
          position="right"
        />

        <div class="sidebar-pane">
          <!-- 样板 `.ph`:40px 面板头 = 类别名 + 右对齐计数。分区头即折叠钮那一套
               随分区折叠一起退役了 —— 类别切换替代了它。 -->
          <div class="sidebar-pane-head">
            <b class="sidebar-pane-title">{{ railCategoryLabel }}</b>
            <span class="sidebar-pane-count">{{ railCategoryCount }}</span>
            <!-- 新建群聊:样板没画这枚(它只画了「进行中」那一格),但撤掉就等于
                 把建群这件事弄没,所以它跟着「通讯录」这一类走 —— 建群是**发起**
                 一段对话,和"找谁"在同一面上。 -->
            <Tooltip
              v-if="railCategory === 'contacts' && roomsEnabled"
              text="新建群聊"
            >
              <button
                type="button"
                class="sidebar-rooms-add"
                aria-label="新建群聊"
                @click="showRoomDialog = true"
              >
                ＋
              </button>
            </Tooltip>
          </div>

          <!-- 唯一的滚动体。classic 下这一层是 `display: contents`(不生成盒子,
               排版与从前逐像素一致);workbench 下它是面板的滚动区,一次只装一类。 -->
          <div class="sidebar-sections">
            <!-- 「消息」— 一条时间序的对话流(2026-08-01)。
             **只装两种**:群聊,和与某位同事的私聊。两者**混排**,谁刚说过话谁在
             上面 —— IM 的主列表不按对象类型分列,按类型分列是「通讯录」的活。
             直聊会话不进来(它是工作会话不是对话,家在「会话」那一类),
             agent ⇄ agent 的「私下」房也不进来(那是旁听面,留在通讯录里折叠)。
             合并与排序全在 `sidebar-recent.ts` 的纯函数里,这里只负责贴上名册
             (名字 / 头像)与既有的未读判定 —— 一份账都不新起。
             **workbench 专属**:classic 下四区照旧一起平铺,再插一条把同一批
             会话又画一遍的流,就等于把每一行都摆两次(纪律 1:逐像素回滚闸)。 -->
            <div
              v-if="recentVisible"
              class="sidebar-rooms sidebar-recent"
            >
              <button
                v-for="entry in recentEntries"
                :key="entry.id"
                type="button"
                class="sidebar-room-item sidebar-agent-item sidebar-recent-item"
                :class="{
                  'is-active': sessionsStore.currentSessionId === entry.id,
                  'has-unread': sessionsStore.isUnreadSession(entry.id),
                }"
                @click="openRoom(entry.id)"
                @contextmenu.prevent="openRecentContextMenu($event, entry)"
              >
                <!-- 一枚章,三种行都有 —— 列表左缘对齐是消息流可读的前提。
                 私聊/直聊是圆章头像(和联系人行同一句法),群是方章 + 群名首字。 -->
                <span
                  v-if="entry.kind === 'group'"
                  class="sidebar-agent-avatar sidebar-recent-room-mark"
                  aria-hidden="true"
                >{{ roomInitial(entry.name) }}</span>
                <AgentAvatar
                  v-else
                  class="sidebar-agent-avatar"
                  aria-hidden="true"
                  :avatar="recentFace(entry).avatar"
                  :avatar-image="recentFace(entry).avatarImage"
                  :size="18"
                />
                <span class="sidebar-room-name">{{ recentName(entry) }}</span>
                <span class="sidebar-recent-time">{{ formatRelativeTime(entry.updatedAt) }}</span>
                <span
                  v-if="sessionsStore.isUnreadSession(entry.id)"
                  class="sidebar-unread-dot"
                  aria-label="有新消息"
                />
              </button>

              <div
                v-if="!recentEntries.length"
                class="sidebar-recent-empty"
              >
                还没有对话。去「通讯录」找个人说话,或建一个群。
              </div>
            </div>

            <!-- 「进行中」— docs/design/im-workbench-layout.md §3 W1(C1)。
             左栏的第一类是**活**不是对话:状态点 + 名字 + 一句副文,按
             执行中/待你/已交付分组(样板 `.grp`)。
             取数(`useActiveWork`)提到了 script 里:rail 上这一类的徽标与计数
             在别的类别被选中时也得算,所以它不能跟着这一区的 v-if 一起挂卸。
             门仍在,只是搬到了 `activeWorkEnabled` 上:`roomsEnabled` —— 看板是
             房的附属,web 端没有 rooms 协调器,那里一次看板 IPC 都不发。
             「没有在跑的活就整区不显示」在方案三下的等价物是「这一类不上 rail」
             (`resolveRailCategories`),所以这里点进来必然有行。 -->
            <ActiveWorkSection
              v-if="activeWorkEnabled && railCategory === 'active'"
              :cards="activeWorkCards"
              :is-room-busy="activeWork.isRoomBusy"
              :is-room-unread="activeWork.isRoomUnread"
              @open="openActiveWorkCard"
            />

            <!-- 联系人(通讯录)分区 — docs/design/agent-im-dm.md §4.1 D1。
             一个 agent 一行,点开就是和 TA 的托管式私聊(单成员 dm 房,惰性建房)。
             数据源是名册而不是会话列表:没聊过的同事也该在通讯录里站着,否则
             「第一次找小李」这件事就没有入口。desktop-only —— 私聊是房,rooms
             在 web 端没有协调器(§7 开放问题),所以与群聊同一道能力门。
             行样式沿用群聊/Agent 组那一族,不另起一套画线风。 -->
            <div
              v-if="roomsEnabled && contacts.length > 0 && isCategoryVisible('contacts')"
              class="sidebar-rooms sidebar-contacts"
            >
              <!-- 「通讯录」一类里装着同事与群两段,面板头只说得出
               类别名 —— 段与段之间要有一行组头,否则两批行糊成一条。
               句法与「进行中」的组头、「私下」的折叠头同一族。 -->
              <div class="sidebar-pane-group">
                同事
              </div>
              <button
                v-for="contact in contacts"
                :key="contact.id"
                type="button"
                class="sidebar-room-item sidebar-agent-item sidebar-contact-item"
                :class="{ 'is-active': isContactActive(contact), 'has-unread': isContactUnread(contact) }"
                @click="openContact(contact)"
                @contextmenu.prevent="openContactMenu($event, contact)"
              >
                <AgentAvatar
                  class="sidebar-agent-avatar"
                  aria-hidden="true"
                  :avatar="contact.avatar"
                  :avatar-image="contact.avatarImage"
                  :size="18"
                />
                <span class="sidebar-room-name">{{ contact.name }}</span>
                <span
                  v-if="contact.title"
                  class="sidebar-contact-title"
                >{{ contact.title }}</span>
                <!-- 未读墨点(agent-im-dm.md P4)。一枚点,不摆数字:系统只知道"有没有
                 新话",不知道"几条" —— 编一个计数出来比不显示更糟。 -->
                <span
                  v-if="isContactUnread(contact)"
                  class="sidebar-unread-dot"
                  aria-label="有新消息"
                />
              </button>
              <!-- 失败一行墨(RoomMemberStrip 同款):建房被拒(退休/service/查无此人)
               或 web 端不支持,都必须看得见,绝不静默无反应。收起也照旧显示 ——
               一条报错藏进折叠里就等于没有报错。 -->
              <span
                v-if="contactError"
                class="sidebar-contacts-error"
              >{{ contactError }}</span>
            </div>

            <!-- 群聊(多 Agent 房间)分区 — docs/design/multi-agent-collab.md。
             吃的是 groupRoomSessions:私聊房不在这里出现,联系人行是它唯一的
             侧栏入口(agent-im-dm.md §4.1),否则一间房会在侧栏出现两次。 -->
            <div
              v-if="(roomSessions.length > 0 || roomsEnabled) && isCategoryVisible('contacts')"
              class="sidebar-rooms"
            >
              <!-- 建群归面板头,组头只剩一行段标(与上面「同事」那一行成对)。 -->
              <div class="sidebar-pane-group">
                群聊
              </div>
              <button
                v-for="room in roomSessions"
                :key="room.id"
                type="button"
                class="sidebar-room-item"
                :class="{
                  'is-active': sessionsStore.currentSessionId === room.id,
                  'has-unread': sessionsStore.isUnreadSession(room.id),
                  'has-faces': roomFaces(room.id).faces.length > 0,
                }"
                @click="openRoom(room.id)"
                @contextmenu.prevent="openRoomContextMenu($event, room)"
              >
                <span class="sidebar-room-name">{{ room.name }}</span>
                <!-- 成员头像堆(样板左栏 `.faces`):群聊行上"这是谁的群"一眼可见,
                 这是样板真正比现状强的地方。名册→成员的翻译复用房头成员条那
                 一处 `buildRoomMemberEntries`(退休/查无此人的墓碑口径一并
                 继承),这里只截前三枚。workbench-only —— classic 下
                 `roomFacesById` 直接返回空表,一枚都不画。 -->
                <span
                  v-if="roomFaces(room.id).faces.length > 0"
                  class="sidebar-room-faces"
                  aria-hidden="true"
                >
                  <AgentAvatar
                    v-for="face in roomFaces(room.id).faces"
                    :key="face.id"
                    class="sidebar-room-face"
                    :class="{ 'is-retired': face.isRetired }"
                    :avatar="face.avatar"
                    :avatar-image="face.avatarImage"
                    :size="16"
                  />
                  <span
                    v-if="roomFaces(room.id).overflow > 0"
                    class="sidebar-room-face-more"
                  >+{{ roomFaces(room.id).overflow }}</span>
                </span>
                <span
                  v-if="sessionsStore.isUnreadSession(room.id)"
                  class="sidebar-unread-dot"
                  aria-label="有新消息"
                />
              </button>

              <!-- 「私下」= 双成员 dm 房(agent 互聊,agent-im-dm.md §4.1/D4)。
               群聊这一类**里**的折叠子分组,不是与它并列的第五类:agent 之间的
               私聊是群聊的旁支,而透明制要求它在侧栏看得见 —— 看得见,但默认
               收起,不占视线。房名「A ⇄ B」由引擎现算,这里只显示。 -->
              <template v-if="pairDmRooms.length > 0">
                <button
                  type="button"
                  class="sidebar-subgroup"
                  :aria-expanded="pairDmOpen"
                  @click="pairDmOpen = !pairDmOpen"
                >
                  <span
                    class="sidebar-subgroup-caret"
                    :class="{ open: pairDmOpen }"
                    aria-hidden="true"
                  >
                    <svg
                      class="sidebar-section-caret-glyph"
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </span>
                  <span class="sidebar-subgroup-label">私下</span>
                  <span class="sidebar-subgroup-count">{{ pairDmRooms.length }}</span>
                  <!-- 收起时组头替组内那些看不见的行说话;展开了就各说各的,组头闭嘴。 -->
                  <span
                    v-if="!pairDmOpen && pairDmUnread"
                    class="sidebar-unread-dot"
                    aria-label="有新消息"
                  />
                </button>
                <template v-if="pairDmOpen">
                  <button
                    v-for="room in pairDmRooms"
                    :key="room.id"
                    type="button"
                    class="sidebar-room-item sidebar-subgroup-item"
                    :class="{
                      'is-active': sessionsStore.currentSessionId === room.id,
                      'has-unread': sessionsStore.isUnreadSession(room.id),
                    }"
                    @click="openRoom(room.id)"
                    @contextmenu.prevent="openRoomContextMenu($event, room)"
                  >
                    <span class="sidebar-room-name">{{ room.name }}</span>
                    <span
                      v-if="sessionsStore.isUnreadSession(room.id)"
                      class="sidebar-unread-dot"
                      aria-label="有新消息"
                    />
                  </button>
                </template>
              </template>
            </div>

            <!-- 「Agent 组」已退役(agent-im-dm.md §4.1)。它唯一的能力 —— 各群执行
             会话的只读转录入口 —— 迁进了 Agents 面板的履历页「群聊」栏:基础设施
             转录放在通讯录层级是错位的,而履历页本来就是"这个人干过什么"的家。 -->
          </div>
        </div>
      </div>

      <!-- 对话形态:会话表。没有 rail —— 这一形态只有一种列表(U3)。
           三颗入口(⋯ 工作区面板 / ＋ 新会话 / ⚙ 设置)在协作形态下住在 rail
           底部,这一形态下退成面板底下的一条 —— 入口一个不丢。 -->
      <div
        v-else
        class="sidebar-chat-pane"
      >
        <SessionList
          :groups="groupedSessions"
          :active-index="activeSidebarIndex"
          :current-session-id="sessionsStore.currentSessionId"
          :is-session-generating="chatStore.isSessionGenerating"
          :editing-session-id="editingSessionId"
          :editing-name="editingName"
          @menu-select="handleSidebarMenuSelect"
          @context-menu="openContextMenu"
          @toggle-collapse="sessionOrganizer.toggleCollapse"
          @start-rename="startInlineRename"
          @confirm-rename="confirmInlineRename"
          @cancel-rename="cancelInlineRename"
          @overflow-change="handleOverflowChange"
          @new-session-in-project="startProjectSession"
          @project-context-menu="openProjectContextMenu"
        />

        <div class="sidebar-chat-foot">
          <Tooltip
            text="工作区面板"
            position="top"
          >
            <button
              type="button"
              class="sidebar-chat-foot-btn"
              :class="{ 'is-on': activeWorkspacePanel !== null }"
              aria-label="工作区面板"
              @click="openWorkspaceMenu"
            >
              <MoreVertical
                :size="16"
                :stroke-width="1.6"
              />
            </button>
          </Tooltip>
          <Tooltip
            text="新会话"
            position="top"
          >
            <button
              type="button"
              class="sidebar-chat-foot-btn"
              aria-label="新会话"
              @click="$emit('create-new-chat')"
            >
              <Plus
                :size="16"
                :stroke-width="1.6"
              />
            </button>
          </Tooltip>
          <!-- 新建项目 = 挑一个目录进项目名册。挑目录要拉系统对话框,
               web 端的 showOpenDialog 是个恒返回 canceled 的桩 —— 画一颗
               点了什么都不会发生的钮比不画更糟,所以按能力位隐藏。 -->
          <Tooltip
            v-if="canPickProjectDir"
            text="新建项目"
            position="top"
          >
            <button
              type="button"
              class="sidebar-chat-foot-btn"
              aria-label="新建项目"
              :disabled="creatingProject"
              @click="createProject"
            >
              <FolderPlus
                :size="16"
                :stroke-width="1.6"
              />
            </button>
          </Tooltip>
          <span class="sidebar-chat-foot-spacer" />
          <Tooltip
            text="Settings"
            position="top"
          >
            <button
              type="button"
              class="sidebar-chat-foot-btn"
              aria-label="Settings"
              @click="$emit('open-settings')"
            >
              <Settings
                :size="15"
                :stroke-width="1.6"
              />
            </button>
          </Tooltip>
        </div>
      </div>

      <!-- 方案二/v7 那排平铺 dock 图标已随 classic 一起退役(用户真机要求 4):
           五个工作区面板收进 rail 底部的「⋯」菜单,一个入口都不丢。

           R4 那条「脚栏」(`.sidebar-foot`)在方案三里退役:它的两枚图标(⋯ / 设置)
           搬进了 rail 底部那一栏 —— 样板第三格把入口全收在 46px 那一竖条上,
           面板底下不再另起一条发丝线。 -->

      <!-- 「⋯」= 工作区面板菜单。复用既有 ContextMenu(Teleport 到 body,不会被
           左栏的 overflow 裁掉),锚点取按钮的 rect 而不是鼠标位置 —— 它是个
           下拉,不是右键菜单。 -->
      <!-- 形态下拉。复用既有 ContextMenu(Teleport 到 body,不会被左栏的
           overflow 裁掉),锚点取按钮的 rect —— 它是个下拉,不是右键菜单。 -->
      <ContextMenu
        class="sidebar-form-menu"
        :show="formMenuOpen"
        :x="formMenuAnchor.x"
        :y="formMenuAnchor.y"
        :items="formMenuItems"
        @select="(id) => selectFormMode(id as SidebarFormMode)"
        @close="formMenuOpen = false"
      />

      <ContextMenu
        class="sidebar-workspace-menu"
        :show="workspaceMenu !== null"
        :x="workspaceMenu?.x ?? 0"
        :y="workspaceMenu?.y ?? 0"
        :items="workspaceMenuItems"
        @select="onWorkspaceMenuSelect"
        @close="workspaceMenu = null"
      />

      <RoomCreateDialog
        :visible="showRoomDialog"
        @close="showRoomDialog = false"
      />

      <!-- 会话右键菜单。P1 合流:原 SessionContextMenu.vue(平行实现,自己 teleport、自己画遮罩、不回弹视口)整份删掉,改清单驱动。 -->
      <ContextMenu
        :show="contextMenu.show"
        :x="contextMenu.x"
        :y="contextMenu.y"
        :items="sessionMenuItems"
        :min-width="160"
        @select="onSessionMenuSelect"
        @close="closeContextMenu"
      />

      <!-- 项目组头右键:把这个项目移出名册(会话不动)。 -->
      <ContextMenu
        :show="projectMenu !== null"
        :x="projectMenu?.x ?? 0"
        :y="projectMenu?.y ?? 0"
        :items="projectMenuItems"
        :min-width="160"
        @select="onProjectMenuSelect"
        @close="projectMenu = null"
      />

      <!-- 多根项目的「＋」:先问落在哪个根 —— cwd 是单值,替用户猜就是猜错。 -->
      <ContextMenu
        :show="projectRootPicker !== null"
        :x="projectRootPicker?.x ?? 0"
        :y="projectRootPicker?.y ?? 0"
        :items="projectRootPickerItems"
        :min-width="180"
        @select="onProjectRootPickerSelect"
        @close="projectRootPicker = null"
      />

      <!-- 空间切换器的右键菜单:重命名 / 删除(只删得掉空的、非默认的)。 -->
      <ContextMenu
        :show="spaceMenu !== null"
        :x="spaceMenu?.x ?? 0"
        :y="spaceMenu?.y ?? 0"
        :items="spaceMenuItems"
        :min-width="160"
        @select="onSpaceMenuSelect"
        @close="spaceMenu = null"
      />

      <!-- 新建空间向导(批 B3):二选一 —— 空白开始 / 从默认空间导入凭证快照。
           凭证 per-space 严格隔离不回落,所以「新空间要不要带钥匙」必须在这里问,
           不能替用户猜。 -->
      <ContextMenu
        :show="spaceCreateMenu !== null"
        :x="spaceCreateMenu?.x ?? 0"
        :y="spaceCreateMenu?.y ?? 0"
        :items="spaceCreateMenuItems"
        :min-width="200"
        @select="onSpaceCreateMenuSelect"
        @close="spaceCreateMenu = null"
      />

      <!-- 联系人右键:「打开空间」(= 点头像同一处)与「配置 Agent」。两条都走
           `openAgentSpace`,差别只是停在哪一面。 -->
      <ContextMenu
        :show="contactMenu !== null"
        :x="contactMenu?.x ?? 0"
        :y="contactMenu?.y ?? 0"
        :items="CONTACT_MENU_ITEMS"
        @select="onContactMenuSelect"
        @close="contactMenu = null"
      />
    </Space>
  </aside>
</template>

<script setup lang="ts">
import Space from '@/components/common/Space.vue'
import { computed, nextTick, ref, watch, onMounted, onUnmounted } from 'vue'
import { useSessionsStore } from '@/stores/sessions'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import ContextMenu from '@/components/common/ContextMenu.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import type { ContextMenuItem } from '@/components/common/context-menu'
import { normalizeProjectDir } from '@/utils/project-dir'
import { DEFAULT_AGENT_ID, useAgentsStore } from '@/stores/agents'
import { useChatStore } from '@/stores/chat'
import { Check, ChevronDown, Copy, FolderCheck, FolderMinus, FolderPlus, MoreVertical, Pencil, Pin, Plus, Settings, Trash2, X } from 'lucide-vue-next'
import {
  useWorkspaceNavEntries,
  type WorkspaceNavId,
} from '@/workspace/panel-registry'
import { buildRoomMemberEntries, type RoomMemberEntry } from '@/components/chat/room-member-strip'
import SidebarHeader from './SidebarHeader.vue'
import SidebarActionGroup from './SidebarActionGroup.vue'
import SessionList from './SessionList.vue'
import { SIDEBAR_FORM_MODES, formModeForSessionKind, type SidebarFormMode } from '@/stores/form-mode'
import RoomCreateDialog from './RoomCreateDialog.vue'
import ActiveWorkSection from './ActiveWorkSection.vue'
import { hasActiveWorkSignal, type ActiveWorkCardModel } from './active-work'
import { useActiveWork } from './useActiveWork'
import {
  SIDEBAR_RAIL_CATEGORIES,
  SIDEBAR_RAIL_STORAGE_KEY,
  resolveRailBadges,
  resolveRailCategories,
  resolveRailCategory,
  takeRoomFaces,
  type SidebarRailCategoryId,
} from './sidebar-sections'
import {
  buildRecentEntries,
  roomInitial,
  type SidebarRecentEntry,
} from './sidebar-recent'
import { platformApi } from '@/platform'
import { collabApi } from '@/platform/collab-client'
import { dialogApi } from '@/platform/dialog-client'
import { useWorkspaceStore } from '@/stores/workspace'
import { useProjectsStore } from '@/stores/projects'
import {
  DEFAULT_SPACE_ID as SPACES_DEFAULT_ID,
  sessionBelongsToSpace,
  useSpacesStore,
} from '@/stores/spaces'
import {
  formatRelativeTime,
  useSessionOrganizer,
  type SessionGroup,
  type SessionWithBranches,
} from './useSessionOrganizer'

interface Props {
  collapsed?: boolean
  floating?: boolean
  floatingClosing?: boolean
  noTransition?: boolean
  mediaPanelOpen?: boolean
  // 这个 props 联合与同文件的本地联合曾经是**两份手抄清单**;soul-memory 退役
  // 期间的工作树里它们一度不同步(一边删了 'memory',另一边还留着)。
  // 现在两处都从注册表派生 —— 不同步这件事在类型上不再可能。
  activeWorkspacePanel?: WorkspaceNavId | null
  width?: number
}

type WorkspacePanel = WorkspaceNavId

const props = withDefaults(defineProps<Props>(), {
  collapsed: false,
  floating: false,
  floatingClosing: false,
  noTransition: false,
  activeWorkspacePanel: null,
  width: 300,
})

const emit = defineEmits<{
  toggleCollapse: []
  'toggle-media-panel': []
  'open-workspace-panel': [panel: WorkspacePanel]
  'select-session': [sessionId: string]
  'create-new-chat': []
  'open-search': []
  'open-settings': []
  'request-floating-keep-open': []
  'request-floating-close': []
}>()

// Stores
const sessionsStore = useSessionsStore()
const chatStore = useChatStore()
const workspaceStore = useWorkspaceStore()

// 群聊(多 Agent 房间) — desktop only in P0: the web host has no
// RoomCoordinator and its server silently ignores kind='room' creates.
const showRoomDialog = ref(false)
const roomsEnabled = computed(() => platformApi.capabilities.collabRooms)
// 群聊区 = 普通群。私聊房(单成员 dm)由 store 的 selector 摘走 —— 这里不写
// 第二份过滤,判定只有 sessions store 那一处(agent-im-dm.md §4.1)。
const roomSessions = computed(() => sessionsStore.groupRoomSessions)
// 「私下」子分组(§4.1):双成员 dm 房。同样只读 store 的 selector,不在这里
// 写第二份形态判定。默认收起 —— 它是旁支,不是主线。
const pairDmRooms = computed(() => sessionsStore.agentPairDmRoomSessions)
const pairDmOpen = ref(false)
// 收起的「私下」组头替组内的行说话。判定仍然是 store 那一个 `isUnreadSession`,
// 这里只做"有没有任意一间"的聚合(agent-im-dm.md P4)。
const pairDmUnread = computed(() =>
  pairDmRooms.value.some(room => sessionsStore.isUnreadSession(room.id)),
)

function openRoom(sessionId: string): void {
  workspaceStore.openSession(sessionId)
}

// ── 「进行中」的取数(方案三:提到了这一层)──────────────────────────────
//
// rail 上「进行中」那一类的**徽标、计数、以及这一类在不在 rail 上**,在别的类别
// 被选中时也得算 —— 所以取数不能再跟着那一区的 v-if 一起挂载/卸载。composable
// 不能条件调用,于是把门做成参数(`enabled`):关着的时候订阅不发、补齐不跑、
// 卡片恒空。web 端没有协调器(roomsEnabled=false),那里一次看板 IPC 都不发。
const activeWorkEnabled = computed(() => roomsEnabled.value)
const activeWork = useActiveWork({ enabled: activeWorkEnabled })
const activeWorkCards = computed(() => activeWork.cards.value)

// ── 产品形态(U3 / U3b)──────────────────────────────────────────────────────
//
// 形态的**归属在 workspace store**,不在这里 —— 它决定主区显示哪条会话、哪棵
// 分栏树是活的,早就不是侧栏的本机视图偏好了(D7 修正了 D6 的这一句)。
// 这里只负责画那枚下拉。
const formMode = computed(() => workspaceStore.formMode)
const formModes = computed(() => {
  const ids = workspaceStore.availableFormModes
  return SIDEBAR_FORM_MODES.filter(mode => ids.includes(mode.id))
})

/** 单项下拉是个点不出东西的死控件 —— web 端干脆不画切换器。 */
const showFormSwitcher = computed(() => formModes.value.length > 1)
const formModeLabel = computed(
  () => formModes.value.find(mode => mode.id === formMode.value)?.label ?? '',
)
const formMenuOpen = ref(false)
const formSwitcherEl = ref<HTMLElement | null>(null)
const formMenuAnchor = ref({ x: 0, y: 0 })

/** 当前形态用一枚 ✓ 标出来 —— `ContextMenuItem` 没有 checked 位,图标就是它。 */
const formMenuItems = computed<ContextMenuItem[]>(() => formModes.value.map(mode => ({
  id: mode.id,
  label: mode.label,
  icon: mode.id === formMode.value ? Check : undefined,
})))

function toggleFormMenu(): void {
  if (formMenuOpen.value) {
    formMenuOpen.value = false
    return
  }
  const rect = formSwitcherEl.value?.getBoundingClientRect()
  if (rect) formMenuAnchor.value = { x: rect.left, y: rect.bottom + 6 }
  formMenuOpen.value = true
}

function selectFormMode(id: SidebarFormMode): void {
  formMenuOpen.value = false
  workspaceStore.setFormMode(id)
}

/** 另一形态里有没有未读 —— 切过去才看得见的东西,得在切换器上说一声。 */
const otherFormUnread = computed(() => (formMode.value === 'chat'
  ? unreadConversations.value
  : unreadChatSessions.value))

// ── rail 类别(协作形态内部的三格)──────────────────────────────────────────
// 判定与存档格式全在 `sidebar-sections.ts`(纯函数),这里只负责读一次、写一次。
// localStorage 而不是 settings:「我停在哪一类」是本机视图偏好,不跨端同步 ——
// 与 R4 那套折叠态同一个机制,只是那一套已随分区折叠一起退役。
const storedRailCategory = ref<string | null>(readStoredRailCategory())

function readStoredRailCategory(): string | null {
  try {
    return localStorage.getItem(SIDEBAR_RAIL_STORAGE_KEY)
  } catch {
    // 隐私模式/沙箱里 localStorage 会抛 —— 读不到就退到第一个可用类别。
    return null
  }
}

/** rail 上真正画出来的类别(web 降级在这一处判)。 */
const railCategories = computed(() => {
  const ids = resolveRailCategories({ roomsEnabled: roomsEnabled.value })
  return SIDEBAR_RAIL_CATEGORIES.filter(category => ids.includes(category.id))
})

const railCategory = computed<SidebarRailCategoryId>(() => resolveRailCategory(
  storedRailCategory.value,
  railCategories.value.map(category => category.id),
))

const railCategoryLabel = computed(
  () => railCategories.value.find(category => category.id === railCategory.value)?.label ?? '',
)

/**
 * rail 每一枚图标的宿主元素。浮层用 `trigger-el` 认它们 —— 包一层 wrapper 会
 * 切断 `tablist ↔ tab` 的从属,也会把 46px 那一竖条撑歪(见模板里的注释)。
 */
const railTabEls = ref<Record<string, HTMLElement | null>>({})
const railMoreEl = ref<HTMLElement | null>(null)
const railNewChatEl = ref<HTMLElement | null>(null)
const railSettingsEl = ref<HTMLElement | null>(null)

function setRailTabEl(id: string, el: unknown): void {
  railTabEls.value[id] = (el as HTMLElement | null) ?? null
}

/** 面板头右上那个数 = 这一类此刻装着几行。 */
const railCategoryCount = computed(() => {
  switch (railCategory.value) {
    case 'recent': return recentEntries.value.length
    case 'active': return activeWorkCards.value.length
    // 通讯录一类装着同事与群两段,计数是两段之和 —— 面板头那个数说的是
    // "这一类此刻装着几行",不是"其中一段有几行"。
    case 'contacts': return contacts.value.length + roomSessions.value.length
    default: return 0
  }
})

/**
 * 徽标:未读落在**能回话的那一类**,在跑落在「进行中」。
 *
 * 「消息」装房(群 + 私聊 + 折叠着的「私下」)。**通讯录不亮**:它的每一行要么
 * 已经在消息流里,要么根本没聊过,替消息流再报一次就是重复催人。
 * 直聊的未读归对话形态,落在形态切换器上(U3)。
 * 判定本身仍只有 `isUnreadSession` 那一处。
 */
const unreadConversations = computed(() =>
  roomSessions.value.some(room => sessionsStore.isUnreadSession(room.id))
  || pairDmUnread.value
  || contacts.value.some(contact => isContactUnread(contact)),
)

const unreadChatSessions = computed(() =>
  filteredSessions.value.some(session => sessionsStore.isUnreadSession(session.id)),
)

const railBadges = computed(() => resolveRailBadges({
  available: railCategories.value.map(category => category.id),
  unreadConversations: unreadConversations.value,
  activeWork: hasActiveWorkSignal(activeWorkCards.value),
}))

function selectRailCategory(id: SidebarRailCategoryId): void {
  storedRailCategory.value = id
  try {
    localStorage.setItem(SIDEBAR_RAIL_STORAGE_KEY, id)
  } catch {
    // 存不下就只在本次会话里生效,不该因此把切类这个动作也废掉。
  }
}

/**
 * 这一区现在该不该出现 —— rail 上只有被选中的那一类画得出来。
 */
function isCategoryVisible(id: SidebarRailCategoryId): boolean {
  return railCategory.value === id
}

// ── 「消息」类:一条时间序的对话流 ──────────────────────────────────────────

const recentVisible = computed(() => railCategory.value === 'recent')

/**
 * 合并与排序全在 `sidebar-recent.ts`。两路来源一律读 store 的 selector,这里不写
 * 第二份形态过滤(哪些房算私聊 / 群只有 store 那一处答案)。
 *
 * **只装对话**:群聊 + 和某位同事的私聊。直聊会话(`kind='chat'`)不进来 ——
 * 那是一条工作会话,不是"和谁的一段对话",它的家在「会话」那一类;混进来这一格
 * 就退化成"全部东西的时间序",IM 的那一格也就没了意义。
 */
const recentEntries = computed(() => buildRecentEntries({
  dmRooms: sessionsStore.userDmRoomSessions,
  groupRooms: roomSessions.value,
}))

/**
 * 私聊行的名字取**名册**而不是房名:同事改了名,和 TA 的那间房不会跟着改,
 * 读房名就会在消息流里留一个旧称呼。群没有这个问题,用房名。
 */
function recentName(entry: SidebarRecentEntry): string {
  if (entry.kind === 'dm' && entry.agentId) {
    return agentsStore.displayAgent(entry.agentId).name || entry.name || '私聊'
  }
  return entry.name || '群聊'
}

/** 圆章画谁 —— 只有私聊行有人可画(`displayAgent` 查无此人给墓碑,不冒充 default)。 */
function recentFace(entry: SidebarRecentEntry): { avatar?: string; avatarImage?: string } {
  if (!entry.agentId) return {}
  const identity = agentsStore.displayAgent(entry.agentId)
  return { avatar: identity.avatar, avatarImage: identity.avatarImage }
}

/** 消息流的行全是会话 —— 右键复用同一张会话菜单(改名/置顶/删除)。 */
function openRecentContextMenu(event: MouseEvent, entry: SidebarRecentEntry): void {
  const session = sessionsStore.getSessionItem?.(entry.id)
  if (!session) return
  openContextMenu(event, session as unknown as SessionWithBranches)
}

/**
 * 折叠 = 整块淡出。两种壳同一套语义 —— App 那边折叠时根本不挂侧栏(见
 * `sidebarDockedVisible`),这条是组件自己的兜底。
 *
 * workbench 曾把折叠画成一条 46px 的 rail(方案三),2026-07-31 撤掉:交通灯
 * 比 rail 宽,左上角永远对不齐。理由写在 App.vue 那处注释里。
 */
const contentHidden = computed(
  () => props.collapsed && !props.floating,
)

/**
 * 群聊行的成员头像堆(样板左栏 `.faces`)。
 *
 * 名册 → 成员条目的翻译**只有一处**:`chat/room-member-strip.ts` 的
 * `buildRoomMemberEntries`,与房头成员条同一个 selector —— 退休/查无此人的墓碑
 * 口径、负责人标记全部继承,这里不写第二份。截断交给 `takeRoomFaces`。
 */
const roomFacesById = computed(() => {
  const byRoom: Record<string, ReturnType<typeof takeRoomFaces<RoomMemberEntry>>> = {}
  const agents = agentsStore.agents ?? []
  for (const room of roomSessions.value) {
    byRoom[room.id] = takeRoomFaces(buildRoomMemberEntries({
      memberAgentIds: room.room?.memberAgentIds ?? [],
      agents,
      pmAgentId: room.room?.pmAgentId,
    }))
  }
  return byRoom
})

function roomFaces(roomSessionId: string) {
  return roomFacesById.value[roomSessionId] ?? { faces: [], overflow: 0 }
}

/**
 * 点一张活卡片 = 打开这张卡所在的房(与群聊行同一条 `openSession` 链路)
 * + 右栏切到这张卡的线程(C3,§3 W1「卡片点击 = 打开该卡对应的房 + 右栏切到
 * 该卡的线程」)。
 *
 * 线程走 window 事件而不是 emit 上去:侧栏离右栏隔着 App 的整棵布局,中栏活动线
 * 的「展开 →」派的也是同一个事件同一个形状,两个入口共用一条线路才只有一份契约。
 * `workSessionId`(尾条工作台会话 = 当前那次执行)为空就只开房 —— 活刚领下来还
 * 没开过工作台,派一个空事件只会在右栏开出一个读不到东西的 tab。
 */
function openActiveWorkCard(card: ActiveWorkCardModel): void {
  if (!card.roomSessionId) return
  openRoom(card.roomSessionId)
  if (!card.workSessionId) return
  window.dispatchEvent(new CustomEvent('onething:open-thread', {
    detail: { workSessionId: card.workSessionId, title: card.title, taskId: card.taskId },
  }))
}

/** 群聊行右键 = 复用会话上下文菜单(改名/删除;删除会级联清掉工作会话)。 */
function openRoomContextMenu(event: MouseEvent, room: { id: string }): void {
  openContextMenu(event, room as unknown as SessionWithBranches)
}

const agentsStore = useAgentsStore()

// ── 联系人区(agent-im-dm.md §4.1)────────────────────────────────────────
// 通讯录取社交面名册(域模型 M2 的 `colleagues`:colleague && active),不是
// 会话列表 —— 没聊过的同事也得在这儿站着,不然"第一次找小李"没有入口。
// 名册得先加载:群聊区靠执行会话触发那条 watch,通讯录一间房都还没有的时候
// 也要有人,所以这里自己拉一次(store 自带去重,全 app 仍是一次拉取)。
watch(roomsEnabled, (enabled) => {
  if (enabled && !agentsStore.hasLoaded) void agentsStore.loadAgents().catch(() => {})
}, { immediate: true })

interface SidebarContact {
  id: string
  name: string
  title?: string
  avatar?: string
  avatarImage?: string
}

/** 主助理置顶(D1/M5:default 是第一位联系人),其余保持名册顺序。 */
const contacts = computed<SidebarContact[]>(() => {
  const roster = agentsStore.colleagues
  const head = roster.filter(agent => agent.id === DEFAULT_AGENT_ID)
  const rest = roster.filter(agent => agent.id !== DEFAULT_AGENT_ID)
  return [...head, ...rest].map(agent => ({
    id: agent.id,
    name: agent.name,
    title: agent.title,
    avatar: agent.avatar,
    avatarImage: agent.avatarImage,
  }))
})

const CONTACT_MENU_SPACE = 'agent-space'
const CONTACT_MENU_CONFIGURE = 'configure-agent'
const CONTACT_MENU_ITEMS: ContextMenuItem[] = [
  { id: CONTACT_MENU_SPACE, label: '打开空间' },
  { id: CONTACT_MENU_CONFIGURE, label: '配置 Agent' },
]
const CONTACT_ERROR_LINGER_MS = 4000

const contactMenu = ref<{ x: number; y: number; agentId: string } | null>(null)
const contactError = ref('')
const openingContactId = ref('')
let contactErrorTimer: ReturnType<typeof setTimeout> | null = null

function showContactError(message: string): void {
  contactError.value = message
  if (contactErrorTimer) clearTimeout(contactErrorTimer)
  contactErrorTimer = null
  if (!message) return
  contactErrorTimer = setTimeout(() => { contactError.value = '' }, CONTACT_ERROR_LINGER_MS)
}

/** 已经聊过就点亮 —— 房是惰性建的,没建过的联系人当然不该有高亮。 */
function isContactActive(contact: SidebarContact): boolean {
  const room = sessionsStore.findUserDmRoom(contact.id)
  return !!room && sessionsStore.currentSessionId === room.id
}

/**
 * 联系人行的未读 = TA 的私聊房未读。没建过房的联系人当然不会有未读 ——
 * 判定本身只有 store 那一处,这里只是把 agent 翻译成 房。
 */
function isContactUnread(contact: SidebarContact): boolean {
  const room = sessionsStore.findUserDmRoom(contact.id)
  return !!room && sessionsStore.isUnreadSession(room.id)
}

/**
 * 点联系人 = 打开和 TA 的私聊。建房幂等(同一个 agent 永远同一间房),所以
 * "打开"和"创建"是同一个调用;新建的房要先进列表 openSession 才认得,这跟
 * RoomCreateDialog 同一条动线。
 */
async function openContact(contact: SidebarContact): Promise<void> {
  if (openingContactId.value) return
  openingContactId.value = contact.id
  showContactError('')
  try {
    const response = await collabApi.dmRoomEnsure({ agentId: String(contact.id) })
    if (!response?.success || !response.roomSessionId) {
      showContactError(response?.error || '打不开私聊')
      return
    }
    // 这一处**留着**(架构收敛 C4 §3):第一次点某个联系人时私聊房是**新建**的,
    // 而 `session:collab-updated` 只改已知的行。下一行的 openSession 要求它已经
    // 在列表里 —— 与 RoomCreateDialog 同一条动线。
    await sessionsStore.loadSessions()
    workspaceStore.openSession(response.roomSessionId)
  } catch (cause) {
    showContactError(cause instanceof Error ? cause.message : String(cause))
  } finally {
    openingContactId.value = ''
  }
}

function openContactMenu(event: MouseEvent, contact: SidebarContact): void {
  showContactError('')
  contactMenu.value = { x: event.clientX, y: event.clientY, agentId: contact.id }
}

function onContactMenuSelect(id: string): void {
  const agentId = contactMenu.value?.agentId
  contactMenu.value = null
  if (!agentId) return
  if (id !== CONTACT_MENU_CONFIGURE && id !== CONTACT_MENU_SPACE) return
  /* 两条岔开(agent-space-workbench.md P1):
     「打开空间」= 右栏那一页(和点头像同一个落点);
     「配置 Agent」= Agents 管理页 —— 那是名册面的动作(新建/退休/恢复/通览)。 */
  if (id === CONTACT_MENU_SPACE) {
    agentsStore.openAgentSpace(agentId, 'sessions')
    return
  }
  agentsStore.openAgentManager(agentId, 'config')
}

onUnmounted(() => {
  if (contactErrorTimer) clearTimeout(contactErrorTimer)
})

// 直接吃注册表:这份清单漏一项就是少一个进得去的面板,而编译器不会提醒。
// ── 「⋯」工作区面板菜单(R4,用户真机走查要求 4)──────────────────────────
// 平铺的一排 dock 图标在 workbench 下撤掉了,但那是这些面板**唯一**的入口 ——
// 删掉就等于把功能弄没。清单直接吃注册表(不抄第二份:少一个就是少一个进不去的
// 面板),菜单项 = 面板,一一对应。
//
// 吃的是**全部 inPanelNav**,不再是 `inSidebarMenu` 过滤后的子集。用户实测反馈
// 推翻了那个区分:从用户视角 ⋯ 就是"工作区面板列表",里面缺 Practice /
// Archived Chats / 插件面板就是缺三项。`inSidebarMenu: false` 记录的其实是历史
// 包袱(practice 走 window 事件进入、archive 是后加的、插件面板是新的),
// 不是设计 —— 那个旗子已随之删除。
const workspaceActions = useWorkspaceNavEntries()
const workspaceMenu = ref<{ x: number; y: number } | null>(null)

const workspaceMenuItems = computed<ContextMenuItem[]>(() =>
  workspaceActions.value.map(action => ({
    id: action.id,
    label: action.label,
    icon: action.icon,
  })),
)

/** 锚点取按钮的 rect:它是个下拉,不是右键菜单,不该跟着鼠标落点跑。 */
function openWorkspaceMenu(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  workspaceMenu.value = rect
    ? { x: Math.round(rect.left), y: Math.round(rect.top) }
    : { x: event.clientX, y: event.clientY }
}

function onWorkspaceMenuSelect(id: string): void {
  workspaceMenu.value = null
  // 不再按 `openable` 过滤:nav-only 的内置面板(archive / practice)与插件面板
  // 现在也从这里进 —— "打开工作区面板 + 切到该 nav" 一步完成,由 App 承担。
  const action = workspaceActions.value.find(candidate => candidate.id === id)
  if (!action) return
  emit('open-workspace-panel', action.id)
}

// Composable
const sessionOrganizer = useSessionOrganizer()

// Make props available in template
const collapsed = computed(() => props.collapsed)
const floating = computed(() => props.floating)
const floatingClosing = computed(() => props.floatingClosing)

// Local state
const localSearchQuery = ref('')
const hasContentBelow = ref(false)

// Inline editing state
const editingSessionId = ref<string | null>(null)
const editingName = ref('')

// Context menu state
const contextMenu = ref({
  show: false,
  x: 0,
  y: 0,
  session: null as SessionWithBranches | null,
})

// ── 项目 ────────────────────────────────────────────────────────────────────
// 名册(project-dirs)与推导出来的项目在 useSessionOrganizer 里按目录并成一份;
// 这里只管三件事:挑目录登记、在某个项目里开会话、把某个项目移出名册。
const projectsStore = useProjectsStore()
const canPickProjectDir = platformApi.capabilities.desktopWindows
const creatingProject = ref(false)
const projectMenu = ref<{ x: number; y: number; path: string; label: string } | null>(null)

// 多根:菜单里列出副根(可摘除),主根是身份锚点不给摘;再挂一个根走系统目录对话框。
const projectMenuEntry = computed(() => {
  const target = projectMenu.value
  if (!target) return undefined
  const normalized = normalizeProjectDir(target.path)
  return projectsStore.entries.find(entry =>
    (entry.paths?.length ? entry.paths : [entry.path])
      .some(p => normalizeProjectDir(p) === normalized),
  )
})

function projectRootLabel(root: string): string {
  const trimmed = root.replace(/[/\\]+$/, '')
  return trimmed.split(/[/\\]/).pop() || trimmed
}

const projectMenuItems = computed<ContextMenuItem[]>(() => {
  const items: ContextMenuItem[] = []
  if (canPickProjectDir) {
    items.push({ id: 'add-root', label: '添加目录到项目…', icon: FolderPlus })
  }
  const entry = projectMenuEntry.value
  const extraRoots = (entry?.paths ?? []).slice(1)
  // 每个副根两条:提成主根(换 cwd 锚点)/ 摘掉。主根自己不列 —— 它既
  // 不能摘,也已经是主根。
  for (const root of extraRoots) {
    items.push({
      id: `set-primary:${root}`,
      label: `设 ${projectRootLabel(root)} 为主根`,
      icon: FolderCheck,
      group: '目录',
    })
    items.push({
      id: `remove-root:${root}`,
      label: `移除 ${projectRootLabel(root)}`,
      icon: FolderMinus,
      group: '目录',
    })
  }
  items.push({
    id: 'remove',
    label: '移出项目列表',
    icon: Trash2,
    danger: true,
    separatorBefore: items.length > 0,
  })
  return items
})

async function createProject(): Promise<void> {
  if (creatingProject.value) return
  creatingProject.value = true
  try {
    const result = await dialogApi.showOpen({
      properties: ['openDirectory'],
      title: '选择项目目录',
    })
    const picked = result?.filePaths?.[0]
    if (result?.canceled || !picked) return
    await projectsStore.add(picked)
  } finally {
    creatingProject.value = false
  }
}

/**
 * 组头「＋」:在这个项目里开一条新会话(草稿从出生就带着目录)。
 *
 * 多根项目要先问「落在哪个根」—— cwd 是单值(批 A 的 cwd 语义),这条会话
 * 的 bash 执行目录、相对路径全锚在它上面,替用户猜等于替他挑错目录。
 * 单根项目行为不变:直通,不弹菜单。
 */
function startProjectSession(projectPath: string, event: MouseEvent | KeyboardEvent): void {
  const roots = projectRootsFor(projectPath)
  if (roots.length > 1) {
    const anchor = menuAnchorFromEvent(event)
    projectRootPicker.value = { x: anchor.x, y: anchor.y, roots }
    return
  }
  sessionsStore.openNewChatDraft('New Chat', {
    workingDirectory: roots[0] ?? projectPath,
    workspaceId: spacesStore.currentSpaceId,
  })
}

/** 名册里这个项目的全部根(主根第一);没登记就只有它自己。 */
function projectRootsFor(projectPath: string): string[] {
  const normalized = normalizeProjectDir(projectPath)
  const entry = projectsStore.entries.find(candidate =>
    (candidate.paths?.length ? candidate.paths : [candidate.path])
      .some(p => normalizeProjectDir(p) === normalized),
  )
  if (!entry) return [projectPath]
  return entry.paths?.length ? [...entry.paths] : [entry.path]
}

/**
 * 浮层锚点。鼠标点击取指针位置;键盘触发(enter/space)没有指针,退回
 * 触发元素的 rect —— 否则菜单会钉在屏幕左上角。
 */
function menuAnchorFromEvent(event: MouseEvent | KeyboardEvent): { x: number; y: number } {
  if (event instanceof MouseEvent && (event.clientX !== 0 || event.clientY !== 0)) {
    return { x: event.clientX, y: event.clientY }
  }
  const target = event.currentTarget ?? event.target
  if (target instanceof HTMLElement) {
    const rect = target.getBoundingClientRect()
    return { x: rect.left, y: rect.bottom }
  }
  return { x: 0, y: 0 }
}

const projectRootPicker = ref<{ x: number; y: number; roots: string[] } | null>(null)

const projectRootPickerItems = computed<ContextMenuItem[]>(() =>
  (projectRootPicker.value?.roots ?? []).map((root, index) => ({
    id: `root:${root}`,
    label: index === 0 ? `${projectRootLabel(root)}(主根)` : projectRootLabel(root),
    icon: index === 0 ? FolderCheck : FolderPlus,
    group: '在哪个目录里新建',
  })),
)

function onProjectRootPickerSelect(id: string): void {
  if (!id.startsWith('root:')) return
  const root = id.slice('root:'.length)
  projectRootPicker.value = null
  sessionsStore.openNewChatDraft('New Chat', {
    workingDirectory: root,
    workspaceId: spacesStore.currentSpaceId,
  })
}

function openProjectContextMenu(event: MouseEvent, group: SessionGroup): void {
  // 只有登记过的项目能被「移出」—— 纯推导出来的组没有名册条目可删,
  // 给它一个点了不响的菜单只会让人以为坏了。
  if (!group.projectPath || !group.isRegistered) return
  projectMenu.value = { x: event.clientX, y: event.clientY, path: group.projectPath, label: group.label }
}

async function onProjectMenuSelect(id: string): Promise<void> {
  const target = projectMenu.value
  if (!target) return
  if (id === 'remove') {
    // 只取消登记,一条会话都不动:这个目录下还有会话的话,它会退回
    // 「推导出来的项目」那条路继续成组,只有空项目才真的消失。
    await projectsStore.remove(target.path)
    return
  }
  if (id === 'add-root') {
    const result = await dialogApi.showOpen({
      properties: ['openDirectory'],
      title: '添加目录到项目',
    })
    const picked = result?.filePaths?.[0]
    if (result?.canceled || !picked) return
    await projectsStore.addRoot(target.path, picked)
    return
  }
  if (id.startsWith('set-primary:')) {
    await projectsStore.setPrimaryRoot(target.path, id.slice('set-primary:'.length))
    return
  }
  if (id.startsWith('remove-root:')) {
    await projectsStore.removeRoot(target.path, id.slice('remove-root:'.length))
  }
}

// ── 空间(space)────────────────────────────────────────────────────────────
// 切换 = 换过滤条件(Arc 式:所有 space 同时活着,切走的流继续跑)。
// currentSpaceId 是 window 级状态,住在 store 的 localStorage,不进后端。
const spacesStore = useSpacesStore()
const spaceMenu = ref<{ x: number; y: number; id: string } | null>(null)

/** 没配色就按 id 派生一个稳定色相 —— 同一个空间每次开都是同一个点。 */
function spaceColor(space: { id: string; color?: string }): string {
  if (space.color) return space.color
  if (space.id === SPACES_DEFAULT_ID) return 'var(--ui-accent-primary-fg)'
  let hash = 0
  for (const ch of space.id) hash = (hash * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${hash} 58% 55%)`
}

function selectSpace(id: string): void {
  // 换空间的全部后果都挂在下面那条 watch 上(删空间弹回 default 这条路不经过
  // 这里),所以这里只负责"改当前空间"这一件事。
  spacesStore.switchTo(id)
}

/**
 * 换空间的全部后果都在这一条上:
 *  1. 名册 per-space(批 B4):不重载的话上一个空间的项目会留在左栏;
 *  2. 分栏树 per-space(批 B5):不换树的话打开的还是旧空间那几条会话;
 *  3. 校正激活会话:目标空间没有树时主叶要落位。
 *
 * 挂在 watch 上而不是 `selectSpace` 里:删空间会把当前空间弹回 default
 * (`spacesStore.remove` → `switchTo`),那条路不经过 `selectSpace`;⌘1..9
 * 同理(它在 App.vue 里只调 `switchTo`)。
 */
watch(() => spacesStore.currentSpaceId, (spaceId) => {
  void projectsStore.load()
  workspaceStore.setSpace(spaceId)
  reconcileActiveSessionWithSpace()
})

/**
 * 换空间后校正激活会话:目标空间那棵树已经坐着一条本空间的会话就不动;否则挑
 * 本空间最近的一条,一条都没有就退回空态(`sidebarSessions` 已按 updatedAt 排好)。
 *
 * 候选只在**当前形态**里挑:形态是全局的,不该因为换个空间就被一条房拽去协作
 * (`openSession` 会跟着会话认形态)。这一形态没有会话时落空态屏 —— 与切形态
 * 时"那个形态还没被用过"同一口径。
 */
function reconcileActiveSessionWithSpace(): void {
  const currentId = workspaceStore.activeSessionId
  const visible = spaceFilteredSessions.value
  if (currentId && visible.some(session => session.id === currentId)) return
  const next = visible.find(session =>
    formModeForSessionKind(session.kind ?? 'chat', workspaceStore.availableFormModes)
      === workspaceStore.formMode)
  if (next) workspaceStore.openSession(next.id)
  else sessionsStore.clearCurrentSession()
}

/**
 * 新建空间 = 一次二选一(批 B3)。
 *
 * 凭证 per-space 严格隔离且不回落,所以「空白开始」的新空间**一把钥匙都没有** ——
 * 直接建完了事会让用户在新空间里发第一条消息就撞上「未配置」。二选一把这件事
 * 摆在建之前问,而不是在错误信息里补课。
 */
const spaceCreateMenu = ref<{ x: number; y: number } | null>(null)

const spaceCreateMenuItems = computed<ContextMenuItem[]>(() => [
  { id: 'blank', label: '空白开始', icon: Plus },
  { id: 'import', label: '从默认空间导入凭证', icon: Copy },
])

function createSpace(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  spaceCreateMenu.value = rect
    ? { x: rect.left, y: rect.bottom + 4 }
    : { x: event.clientX, y: event.clientY }
}

async function onSpaceCreateMenuSelect(id: string): Promise<void> {
  spaceCreateMenu.value = null
  const created = await spacesStore.create(undefined, { importCredentials: id === 'import' })
  if (!created) return
  selectSpace(created.space.id)
}

function openSpaceMenu(event: MouseEvent, id: string): void {
  spaceMenu.value = { x: event.clientX, y: event.clientY, id }
}

const spaceMenuItems = computed<ContextMenuItem[]>(() => {
  const id = spaceMenu.value?.id
  const isDefault = !id || id === SPACES_DEFAULT_ID
  return [
    { id: 'rename', label: '重命名…', icon: Pencil, disabled: isDefault },
    {
      id: 'remove',
      label: '删除空间',
      icon: Trash2,
      danger: true,
      // 默认空间删不掉;非空的也删不掉(后端会拒,这里先把按钮灰掉,
      // 让"点了没反应"变成"看得见为什么点不动")。
      disabled: isDefault || spaceSessionCount(id) > 0,
      separatorBefore: true,
    },
  ]
})

function spaceSessionCount(spaceId: string | undefined): number {
  if (!spaceId) return 0
  return sessionsStore.sidebarSessions
    .filter(session => sessionBelongsToSpace(session, spaceId)).length
}

// 就地重命名(与会话行同一套做法:输入框顶掉标签,Enter 提交 / Esc 撤销)。
const editingSpaceId = ref<string | null>(null)
const editingSpaceName = ref('')
const spaceRenameInput = ref<HTMLInputElement | HTMLInputElement[] | null>(null)

function startSpaceRename(id: string): void {
  editingSpaceId.value = id
  editingSpaceName.value = spacesStore.spaces.find(space => space.id === id)?.name ?? ''
  void nextTick(() => {
    const el = spaceRenameInput.value
    const input = Array.isArray(el) ? el[0] : el
    input?.focus()
    input?.select()
  })
}

async function commitSpaceRename(): Promise<void> {
  const id = editingSpaceId.value
  if (!id) return
  const name = editingSpaceName.value
  editingSpaceId.value = null
  await spacesStore.rename(id, name)
}

function cancelSpaceRename(): void {
  editingSpaceId.value = null
}

async function onSpaceMenuSelect(id: string): Promise<void> {
  const target = spaceMenu.value
  if (!target) return
  if (id === 'rename') {
    startSpaceRename(target.id)
    return
  }
  if (id === 'remove') {
    await spacesStore.remove(target.id)
    reconcileActiveSessionWithSpace()
  }
}

// Computed sidebar style
const sidebarStyle = computed(() => {
  const baseStyle = {
    '--sidebar-docked-width': `${props.width}px`,
  }

  if (floating.value || floatingClosing.value) {
    return {
      ...baseStyle,
      transition: 'none'
    }
  }

  return {
    ...baseStyle,
    transition: props.noTransition ? 'none' : undefined
  }
})

/**
 * 空间过滤 —— 输入侧就切掉,置顶 / 草稿 / 项目分组的语义一律不动。
 * 缺 `workspaceId` 的旧会话算 default(读取端缺省,零迁移)。
 */
const spaceFilteredSessions = computed(() =>
  sessionsStore.sidebarSessions.filter(session =>
    sessionBelongsToSpace(session, spacesStore.currentSpaceId),
  ),
)

// Filtered and flat sessions
const filteredSessions = computed(() => {
  const sessions = spaceFilteredSessions.value
  if (!localSearchQuery.value.trim()) {
    return sessions
  }
  const query = localSearchQuery.value.toLowerCase()
  return sessions.filter(s =>
    (s.name || '').toLowerCase().includes(query)
  )
})

// 电台会话不再在侧栏顶部单独成组(2026-08-17 用户裁决:那段合成绕开了空间过滤,
// 切到任何空间它都在,是多余的)。电台会话归音乐面板管,侧栏只画按空间过滤后的会话。
const groupedSessions = computed(() =>
  sessionOrganizer.getProjectGroupedSessions(
    filteredSessions.value,
    projectsStore.entries,
  ),
)

const activeSidebarIndex = computed(() => {
  if (sessionsStore.currentSessionId) return sessionMenuIndex(sessionsStore.currentSessionId)
  return ''
})

function sessionMenuIndex(sessionId: string): string {
  return `session:${sessionId}`
}

function handleSidebarMenuSelect(index: string) {
  if (index.startsWith('session:')) {
    if (editingSessionId.value) return
    emit('select-session', index.slice('session:'.length))
  }
}

function handleMouseEnter() {
  if (!props.floating && !props.floatingClosing) return
  emit('request-floating-keep-open')
}

function handleMouseLeave() {
  if (!props.floating || props.floatingClosing) return
  emit('request-floating-close')
}

// Overflow change handler
function handleOverflowChange(_isOverflowing: boolean, hasBelow: boolean) {
  hasContentBelow.value = hasBelow
}

// Context menu handlers
function openContextMenu(event: MouseEvent, session: SessionWithBranches) {
  if (sessionsStore.isNewChatDraftId(session.id)) return
  contextMenu.value = {
    show: true,
    x: event.clientX,
    y: event.clientY,
    session,
  }
}

function closeContextMenu() {
  contextMenu.value.show = false
}

/** 与旧 SessionContextMenu 逐项等价:重命名 / 钉住(文案随状态翻转)/ 分隔线 / 关闭。 */
const sessionMenuItems = computed<ContextMenuItem[]>(() => [
  { id: 'rename', label: 'Rename', icon: Pencil },
  { id: 'pin', label: contextMenu.value.session?.isPinned ? 'Unpin' : 'Pin', icon: Pin },
  { id: 'delete', label: 'Close', icon: X, danger: true, separatorBefore: true },
])

async function onSessionMenuSelect(id: string): Promise<void> {
  const session = contextMenu.value.session
  if (!session) return
  if (id === 'rename') {
    startInlineRename(session)
    return
  }
  if (id === 'pin') {
    await sessionsStore.updateSessionPin(session.id, !session.isPinned)
    return
  }
  if (id === 'delete') {
    await sessionsStore.deleteSession(session.id)
  }
}

// Inline rename handlers
function startInlineRename(session: SessionWithBranches) {
  if (sessionsStore.isNewChatDraftId(session.id)) return
  editingSessionId.value = session.id
  editingName.value = session.name || ''
}

function cancelInlineRename() {
  editingSessionId.value = null
  editingName.value = ''
}

async function confirmInlineRename(sessionId: string, newName: string) {
  const session = sessionsStore.filteredSessions.find(s => s.id === sessionId)
  const originalName = session?.name || ''
  const trimmedName = newName.trim()

  // Clear editing state first
  editingSessionId.value = null
  editingName.value = ''

  // Only call rename if name actually changed
  if (trimmedName && trimmedName !== originalName) {
    await sessionsStore.renameSession(sessionId, trimmedName)
  }
}

// Window resize handler
function handleWindowResize() {
  if (window.innerWidth < 768) {
    if (!props.collapsed) {
      emit('toggleCollapse')
    }
  }
}

onMounted(() => {
  window.addEventListener('resize', handleWindowResize)
  void projectsStore.load()
  void spacesStore.load()
})

onUnmounted(() => {
  window.removeEventListener('resize', handleWindowResize)
})
</script>

<style scoped>
.sidebar {
  --sidebar-docked-width: 300px;
  --sidebar-floating-gutter: 6px;
  --sidebar-floating-safe-zone: 36px;
  --sidebar-bg: var(--ui-sidebar-surface-bg, var(--ui-surface-app-bg));
  /* 行层级从墨色按比例派生，保证任何主题下 分组头(全墨) > 行文(72% 墨) >
     active(14%) > hover(8%) 的对比关系都成立——直接引各主题的通用 state token 时
     对比度不可控（用户实测过分组头/行文一个色、hover 看不见）。
     P4 起这条派生链**住在主题层**（role-mapping.ts 的 REGION_OVERLAY_STEPS，
     由 css-mapper 按各主题的 sidebar 底色解析成实色），这里只留区域别名，
     整棵 sidebar（新会话/列表/SessionItem/ActiveWork）共用。 */
  --sidebar-row-ink: var(--ui-sidebar-row-ink);
  --sidebar-row-fg: var(--ui-sidebar-row-fg);
  --sidebar-row-hover-fill: var(--ui-sidebar-item-hover-bg);
  --sidebar-row-active-fill: var(--ui-sidebar-item-active-bg);
  /* 字号阶梯。与上面那条墨色派生链同规:整棵 sidebar 共用五档,各处引档位而不是
     各写各的数 —— 归口前这里散着 9 / 10 / 11 / 11.5 / 12 / 13 / 14px 七种字面量,
     同一层级的东西(「进行中」的活卡片 11.5px、「私下」段头 11px、面板段头
     11.5px)靠肉眼对齐,谁也说不清哪两处该一样大。
     档位映射到全局刻度(styles/variables.css),不自己发明数:
       title   14px  列表行的**主标题** —— 会话名、房间名、活卡片、形态名
       row     13px  组头 / 面板头 / 次级动作(比主标题轻一档的结构文字)
       meta    12px  补语 —— 时间、计数、职位
       caption 11px  段头、空态、错误、「显示更多」
       micro   10px  角标 —— 时间子标题、方章首字、成员堆计数
     左栏原先整体比刻度低一档(SessionItem 的注释写着「--type-size-500 是 14px,
     比设计稿大一号」故意压到 13px),结果是 14px 正文的聊天区旁边挂一条 13/12px
     的左栏。归口即把这一档补回来。 */
  --sidebar-type-title: var(--type-body-size);      /* 14px */
  --sidebar-type-row: var(--type-label-size);       /* 13px */
  --sidebar-type-meta: var(--type-meta-size);       /* 12px */
  --sidebar-type-caption: var(--type-caption-size); /* 11px */
  --sidebar-type-micro: var(--type-micro-size);     /* 10px */
  position: relative;
  flex: 1 1 auto;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  transition: opacity var(--duration-normal) var(--ease-default);
  overflow: hidden;
  background: var(--sidebar-bg);
  padding: 0;
  contain: layout style;
}

/* Floating sidebar mode */
.sidebar.floating {
  position: fixed;
  left: 0;
  top: 0;
  width: calc(
    var(--sidebar-docked-width)
    + var(--sidebar-floating-gutter)
    + var(--sidebar-floating-gutter)
    + var(--sidebar-floating-safe-zone)
  ) !important;
  max-width: calc(
    var(--sidebar-docked-width)
    + var(--sidebar-floating-gutter)
    + var(--sidebar-floating-gutter)
    + var(--sidebar-floating-safe-zone)
  ) !important;
  height: 100%;
  z-index: var(--z-sidebar);
  background: transparent;
  animation: slideInLeft 0.2s cubic-bezier(0.32, 0.72, 0, 1) forwards;
  overflow: visible;
  transition: none;
  pointer-events: auto;
}

/* Floating card clears the fixed window-controls strip (traffic lights +
   sidebar actions, top 12px + 24px) instead of sliding beneath it — list
   content must never show through that transparent strip. */
.sidebar.floating .sidebar-content {
  width: var(--sidebar-docked-width);
  min-width: var(--sidebar-docked-width);
  max-width: var(--sidebar-docked-width);
  height: calc(100% - 44px - var(--sidebar-floating-gutter));
  margin: 44px var(--sidebar-floating-gutter) var(--sidebar-floating-gutter);
  padding-bottom: 0;
  background: var(--sidebar-bg);
  border: 1px solid color-mix(in srgb, var(--ui-sidebar-border-border, var(--ui-border-subtle-border)) 72%, transparent);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-floating);
  will-change: transform, opacity;
  pointer-events: auto;
}

/* The in-card traffic-lights spacer is meaningless when the card already
   starts below the window controls. */
.sidebar.floating .sidebar-content :deep(.sidebar-header) {
  display: none;
}

.sidebar.floating.floating-closing {
  animation: slideOutLeft 0.2s cubic-bezier(0.4, 0, 1, 1) forwards;
}

@keyframes slideInLeft {
  from {
    transform: translateX(-100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@keyframes slideOutLeft {
  from {
    transform: translateX(0);
    opacity: 1;
  }
  to {
    transform: translateX(-100%);
    opacity: 0;
  }
}

/* Sidebar content panel */
.sidebar-content {
  flex: 1;
  align-self: flex-start;
  width: var(--sidebar-docked-width);
  min-width: var(--sidebar-docked-width);
  max-width: var(--sidebar-docked-width);
  min-height: 0;
  margin-top: 12px;
  background: transparent;
  overflow: hidden;
  contain: layout style paint;
  transition: opacity var(--duration-normal) var(--ease-default);
}

/* Content fades out faster than width shrinks */
.sidebar-content.content-hidden {
  opacity: 0;
  pointer-events: none;
}

/* 两层壳与滚动容器的真身写在文件末尾(rail | 面板 那一横排 + 唯一的滚动体)。
   U0b 之前它们在这里还有一份 `display: contents` 的 classic 基线,形态开关退役
   后那一份连同门一起删了 —— 现在只有一套规则。 */

/* ── 形态切换器(U3,样板 ChatGPT 左栏顶部的 `ChatGPT ▾`)──────────────────
   一行,不是一块:它换的是左栏装什么,不是一个需要视觉重量的功能入口。
   墨阶沿用 rail 那一族 token,不另起一套颜色。 */
/* ── 空间(space)切换器 ─────────────────────────────────────────────────
   一行 chip:色点 + 名字。切换是换过滤条件,不是换窗口,所以它长得像标签
   而不是像导航 —— 视觉重量刻意压在形态切换器之下。 */
.sidebar-space-row {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  padding: 4px 10px 2px;
}

.sidebar-space-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  border: 0;
  border-radius: 6px;
  background: transparent;
  padding: 3px 7px;
  font-family: inherit;
  font-size: var(--sidebar-type-meta);
  color: var(--ui-sidebar-rail-muted-fg);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default),
              color var(--duration-fast) var(--ease-default);
}

.sidebar-space-chip:hover {
  background: var(--ui-sidebar-rail-hover-bg);
}

.sidebar-space-chip.is-on {
  background: var(--ui-sidebar-rail-hover-bg);
  color: var(--ui-text-primary-fg);
}

.sidebar-space-chip:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-accent-primary-fg) 36%, transparent);
}

.sidebar-space-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.sidebar-space-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-space-input {
  width: 8em;
  min-width: 0;
  border: 0;
  background: transparent;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  color: var(--ui-text-primary-fg);
}

/* 就地重命名的输入框:裸 `:focus` 关焦点环是对的(键入时 `:focus-visible`
   不触发),元素选择器写全才不会被 focus-bare 规则误伤。 */
input.sidebar-space-input:focus {
  outline: none;
}

.sidebar-space-add {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ui-sidebar-rail-muted-fg);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default),
              color var(--duration-fast) var(--ease-default);
}

.sidebar-space-add:hover {
  background: var(--ui-sidebar-rail-hover-bg);
  color: var(--ui-text-primary-fg);
}

.sidebar-space-add:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-accent-primary-fg) 36%, transparent);
}

.sidebar-form-row {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 2px 10px 6px;
}

.sidebar-form-switcher {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  border: 0;
  background: transparent;
  padding: 4px 8px;
  border-radius: 6px;
  font-family: inherit;
  color: var(--ui-text-primary-fg);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default);
}

.sidebar-form-switcher:hover,
.sidebar-form-switcher.is-open {
  background: var(--ui-sidebar-rail-hover-bg);
}

.sidebar-form-switcher:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-accent-primary-fg) 36%, transparent);
}

.sidebar-form-name {
  font-size: var(--sidebar-type-title);
  font-weight: 600;
  letter-spacing: 0;
}

.sidebar-form-caret {
  flex: 0 0 auto;
  color: var(--ui-sidebar-rail-muted-fg);
}

/* 另一形态有未读:一枚点,不摆数字(与 rail 徽标同一句法)。 */
.sidebar-form-badge {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  margin-left: 2px;
  background: var(--ui-accent-primary-fg);
}

/* ── 对话形态的左栏 ────────────────────────────────────────────────────────
   没有 rail:这一形态只有一种列表。会话表自己滚,三颗入口退成底下一条。 */
.sidebar-chat-pane {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

.sidebar-chat-foot {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px 6px;
}

.sidebar-chat-foot-spacer {
  flex: 1 1 auto;
}

.sidebar-chat-foot-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ui-sidebar-rail-muted-fg);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default),
              color var(--duration-fast) var(--ease-default);
}

.sidebar-chat-foot-btn:hover {
  background: var(--ui-sidebar-rail-hover-bg);
  color: var(--ui-sidebar-rail-fg);
}

.sidebar-chat-foot-btn.is-on {
  background: var(--ui-sidebar-rail-active-bg);
  color: var(--ui-sidebar-rail-fg);
}

.sidebar-chat-foot-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-accent-primary-fg) 36%, transparent);
}

/* ── rail(样板 `.sb3 .rail`)────────────────────────────────────────────────
   46px 一竖条,只有 workbench 会渲染它(classic 下这个元素根本不存在)。
   墨阶(墨 / 4.5% hover / 7.5% 当前 / 2.5% 底 / 47% 次要字)由主题层派生成
   `--ui-sidebar-rail-*`,这里只引用 —— 样板的字面色是给纸色底子写死的,
   换算成同比例的墨阶之后任何主题下的层级关系都成立。 */
.sidebar-rail {
  flex: 0 0 46px;
  width: 46px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px 0 8px;
  background: var(--ui-sidebar-rail-bg);
}

/* 样板 `.sb3 .rail .t`:30px 方钮、6px 圆角、hover 极淡填充、当前项填充加深
   且转墨色。没有边框也没有阴影。 */
.sidebar-rail-tab {
  position: relative;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ui-sidebar-rail-muted-fg);
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.sidebar-rail-tab:hover {
  background: var(--ui-sidebar-rail-hover-bg);
  color: var(--sidebar-row-ink, var(--ui-text-primary-fg));
}

.sidebar-rail-tab.is-on {
  background: var(--ui-sidebar-rail-active-bg);
  color: var(--sidebar-row-ink, var(--ui-text-primary-fg));
}

.sidebar-rail-tab:focus-visible {
  outline: none;
  box-shadow: var(--ui-focus-ring-soft-shadow);
}

/* 样板 `.bdg`:右上角 5px 一枚墨点 —— 该类有未读或在跑。 */
.sidebar-rail-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--sidebar-row-ink, var(--ui-text-primary-fg));
}

.sidebar-rail-spacer {
  flex: 1 1 auto;
}

/* ── 面板头(样板 `.sb3 .ph`)────────────────────────────────────────────────
   40px:类别名(13px / 550)+ 右对齐计数。分区头即折叠钮那一套已随分区折叠
   一起退役 —— 类别切换替代了它。 */
.sidebar-pane-head {
  flex: 0 0 40px;
  height: 40px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
}

.sidebar-pane-title {
  font-size: var(--sidebar-type-row);
  font-weight: 550;
  line-height: 1.45;
  color: var(--sidebar-row-ink, var(--ui-text-primary-fg));
  user-select: none;
}

.sidebar-pane-count {
  margin-left: auto;
  font-size: var(--sidebar-type-meta);
  font-variant-numeric: tabular-nums;
  color: color-mix(in srgb, var(--sidebar-row-ink, var(--ui-text-primary-fg)) 47%, transparent);
  user-select: none;
}

/* 联系人 / 群聊两组——同一套画线风,共用一条规则而不是各画一份,免得两组
   日后长歪成两种样子。 */
.sidebar-contacts,
.sidebar-rooms {
  flex-shrink: 0;
  padding: 2px 12px 6px 24px;
  display: flex;
  flex-direction: column;
}

.sidebar-rooms-add {
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: var(--sidebar-type-row);
  line-height: 1;
  padding: 2px 6px;
  color: var(--ui-sidebar-item-muted-fg, var(--ui-text-muted-fg));
  cursor: pointer;
}

.sidebar-rooms-add:hover {
  color: var(--sidebar-row-ink, var(--ui-text-primary-fg));
}

.sidebar-room-item {
  border: none;
  background: transparent;
  text-align: left;
  font-family: inherit;
  /* 房间行 / 联系人行是这条列表的**主标题**,与对话形态的会话名同档 ——
     两种形态的行标题不该一大一小。 */
  font-size: var(--sidebar-type-title);
  line-height: 1.5;
  padding: 4px 8px 4px 0;
  color: var(--ui-sidebar-item-muted-fg, var(--ui-text-muted-fg));
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-room-item:hover,
.sidebar-room-item.is-active {
  color: var(--sidebar-row-ink, var(--ui-text-primary-fg));
}

/* 未读:一枚墨点靠右,行文顺手提到满墨(IM 的老规矩——未读那行更"实")。
   群聊/私下行原本不是 flex(省一层盒子,省略号画在按钮本体上),只有带点的那行
   才切成 flex 并把省略号交给名字 span —— 不改无点行的既有排版。 */
.sidebar-room-item.has-unread {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--sidebar-row-ink, var(--ui-text-primary-fg));
}

.sidebar-room-item.has-unread .sidebar-room-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 成员头像堆(样板 `.faces`):向左叠压 5px,首枚不压。行本身与未读那条同理 ——
   只有带堆的行才切成 flex,不带的一个字节不动。 */
.sidebar-room-item.has-faces {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sidebar-room-item.has-faces .sidebar-room-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-room-faces {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  margin-left: auto;
}

/* 画线圆章,与联系人行那枚同一句法,尺寸再收一档(16px)。叠压处描一圈底色,
   让相邻两枚之间留出一条呼吸缝 —— 样板用的是 1.5px 的 surface 描边。 */
.sidebar-room-face {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: -5px;
  border: 1px solid color-mix(in srgb, var(--sidebar-row-ink, var(--ui-text-primary-fg)) 26%, transparent);
  border-radius: 50%;
  box-shadow: 0 0 0 1.5px var(--sidebar-bg);
  background: var(--sidebar-bg);
  /* 圆章里 emoji 的字号,**故意不上字号阶梯**:它由圆的直径决定,跟着正文
     刻度走的话字号一变 emoji 就顶破圈。下面 .sidebar-agent-avatar 同理。 */
  font-size: 9px;
  line-height: 1;
}

.sidebar-room-face:first-child {
  margin-left: 0;
}

/* 已注销的成员照旧出现在堆里(墓碑口径与房头成员条一致),只是灰一档。 */
.sidebar-room-face.is-retired {
  opacity: 0.45;
}

.sidebar-room-face-more {
  margin-left: 3px;
  font-size: var(--sidebar-type-micro);
  font-variant-numeric: tabular-nums;
  color: var(--ui-sidebar-item-muted-fg, var(--ui-text-muted-fg));
}

/* 未读点在堆之后,靠 margin 归零(堆已经吃掉了 auto)。 */
.sidebar-room-item.has-faces .sidebar-unread-dot {
  margin-left: 0;
}

/* 5px 一点墨,不描边不发光;靠 margin-left:auto 贴住行尾,名字永远先保住。 */
.sidebar-unread-dot {
  flex: 0 0 5px;
  width: 5px;
  height: 5px;
  margin-left: auto;
  border-radius: 50%;
  background: var(--sidebar-row-ink, var(--ui-text-primary-fg));
  opacity: 0.6;
}

/* 「私下」折叠头:比群聊行更轻一档(11px、字距同分区标签),它是分区里的分区。
   一枚发丝 caret + 计数,没有填充也没有边框 —— 画线风里"可折叠"由 caret 说。 */
.sidebar-subgroup {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  font-family: inherit;
  font-size: var(--sidebar-type-caption);
  line-height: 1.5;
  letter-spacing: 0.08em;
  padding: 4px 8px 2px 0;
  color: var(--ui-sidebar-item-muted-fg, var(--ui-text-muted-fg));
  cursor: pointer;
}

.sidebar-subgroup:hover {
  color: var(--sidebar-row-ink, var(--ui-text-primary-fg));
}

.sidebar-subgroup-caret {
  display: inline-block;
  /* 没有 font-size:壳里是一枚 width/height=12 的 SVG,字号不参与渲染。
     归口时删掉了那条死属性,免得它冒充一个字号档位。 */
  line-height: 1;
  transition: transform var(--duration-fast) var(--ease-default);
}

.sidebar-subgroup-caret.open {
  transform: rotate(90deg);
}

.sidebar-subgroup-count {
  font-size: var(--sidebar-type-micro);
  opacity: 0.7;
}

/* 子项缩进对齐折叠头的文字,而不是 caret —— 缩进是从属关系的唯一标记。 */
.sidebar-subgroup-item {
  padding-left: 17px;
}

/* 联系人行 = 群聊行 + 一枚头像章。行本身沿用 .sidebar-room-item,这里只把
   文字挪开给章让位。(类名保留 agent- 前缀:章 + 名字这套排版本来就是身份行的
   通用形,「Agent 组」退役并不改变它属于谁。) */
.sidebar-agent-item {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
}

.sidebar-agent-item .sidebar-room-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 0 1 auto;
}

/* 联系人行是竖列里的一行:`.sidebar-agent-item` 的 flex:1 是为行内布局写的,
   在这里会让行去抢竖直方向的空间。 */
.sidebar-contact-item {
  flex: 0 0 auto;
}

/* 联系人行 = Agent 行的排版(头像章 + 名字)再挂一枚职位。职位是补语不是
   标签:淡一档、可被压缩,名字永远先保住。 */
.sidebar-contact-title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--sidebar-type-caption);
  color: var(--ui-sidebar-item-muted-fg, var(--ui-text-muted-fg));
  opacity: 0.75;
}

/* ── 「消息」类的行 ────────────────────────────────────────────────────────
   行本体沿用 `.sidebar-room-item` + `.sidebar-agent-item`(章 + 名字那套身份行
   排版),这里只补三样:群的方章、行尾时间、以及空态/尾行两行文字。
   这一区**只在 workbench 下渲染**(`recentVisible`),所以这些规则不必再挂
   形态门 —— 那道门已随形态开关一起退役(U0b)。 */
.sidebar-recent-item {
  /* `.sidebar-agent-item` 的 flex:1 是给行内排版写的,在竖列里会让行去抢高度。 */
  flex: 0 0 auto;
}

/* 群没有头像,给一枚同尺寸的方章 + 群名首字 —— 三种行的左缘因此永远对齐,
   而"这是群不是人"一眼可辨(圆=人,方=群,画线风里形状就是分类)。 */
.sidebar-recent-room-mark {
  border-radius: 5px;
  font-size: var(--sidebar-type-micro);
  font-weight: 500;
  color: color-mix(in srgb, var(--sidebar-row-ink, var(--ui-text-primary-fg)) 62%, transparent);
}

/* 时间是补语:12px 淡一档,靠在名字之后、未读点之前,永远不参与压缩
   (`flex: 0 0 auto`)—— 名字先被省略号截,时间是最后一个字都不能少的那一栏。 */
.sidebar-recent-time {
  flex: 0 0 auto;
  font-size: var(--sidebar-type-meta);
  font-variant-numeric: tabular-nums;
  color: color-mix(in srgb, var(--sidebar-row-ink, var(--ui-text-primary-fg)) 42%, transparent);
}

/* 未读那一行整体提墨,时间跟着走一档 —— 否则一行里一半实一半虚。 */
.sidebar-room-item.has-unread .sidebar-recent-time {
  color: color-mix(in srgb, var(--sidebar-row-ink, var(--ui-text-primary-fg)) 60%, transparent);
}

.sidebar-recent-empty {
  padding: 14px 14px 10px;
  font-size: var(--sidebar-type-caption);
  line-height: 1.7;
  color: var(--ui-sidebar-item-muted-fg, var(--ui-text-muted-fg));
}

/* 面板里的段头(「通讯录」下的同事 / 群聊)。与「进行中」的组头、「私下」的
   折叠头同一句法 —— 面板头只说得出类别名,段与段之间靠这一行分开。 */
.sidebar-pane-group {
  flex-shrink: 0;
  padding: 12px 14px 3px;
  font-size: var(--sidebar-type-caption);
  font-weight: 500;
  color: var(--ui-sidebar-item-muted-fg, var(--ui-text-muted-fg));
  user-select: none;
}

/* 建房被拒的一行墨(RoomMemberStrip 的 .member-error 同款语气)。 */
.sidebar-contacts-error {
  padding: 2px 8px 2px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--sidebar-type-caption);
  color: var(--ui-text-muted-fg);
}

/* 画线圆章:一圈发丝线,emoji 即身份 —— 与房间成员章同一句法,尺寸按侧栏
   行高收到 18px。无填充、无阴影。 */
.sidebar-agent-avatar {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--sidebar-row-ink, var(--ui-text-primary-fg)) 30%, transparent);
  border-radius: 50%;
  /* 同上:18px 圆章内的 emoji 字号,由直径定,不上字号阶梯。 */
  font-size: 10px;
  line-height: 1;
}

.sidebar.collapsed {
  padding: 0;
  overflow: hidden;
  border: none;
  box-shadow: none;
}

/* ── 协作形态的左栏:rail + 单类面板(样板 sidebar-4.html 第三格)────────────
   四区重排的那五条 `order` 已随「一次只显示一类」一起删除 —— 面板里一次只有
   一区,没有可排的坐次了。整段原本挂在 `data-shell-mode='workbench'` 门里,
   U0b 把门解了(形态开关退役,那个属性恒真),规则本身一字未动。 */
/* ⚠️⚠️ 本仓库最容易再踩的 CSS 坑:**`:global(X) .y` 会被静默截断成 `X`。**
 *
 * `@vue/compiler-sfc`(3.5.26)的 scoped 插件遇到 `:global()` 时,会把该复合
 * 选择器**之后的所有部分丢掉**。实测:
 *
 *   `:global(html[x]) .a > .b`  →  `html[x]`              ← 后代整段消失
 *   `html[x] .a > .b`           →  `html[x] .a > .b[data-v-xxx]`   ← 正确
 *   `:global(html[x] .a > .b)`  →  `html[x] .a > .b`      ← 正确但完全不作用域
 *
 * 后果不只是"规则失效",而是**声明被扣到 `<html>` 头上**。C1 落地的那五条
 * `:global(html[x]) .sidebar-content > .xxx { order: N }`
 * 编译出来是 `html[x] { order: N }` —— 这才是「order
 * 一直是死规则、真机上联系人仍在群聊之上」的真因(不是"父级不是 flex":
 * `.sidebar-content` 是 `Space` 的根,`.app-space` 本来就 `display:flex` +
 * `.app-space--vertical` 的 column;`Space` 也只在 `spacer`/`fill` 时才包
 * `.app-space__item`,侧栏两者都没有,四区一直是直接子)。
 *
 * 正确写法:祖先是 `html` 时**根本不需要 `:global`** —— scoped 只给最后一个
 * 复合选择器补 `[data-v-xxx]`,祖先部分照原样输出,作用域还在。 */

/* 样板 `.sb3 .split`:头行**下面**才是 rail | 面板 的那一横排。 */
.sidebar-split {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

/* 样板 `.sb3 .pane`:面板吃掉 rail 之外的全部宽度。 */
.sidebar-pane {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

/* 面板是**唯一**的滚动体(样板 `.sb .scroll`)。会话列表同期交出内部滚动
   (规则在 SessionList.vue 自己的形态门里),不出双滚动条。
   classic 下这一层仍是 `display: contents`(见上),四区照旧是 `.sidebar-content`
   的直接布局子 —— 那边一个像素不变。 */
.sidebar-sections {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-bottom: 8px;
  overscroll-behavior: contain;
}

/* ── 面板里的行(样板 `.sb .r` + `.sb3 .r`)────────────────────────────────
   群聊/联系人两区的**标记一个字节没动**(同一份模板、同一批类名),这里只在
   workbench 门里把它们换成样板的行:30px 行高、6px 圆角、左右 8px 外边距,
   hover 4.5% 填充,当前项 7.5% 且转墨色。classic 那边的画线风行照旧。
   门写成 `html[...] .xxx` 而**不是** `:global(html[...]) .xxx` —— 见上面那段。 */
.sidebar-pane .sidebar-rooms {
  /* 行间 2px 呼吸缝(ui-system.md §1):这一门里的行是满宽圆角底色块,hover 与
     active 紧邻时圆角互相填平会焊成一整条通板。容器本来就是 flex column,缝用
     `gap` 画 —— 它只落在行与行之间,不在首尾各多出一份,外缘几何逐像素不变
     (行上挂 margin 反而要再补一次 padding)。classic 那边行没有填充,门外一个
     字节不动。 */
  gap: 2px;
  padding: 0 0 6px;
}

.sidebar-pane .sidebar-room-item {
  /* 选中底只定义一次,下面加深的那一档贴着它写,免得两处数值各自漂移。
     G8-b:这两档(hover 4.5% / 当前项 7.5%)手写的百分比与主题层 rail 族的配方
     **逐字相同**,于是**成对**迁到 `--ui-sidebar-rail-{hover,active}-bg` —— 拆开迁
     就是波 2 那个阶梯倒挂的做法。实测(18 主题 × 明暗双向,resolver + css-mapper
     实跑):手写 vs token Δ中位 5.0 / 4.9(残差是 token 以 rail 底为基多带的那
     2.4% 墨,css-mapper 注里写着);迁移后阶梯 36/36 单调,hover 离侧栏面 Δ中位
     14.0 / 最小 12.0,下面「加深一档」那条 36/36 仍站在当前项之外。 */
  --sidebar-pane-row-active-fill: var(--ui-sidebar-rail-active-bg);

  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 30px;
  height: 30px;
  margin: 0 8px;
  padding: 0 8px;
  border-radius: 6px;
  color: var(--sidebar-row-fg, var(--ui-text-primary-fg));
}

.sidebar-pane .sidebar-room-item:hover {
  background: var(--ui-sidebar-rail-hover-bg);
  color: var(--sidebar-row-ink, var(--ui-text-primary-fg));
}

.sidebar-pane .sidebar-room-item.is-active {
  background: var(--sidebar-pane-row-active-fill);
  color: var(--sidebar-row-ink, var(--ui-text-primary-fg));
  font-weight: 500;
}

/* 手指着一行已经选中的房/同事。两条底色规则原本都是 (0,4,1) 的平局,`.is-active`
   写在后面就赢,选中行成了死区 —— 选中不等于这一行不再响应指针(ui-system.md §1)。
   面 register 只剩"加深一档"这一条通道,掺 `--ui-text-primary-fg`(浅色主题是深的、
   深色主题是浅的)让这一档两边都成立,不写死 alpha/hex。(0,5,1) 直接压过,不留平局。 */
.sidebar-pane .sidebar-room-item.is-active:hover,
.sidebar-pane .sidebar-room-item.is-active:focus-visible {
  background: color-mix(in srgb, var(--sidebar-pane-row-active-fill) 92%, var(--ui-text-primary-fg));
}

/* 样板 `.r .nm`:名字吃掉所有余量,省略号永远画在名字上。 */
.sidebar-pane .sidebar-room-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 职位退成样板的 `.meta`(12px 副文,靠在行尾)。 */
.sidebar-pane .sidebar-contact-title {
  flex: 0 0 auto;
  font-size: var(--sidebar-type-meta);
  opacity: 1;
  color: color-mix(in srgb, var(--sidebar-row-ink, var(--ui-text-primary-fg)) 47%, transparent);
}

/* 「私下」子分组头退成样板的 `.grp`(与「进行中」的组头同一句法)。 */
.sidebar-pane .sidebar-subgroup {
  padding: 12px 14px 3px;
  font-size: var(--sidebar-type-caption);
  font-weight: 500;
  letter-spacing: 0;
}

.sidebar-pane .sidebar-subgroup-item {
  padding-left: 22px;
}

/* 会话列表交出它的内部滚动:统一容器里再来一层 `overflow: auto` 就是双滚动条。
   `.session-list-wrapper` 的 `flex: 1` 也得让位 —— 在滚动容器里它该按内容
   撑开,而不是抢走整条竖轴。规则写在 `SessionList.vue` 自己身上(scoped CSS
   够不到子组件内部,而 `.sessions-list` 的 `contain: strict` 必须同时解开)。 */

/* ── 窄窗那条 `@media (max-width: 768px)` 在 L5 删除,而不是改写成 `@container`
   ────────────────────────────────────────────────────────────────────────────
   它做的事是"窗口一窄就把**停靠态**侧栏改成 `position: fixed`"。三条理由让它
   既不该留、也没法容器化:

   1. **它已经是第二条窄窗降级路**。L2 的布局协调器(`useShellLayout`)按预算
      算降级:窗宽不够时侧栏自动转浮层(`sidebarFloatingByBudget`),而浮层态
      的 `position: fixed` 写在 `.sidebar.floating` 上。P7 说的"响应式基准用
      窗口宽"正是这条规则本身 —— 把它容器化只是把一条重复的机制换个写法留着。
   2. **它今天就是个 bug**。侧栏可以窄到 200px:窗宽 768 + 侧栏 200 时聊天列
      还有 568px(> 480 硬下限),协调器判定继续停靠,而这条 `@media` 会把停靠
      态的侧栏抽成 fixed —— 聊天区当场被压在侧栏底下。
   3. **没有一个诚实的容器可以承担它**。规则的主语是 `.sidebar` 自己(元素查
      不了自己);它的父级左栏 region 恒 ≤500px,查询会永远为真;而把整条
      `.app-shell` 变成容器要给它加 containment,那会把壳内所有 `position: fixed`
      的浮层(语音面板等)的包含块和层叠上下文一起改掉 —— 为一条该删的规则付
      这个代价不划算。

   窄窗下侧栏该怎么表现,唯一的事实在协调器里。 */
</style>
