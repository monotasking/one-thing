/**
 * K3-b —— 音乐的自述(`docs/design/atom-2026-09.md` §9 K3「三样板:音乐 / 目录 /
 * 会话,`radio` 退役」;`app-intents-2026-09.md` §5 那张表的音乐行:
 * 「play / pause / next / retune / like / open / close;nowPlaying(live)」)。
 *
 * 它是三样板里的**纯 core 驱动**那一格:做的每一件事都在引擎进程里跑完
 * (`home: 'core'` 一条不落),没有一条要壳。
 *
 * ── 为什么住在产品层,而且只有数据 ─────────────────────────────────────────
 * 与 `../sessions/resource-spec.ts` 逐字同一个理由:自述是**值**,实现(开台走哪只
 * 端口、播放走哪条命令)住在装配层(`@onething/backend/wiring/resource/
 * music-provider.ts`),因为只有那里够得着 `backend.music`。这只文件因此**不许**
 * import `@onething/backend`,也不 import 任何 store。
 *
 * ── 两个地址,两个固定单例 ─────────────────────────────────────────────────
 *   · `music:radio`  —— 电台(开 / 换台 / 关 / 点歌,以及它自己那份状态);
 *   · `music:player` —— 播放器(暂停 / 继续 / 下一首 / 红心,以及 nowPlaying)。
 *
 * 它们是**单例**:这台机器上只有一个电台、一个播放器,所以路径是两个字面量而不是
 * id。`ref` 因此可空 —— 每条做法 / 读法只作用在其中一个上,省掉地址不会有歧义
 * (provider 在缺席时按做法自己补,给错了则当场说不;判据写在它那只文件里)。
 *
 * ── 为什么八条做法的 `effects` 全是空数组 ──────────────────────────────────
 * 沿用旧 `toolkit/builtin/radio.ts` 文件头那一段裁定,原文:
 *
 *   > **无效果**:旧实现 `permissionGuard: 'safe'`、没有 `analyze`。它确实会让音响
 *   > 响起来,但那不是本仓权限系统认识的效果类,而为它发明一个 kind 属于「功能形状
 *   > 的洞」(§10.2-② 的纪律)。这一格在 §13 里记了一笔。
 *
 * 那笔账原样带过来:空效果**不等于不留痕迹** —— 每一次「做」照样落 `tool/audit`、
 * 照样发事件,只是不打扰任何人。
 *
 * ── 为什么没有 `stop` ───────────────────────────────────────────────────────
 * 与共享契约里 `MusicCommand` 词表上那条注释同一句话:`stop` 拆掉播放会话,下一次
 * 开播要冷启动守护进程,而那不可靠 —— **一个有时会把音乐弄丢的暂停键,比没有暂停
 * 键更糟**。词表里没有它,这里也没有。
 * (那只契约文件的路径这里**故意不写全**:产品层禁止依赖跨进程契约包,而边界门是
 * 按字面扫的 —— 它连注释里的一条路径都算,这是对的。)
 * (K3-b 那一批把 `seek` / `volume` / `prev` / `radio-resume` / `radio-stop` 留了账,
 * 理由是「它们今天没有任何一条模型路径,先给能力面开一格再去找调用方正好是反的」。
 * **音乐收尾这一单把那笔账还了**,而且还的理由正是当初留账时缺的那一半:调用方
 * 出现了 —— 音乐条上那几个按钮从今天起走的就是这条路(那十四条 RPC 方法逐条退成
 * 了这份自述的投影),所以「先有调用方,再开能力面」的次序没有被破坏。)
 *
 * ── 音乐收尾:三个单例,而不是两个 ─────────────────────────────────────────
 * K3-b 只认电台与播放器两个单例,因为它只服务模型那一条路,而模型只会开台、点歌、
 * 暂停、切歌。十四条 RPC 方法退成投影时冒出来的另一半是**音乐后端自己**:哪一只
 * CLI 在跑、装没装好、登没登录、能搜到什么。它既不是电台也不是播放器 —— 电台关着
 * 的时候它照样要回答「ncm-cli 装了没有」,播放器没起的时候它照样搜得到歌。所以
 * 它是第三个单例 `music:provider`。
 *
 * 名字跟着这个仓库自己的词走(设置里那一格叫 `music.provider`、契约里那份描述符叫
 * 「provider descriptor」、RPC 那两条叫 `listProviders` / `setProvider`),而不是另
 * 发明一个 —— 同一件东西在两处两个名字,是文档写得再清楚也拦不住的误读。
 */

import type { JsonSchema, ResourceSpec } from '@onething/core/resource'

export const MUSIC_RESOURCE_SCHEME = 'music'

/** 电台这个单例的路径。地址是 `music:radio`。 */
export const MUSIC_RADIO_PATH = 'radio'
/** 播放器这个单例的路径。地址是 `music:player`。 */
export const MUSIC_PLAYER_PATH = 'player'
/** 音乐后端(那只 CLI)这个单例的路径。地址是 `music:provider`。 */
export const MUSIC_PROVIDER_PATH = 'provider'

/**
 * 现在在放什么(`nowPlaying` 的结果 / `nowPlayingChanged` 的载荷 / `state.nowPlaying`
 * 共用同一份 schema —— 三处是同一件事的三个出口,不是三张会漂移的表)。
 *
 * **没有单独的 `artist` 一格**,这是照实写而不是漏了:播放器交出来的 `title` 就是
 * CLI 的展示串(`可惜没如果 - 林俊杰`),歌名与歌手在同一个字符串里,这台机器上
 * 没有第二个产地。给它加一格恒空的 `artist`,读表的人会以为那是一件拿得到的事实。
 */
const NOW_PLAYING_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    playing: { type: 'boolean', description: 'Whether sound is coming out right now.' },
    status: {
      type: 'string',
      enum: ['playing', 'paused', 'stopped'],
      description: 'Player state. No player running reads as "stopped".',
    },
    title: {
      type: 'string',
      description: 'The display string the CLI hands over, e.g. "可惜没如果 - 林俊杰" — song and artist in one.',
    },
    position: { type: 'number', description: 'Seconds into the song.' },
    duration: { type: 'number', description: 'Song length in seconds.' },
    progress: { type: 'string', description: "The player's own formatting, e.g. `4:01 / 4:58`." },
    queueLength: { type: 'number' },
    currentIndex: { type: 'number', description: 'Where in the queue we are.' },
  },
  required: ['playing', 'status', 'position', 'queueLength', 'currentIndex'],
}

/** 电台自己的状态 —— 旧 `RadioToolStatus` 逐格同形(`active` / `intent` / …)。 */
const RADIO_STATUS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    active: { type: 'boolean', description: 'Is the station on.' },
    intent: { type: 'string', description: "The station's current brief." },
    programmeLength: { type: 'number', description: 'How many songs are still curated ahead.' },
    nowPlayingTitle: { type: 'string' },
    lastError: { type: 'string', description: 'What went wrong last, if anything.' },
  },
  required: ['active', 'intent', 'programmeLength'],
}

const NO_PARAMS: JsonSchema = { type: 'object', properties: {}, required: [] }

/**
 * 开台 / 换台的意图。描述**逐字沿用**旧 `RadioInputSchema.intent` —— 资源工具没有
 * prompt 贡献,schema 的描述就是它的提示词,改一个字就是改模型的行为指引。
 */
const INTENT_PARAMS: JsonSchema = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      description:
        'The listener\'s mood/style in one plain sentence, e.g. 「下雨天,安静的中文民谣」. This becomes the station\'s brief for the DJ.',
    },
  },
  required: ['intent'],
}

/**
 * 音乐条要的那份电台简报。
 *
 * ## 为什么它与 `radio` 是**两条读法**,而不是一条
 *
 * 同一个单例上两条读法通常是异味,这一处不是:它们答的不是同一个问题。
 *   · `radio`(旧 `radio(action:"status")`)答的是**电台自己的状态** —— 开没开、
 *     简报是什么、还剩几首、出没出错。模型要的正是这四件事。
 *   · `brief` 答的是**那条音乐条画一帧要的全部事实**,而那里面有三格根本不属于
 *     电台:`volume` 是播放器的音量(从 CLI 自己的 prefs 文件里读出来的)、
 *     `canResume` 是「续播键要不要点得亮」、`starting` 是「换歌中还是卡住了」。
 *
 * 把它们并成一条,代价是二选一:要么模型每次问状态都顺带付一次读 prefs 文件的钱,
 * 要么音乐条自己去补那三格 —— 后者就是「出口自己算事实」,正是原子要消灭的形状。
 */
const RADIO_BRIEF_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    active: { type: 'boolean', description: 'Is the station on.' },
    intent: { type: 'string', description: "The station's current brief." },
    lastError: { type: 'string' },
    starting: {
      type: 'string',
      description:
        'Title of the song a start is in flight for — this is what tells a bar "changing song" apart from "the radio stalled".',
    },
    programmeLength: { type: 'number' },
    canResume: { type: 'boolean', description: 'Whether radioResume has anything to play.' },
    upNext: { type: 'string', description: 'What plays next, when that is knowable at all.' },
    volume: { type: 'number', description: "The player's persisted volume, 0-100, when the CLI keeps one." },
  },
  required: ['active', 'intent', 'programmeLength', 'canResume'],
}

/** 一首歌的定时歌词。没有歌词 = `null`,不是一次失败(氛围少一样,不是错)。 */
const LYRICS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Matches nowPlaying.title — read it before showing.' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          at: { type: 'number', description: 'Seconds from the song start.' },
          text: { type: 'string' },
        },
        required: ['at', 'text'],
      },
    },
  },
  required: ['title', 'lines'],
}

/** 节目单:还排着的那些歌,以及此刻在台上的那一首。 */
const PROGRAMME_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          encryptedId: { type: 'string', description: "The catalogue id this entry is addressed by." },
          title: { type: 'string' },
          say: { type: 'string', description: "The DJ's patter for this entry." },
          note: { type: 'string', description: 'e.g. 点歌 for a song the listener asked for.' },
          playFlag: { type: 'boolean', description: 'false = rights-restricted; the conductor skips it.' },
        },
        required: ['encryptedId', 'title'],
      },
    },
    onDeck: { type: 'string', description: 'Title of the song the station started last.' },
  },
  required: ['entries'],
}

/**
 * 音乐后端此刻的状态 —— 装到哪一步了、登没登录、用哪个播放器。
 *
 * 它就是安装向导每一步回来的那一份(旧 `getState` / `setup` 共用的回执),照实
 * 抄:`setupStage` 是向导停在哪一格,`env` 是那几件工具在不在这台机器上。
 */
const RUNTIME_STATE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    setupStage: {
      type: 'string',
      enum: ['env', 'credentials', 'login', 'ready'],
      description: 'Which step of the setup wizard this machine is standing on.',
    },
    configured: { type: 'boolean', description: 'Credentials were written into the CLI\'s own config.' },
    loggedIn: { type: 'boolean' },
    playerBackend: { type: 'string', description: "Which player plays the sound (the CLI's own, or a desktop app)." },
    source: { type: 'string', description: 'Which catalogue feed the station draws from.' },
    /**
     * 登录那一步的现状。**没有「已扫码待确认」**——判词写在 types.ts 的
     * `OnethingMusicLoginStatus` 上:`login --check` 只答成没成。
     */
    login: {
      type: 'object',
      description: 'Where the login step stands. There is no "scanned, awaiting confirmation" — the CLI cannot observe it.',
      properties: {
        status: {
          type: 'string',
          enum: ['idle', 'starting', 'waiting', 'ok', 'failed', 'quota'],
        },
        url: { type: 'string', description: 'The login address to scan or open. Present while waiting.' },
        message: { type: 'string', description: "The backend's own words on failure / quota." },
      },
      required: ['status'],
    },
    lastError: { type: 'string' },
    env: {
      type: 'object',
      description: 'Which of the required tools are installed on this machine.',
      properties: {
        tools: { type: 'object', description: "Keyed by the provider's own tool ids." },
        npmAvailable: { type: 'boolean' },
        brewAvailable: { type: 'boolean' },
      },
    },
  },
  required: ['setupStage', 'configured', 'loggedIn', 'playerBackend', 'source', 'login'],
}

/** 这台机器上有哪几只音乐 CLI 可选,现在用的是哪一只。 */
const PROVIDERS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    providers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          binary: { type: 'string' },
          setupStages: { type: 'array', items: { type: 'string' } },
          loginKind: { type: 'string' },
        },
        required: ['id', 'label', 'binary'],
      },
    },
    activeId: { type: 'string' },
  },
  required: ['providers', 'activeId'],
}

/** 搜一首歌。**读**:它不改这台机器上任何一格,而且同一个词搜两遍答案一样。 */
/**
 * 跟主持人说的一句话(正本 `apps/desktop-react/docs/music-panel-2026-09.md` §7.1)。
 *
 * 描述里说清两件事,因为它们是这条做法与 `request` / `retune` 的全部差别:进的是
 * 他那条真会话(所以他会回话、会自己去改节目单),而这一条**自己**什么都不改。
 */
const TELL_PARAMS: JsonSchema = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description:
        'What the listener wants to say to the host, in their own words. It lands as a user message in the DJ\'s own session: he may answer, and he may re-curate the programme himself.',
    },
  },
  required: ['text'],
}

const SEARCH_QUERY: JsonSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '「歌名 歌手」-ish free text.' },
  },
  required: ['query'],
}

const SEARCH_RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          artist: { type: 'string' },
          playFlag: { type: 'boolean', description: 'false = rights-restricted; it will not play.' },
        },
        required: ['title'],
      },
    },
  },
  required: ['records'],
}

/**
 * 节目单的一次编辑。参数**保持嵌一层**(`{ action: { kind, … } }`),不摊平 ——
 * 两个理由,都不是风格:
 *   ① 这个联合在契约里就叫 `action`,而拒绝的那句话是「action is required」;摊成
 *      `kind` 之后那句话就开始说谎(它要的是 `kind`,却说要 `action`);
 *   ② 三个 kind 的必填项不同(`move` 多一格 `toIndex`),嵌一层之后这份差异写在
 *      同一处,摊平之后它会散进三条做法或者一条谁都不必填的做法。
 */
const PROGRAMME_ACTION_PARAMS: JsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'object',
      description: 'remove doubles as the strongest taste signal — it steers the next batch away.',
      properties: {
        kind: { type: 'string', enum: ['remove', 'promote', 'move'] },
        encryptedId: { type: 'string', description: "The entry's catalogue id (from the programme read)." },
        toIndex: { type: 'number', description: 'move only: where in the queue it goes.' },
      },
      required: ['kind', 'encryptedId'],
    },
  },
  required: ['action'],
}

/**
 * `seek` / `volume` 的数值参数。
 *
 * **不写 `required`**,这一格是刻意的:缺一个数值与给错一个数值(NaN / Infinity)
 * 在旧路上是**同一句话**(`「seek 需要一个数值参数」`),而契约校验者只看判别键、
 * 不解释 params(`core/resource/validator.ts` 的文件头)。所以两种都由 `plan` 判、
 * 由 `plan` 说那一句 —— 写成 `required` 只会让「缺」与「错」分头走两条路、说两句话。
 */
const SEEK_PARAMS: JsonSchema = {
  type: 'object',
  properties: {
    position: { type: 'number', description: 'Target position in seconds from the song start.' },
  },
}

const VOLUME_PARAMS: JsonSchema = {
  type: 'object',
  properties: {
    level: { type: 'number', description: 'Absolute volume, 0-100.' },
  },
}

/**
 * 安装 / 配置向导的一步。
 *
 * 每一步都回**整份** `RUNTIME_STATE_SCHEMA`(向导停在哪一格也在里面)—— 这是旧
 * `setup` 的口径,原样带过来:一次配置操作之后「现在到哪一步了」是调用方唯一真正
 * 要问的事,让它再问一遍等于给一个必然的往返。
 */
const SETUP_PARAMS: JsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'check-env',
        'install-tool',
        'set-credentials',
        'set-player',
        'login-start',
        'login-cancel',
        'login-check',
        'logout',
      ],
    },
    tool: { type: 'string', description: 'install-tool: which tool to install.' },
    appId: { type: 'string', description: 'set-credentials: written straight into the CLI\'s own encrypted config.' },
    privateKey: { type: 'string', description: 'set-credentials: never persisted by this app.' },
    player: { type: 'string', description: 'set-player: which player plays the sound.' },
  },
  required: ['action'],
}

const SET_PROVIDER_PARAMS: JsonSchema = {
  type: 'object',
  properties: {
    providerId: { type: 'string', description: 'One of the ids the providers read lists.' },
  },
  required: ['providerId'],
}

export const musicResourceSpec: ResourceSpec = {
  scheme: MUSIC_RESOURCE_SCHEME,
  title: 'Music — the personal radio station and the player',
  reads: {
    /**
     * 现在在放什么。**没有播放器在跑**时答的是一份「停着」的读数,而不是「查无此
     * 播放器」——与会话那份自述的 `tokenUsage` 同一条判据:对这份读数的消费者
     * (音乐条、模型的「还要不要再放一首」)来说,「守护进程没起」与「停着」是
     * 同一件事,把它拆成两种答案只会让每个出口各写一次分支。
     */
    nowPlaying: {
      title: 'Read what is playing right now',
      query: NO_PARAMS,
      result: NOW_PLAYING_SCHEMA,
    },
    /**
     * 电台此刻是什么状态 —— 旧 `radio(action: "status")` 就是它。
     *
     * 它从做法变成读法,是因为它本来就是一次纯查询:不改任何东西、可缓存、
     * 不该落审计(§2 不变量 1)。旧路把它写成一个 action,只是因为那时一只工具
     * 只有 action 这一个入口。
     */
    radio: {
      title: 'Read the station state: what is playing, songs left, problems',
      query: NO_PARAMS,
      result: RADIO_STATUS_SCHEMA,
    },
    /** 音乐条画一帧要的那一份。与 `radio` 为什么是两条,写在 schema 那一格上。 */
    brief: {
      title: 'Read the bar brief: station state plus resume-ability, up-next and volume',
      query: NO_PARAMS,
      result: RADIO_BRIEF_SCHEMA,
    },
    /** 排在后面的那些歌。`programmeAction` 编辑的就是这一份。 */
    programme: {
      title: 'Read the programme: the songs still queued, and the one on deck',
      query: NO_PARAMS,
      result: PROGRAMME_SCHEMA,
    },
    /** 当前这首歌的定时歌词。没有 = `null`。 */
    lyrics: {
      title: 'Read the timed lyrics of the song that is playing',
      query: NO_PARAMS,
      result: LYRICS_SCHEMA,
    },
    /**
     * 音乐后端装到哪一步了。
     *
     * **它是读不是做**,判据用的是 §6 那一条「换一个 principal 说不说得通」:一台
     * 网关会话、一只插件、一个脚本来问「这台机器上的音乐 CLI 装好了没有」,句子
     * 是成立的,而且问一百遍这台机器一格都不会变。反过来 `setup` 换谁来问都是在
     * **动**这台机器,所以它在 ops 里。
     */
    state: {
      title: 'Read the music backend state: setup stage, which tools are installed, logged in or not',
      query: NO_PARAMS,
      result: RUNTIME_STATE_SCHEMA,
    },
    /** 有哪几只音乐 CLI,现在用的是哪一只。 */
    providers: {
      title: 'Read the available music CLI backends and which one is active',
      query: NO_PARAMS,
      result: PROVIDERS_SCHEMA,
    },
    /**
     * 搜歌。**读**,尽管它会去问一次服务器:读的判据是「改不改这台机器」,不是
     * 「花不花时间」(`ReadSpec` 结构性没有 effects 那一格,正是这条不变量的类型层
     * 落点)。它与 `request` 的分工也因此干净:搜是看有什么,点歌是让它响。
     */
    search: {
      title: 'Search the catalogue for a song (looking only — requesting it is an op)',
      query: SEARCH_QUERY,
      result: SEARCH_RESULT_SCHEMA,
    },
  },
  ops: {
    /**
     * 八条做法的 `effects` 全是空数组,理由在文件头(旧 radio 那段裁定原样带过来)。
     */
    open: {
      title:
        'Start the personal radio station — the default way to play music that keeps going ("放点歌", "来点轻音乐,一直放着"). The DJ agent curates the programme and playback starts on its own (first song within ~a minute). You never pick songs yourself.',
      params: INTENT_PARAMS,
      effects: [],
      home: 'core',
      entity: 'station',
      keymap: true,
      describe: params => `open the radio: ${String((params as { intent?: unknown }).intent ?? '')}`,
    },
    retune: {
      title: 'Retune the station: a new direction, the old programme discarded.',
      params: INTENT_PARAMS,
      effects: [],
      home: 'core',
      entity: 'station',
      describe: params => `retune the radio: ${String((params as { intent?: unknown }).intent ?? '')}`,
    },
    close: {
      title: 'Stop the station and the music — the user is done ("别放了").',
      params: NO_PARAMS,
      effects: [],
      home: 'core',
      entity: 'station',
      keymap: true,
      describe: () => 'close the radio',
    },
    request: {
      title:
        'Cut a song the user named in as the next track (the station must be on). NEVER play manually while the radio is on. Only play manually (ncm-cli via bash, see the netease-music-cli skill) when the user names ONE song AND the radio is off.',
      params: {
        type: 'object',
        properties: {
          /**
           * 描述**逐字沿用**旧 `RadioInputSchema.song`(含末尾那句「电台开着时绝不
           * 手动播」)——它与上面 `title` 里那两句是同一条行为指引的两处落点,模型
           * 读到哪一处都成立。
           */
          song: {
            type: 'string',
            description:
              'The song the user named, ideally 「歌名 歌手」. The app searches, verifies playability, and queues it next — never play it manually while the radio is on.',
          },
        },
        required: ['song'],
      },
      effects: [],
      home: 'core',
      entity: 'station',
      describe: params => `request ${String((params as { song?: unknown }).song ?? '')}`,
    },
    /**
     * 跟主持人说一句话(2026-09-18,正本 §7.1)。
     *
     * ── 它为什么也是 `effects: []` ──────────────────────────────────────
     * 与上面四条同一条裁定,但值得写明它的理由:这条做法**只是把话递进去** ——
     * 不出声、不动播放、不改节目单。真正会发生的改动是 DJ 自己用他自己的工具做的,
     * 那些各自过各自的闸(他那条会话里的 bash 一条都没少过权限)。把这一条也标上
     * 效果,等于对着「说句话」弹一张卡,而它背后那些真动作的卡一张都不会少。
     *
     * 它与 `request` / `retune` 的分工:那两条是**结构化的命令**(点名一首歌、
     * 换一句简报),这一条是**一句人话** —— 说什么、要不要照做,由主持人自己判断。
     */
    tell: {
      title:
        'Say something to the radio host in plain words — it lands in the DJ\'s own session as a user message. He answers in a line or two and may re-curate the programme himself. Use this for anything conversational ("这首是谁唱的", "换个心情"); use `request` when the user names one specific song and `retune` when they hand the station a new brief.',
      params: TELL_PARAMS,
      effects: [],
      home: 'core',
      entity: 'station',
      describe: params => `tell the radio host: ${String((params as { text?: unknown }).text ?? '')}`,
    },
    /**
     * 播放器四条,与共享契约里的 `MusicCommand` 词表一一对应
     * (`pause` / `resume` / `next` / `like`)。`stop` 故意没有 —— 理由在文件头,
     * 与那份词表上的注释同一句话。
     */
    pause: {
      title: 'Pause playback.',
      params: NO_PARAMS,
      effects: [],
      home: 'core',
      entity: 'player',
      keymap: true,
      describe: () => 'pause the music',
    },
    resume: {
      title: 'Resume playback.',
      params: NO_PARAMS,
      effects: [],
      home: 'core',
      entity: 'player',
      keymap: true,
      describe: () => 'resume the music',
    },
    next: {
      title: 'Skip to the next song. With the station on this starts the next programme entry and counts as a taste signal.',
      params: NO_PARAMS,
      effects: [],
      home: 'core',
      entity: 'player',
      keymap: true,
      describe: () => 'skip to the next song',
    },
    like: {
      title: 'Heart the song that is playing.',
      params: NO_PARAMS,
      effects: [],
      home: 'core',
      entity: 'player',
      keymap: true,
      describe: () => 'heart the current song',
    },
    /**
     * ── 音乐条那几个手势(音乐收尾这一单补齐)───────────────────────────────
     *
     * `prev` / `seek` / `volume` / `radioResume` / `radioStop` 与上面四条**同一个
     * 词表**(共享契约里的 `MusicCommand`)、同一只端口,只是 K3-b 那一批没有调用方
     * 所以先留了账。现在调用方就是音乐条 —— 而音乐条从今天起也走这条路,所以它们
     * 必须在表上,否则「界面点按钮也走它」那句话在音乐上只成立一半。
     *
     * `effects` 同样一律 `[]`(文件头那条裁定管这一族全部十三条)。
     */
    prev: {
      title: 'Previous track. With the station on there is no player queue to step back through, so this replays the current song from the top — like a physical back button.',
      params: NO_PARAMS,
      effects: [],
      home: 'core',
      entity: 'player',
      keymap: true,
      describe: () => 'previous song',
    },
    seek: {
      title: 'Jump to a position inside the song that is playing.',
      params: SEEK_PARAMS,
      effects: [],
      home: 'core',
      entity: 'player',
      describe: params => `seek to ${String((params as { position?: unknown }).position ?? '')}s`,
    },
    volume: {
      title: 'Set the playback volume (absolute, 0-100).',
      params: VOLUME_PARAMS,
      effects: [],
      home: 'core',
      entity: 'player',
      describe: params => `set volume to ${String((params as { level?: unknown }).level ?? '')}`,
    },
    /**
     * 续播:守护进程走了(那正是这个按钮存在的理由),所以它不是一条传输命令,
     * 而是走保活重启那条路 —— 全仓唯一实测可行的冷启动路径。
     */
    radioResume: {
      title: 'Resume a silent-but-active station from its programme (restarts the player daemon when it went away).',
      params: NO_PARAMS,
      effects: [],
      home: 'core',
      entity: 'station',
      keymap: true,
      describe: () => 'resume the radio',
    },
    /**
     * 与 `close` 是**同一件事的两个回执**,不是两条路:两条都落到同一只
     * `radioToolClose()` 上。差别只在交出去的那句话 —— `close` 交的是给模型看的
     * 电台状态,`radioStop` 交的是给音乐条看的那份 now-playing 读数。真要合并,
     * 合的该是回执的形状,而那要先有一个会读它的界面。
     */
    radioStop: {
      title: 'Full stop from the bar: cut the patter, stop the music, close the station. The programme is kept for a later re-open.',
      params: NO_PARAMS,
      effects: [],
      home: 'core',
      entity: 'station',
      describe: () => 'stop the radio',
    },
    /** 节目单的一次编辑。参数为什么嵌一层,写在 schema 那一格上。 */
    programmeAction: {
      title: 'Edit the programme: drop an entry (also the strongest taste signal), promote it to the front, or move it.',
      params: PROGRAMME_ACTION_PARAMS,
      effects: [],
      home: 'core',
      entity: 'station',
      describe: params => {
        const action = (params as { action?: { kind?: unknown; encryptedId?: unknown } }).action
        return `programme ${String(action?.kind ?? '')} ${String(action?.encryptedId ?? '')}`.trim()
      },
    },
    /**
     * ── 两条动这台机器的能力的做法 ────────────────────────────────────────
     *
     * `setup` 与 `setProvider` 的 `effects` 是 `['capability_change']`,而上面那十三
     * 条是 `[]` —— 这不是给音乐分了两等,是因为它们**做的事根本不同类**:上面十三
     * 条改的是「现在放什么」,这两条改的是「这台机器上音乐这件事由谁来做、装没装
     * 好、拿谁的账号登录」。装一个 npm 包、写一份凭据、换一只 CLI,是换能力。
     *
     * 那是**静态上界**;真发给授权者的按主体分档(见 provider 的 `plan`,与 K3-a'
     * 的 `removeMessage` 逐字同形):设置页上那个按钮是人自己按的,再问一遍是噪音;
     * 模型 / 插件 / 脚本要动它,顶格问,而且 `capability_change` 在效果表里是
     * never-grantable —— 每一次都得有人点头,授权不了「以后都行」。
     */
    setup: {
      title: 'Run one step of the music backend setup: check the environment, install a tool, write credentials, pick the player, log in or out.',
      params: SETUP_PARAMS,
      effects: ['capability_change'],
      home: 'core',
      entity: 'provider',
      describe: params => `music setup: ${String((params as { action?: unknown }).action ?? '')}`,
    },
    setProvider: {
      title: 'Switch the music CLI backend that drives everything (binary, parsers, setup wizard). The station is torn down and re-tuned.',
      params: SET_PROVIDER_PARAMS,
      effects: ['capability_change'],
      home: 'core',
      entity: 'provider',
      describe: params => `switch the music backend to ${String((params as { providerId?: unknown }).providerId ?? '')}`,
    },
  },
  /**
   * ── `opened` / `closed` / `deleted` 这三条通用名在音乐上的填法(§10.3)──────
   *
   * **一条都不发**,而且这不是缺口:§10.3 的规矩原文是「没有『打开』概念的 scheme
   * 只发 `deleted`」,而音乐**连删都没有** —— 电台与播放器是两个恒在的单例,不会被
   * 建出来、也不会被删掉,`music:radio` 这个地址在这台机器上永远指得到东西。
   *
   * 「电台开着没有」是这个单例自己的**状态**(`radio` 读法的 `active` 一格),不是
   * 实例的存在与否;它变化时发的是 `radioOpened` / `radioClosed` 这两条**自己的**
   * 事件,而不是通用的 `opened` / `closed` —— 后两条在 §10.3 里说的是「壳里有没有
   * 一格摆着它」,那是另一件事,将来音乐面板要报也该由壳去报。
   */
  events: {
    radioOpened: {
      title: 'The station was opened or retuned',
      payload: {
        type: 'object',
        properties: { intent: { type: 'string', description: "The brief the DJ was handed." } },
        required: ['intent'],
      },
    },
    radioClosed: {
      title: 'The station was closed',
      payload: NO_PARAMS,
    },
    nowPlayingChanged: {
      title: 'What is playing changed',
      payload: NOW_PLAYING_SCHEMA,
    },
    /**
     * 换了音乐后端。它是**事实**不是命令:发的时候切换已经做完了(旧的一代排干了、
     * 设置写下了、新的一代起来了),读到它的人要做的是重新拉一次自己那份读数,
     * 而不是去做点什么。
     */
    providerChanged: {
      title: 'The active music CLI backend changed',
      payload: {
        type: 'object',
        properties: { providerId: { type: 'string' } },
        required: ['providerId'],
      },
    },
    /**
     * ── 接入向导那两条(2026-09-18;正本 `music-panel-2026-09.md` §6.1)────────
     *
     * **两条都没有 `moment`**:装一个 npm 包、扫一次码,不是「听歌这件事的事实」,
     * 没有谁该对着它开口。它们存在只为一件事 —— 让向导那块面知道该重新问一遍。
     *
     * `setupChanged` 是**事实不是命令**(与 `providerChanged` 同一句话):发的时候
     * 那一步已经做完了,读到它的人该做的是重拉自己那份 `state`,而不是去做点什么。
     * 负载带一格 `setupStage` 是顺手的诚实(provider 手上就有),不是让人拿它当
     * 真相用 —— 真相在 `state` 那条读法上。
     */
    setupChanged: {
      title: 'One step of the setup wizard finished; the backend state changed',
      payload: {
        type: 'object',
        properties: {
          setupStage: {
            type: 'string',
            enum: ['env', 'credentials', 'login', 'ready'],
            description: 'Which step the wizard stands on now. Re-read `state` for the rest.',
          },
        },
        required: ['setupStage'],
      },
    },
    /**
     * 安装一件工具时,那条 npm / brew 命令正在往外吐的字。
     *
     * 它为什么是一条资源事实而不是一条推送:装工具要跑几十秒,屏幕上那块输出是
     * 这一段唯一的「它还活着」的证据,而这台壳(React)**收不到 `MUSIC_EVENT`**
     * ——那条旧推送骑在宿主的 voice 广播口上,而这台壳的 `voice` 端口是 `null`。
     * 走资源事实 = 骑 `resource:event` 那条已经在的全局事件出去,**不新开通道**。
     *
     * 一块输出是给人看的进度,不是账本:没人在看的时候它就消失了,这是对的。
     */
    setupOutput: {
      title: 'A line of output from an in-flight tool install',
      payload: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: "The provider's own tool id (ncm: 'ncm-cli' / 'mpv')." },
          chunk: { type: 'string', description: 'Raw stdout/stderr text, newlines included.' },
        },
        required: ['tool', 'chunk'],
      },
    },
    /**
     * ── 主持人回了那句话(2026-09-18,正本 §7.1)────────────────────────────
     *
     * 产地是装配层订着的那条 DJ 会话的流结束事件:这一轮说完了,取最后一条 assistant
     * 文本。**空文本不发**(他用工具干完活不吭声是合法的),60s 没说完也不发。
     *
     * 负载上同一句话出现两次,而这不是重复:
     *  · `text` 是**事实**本身 —— 他说了什么,谁要读都读这一格;
     *  · `say` 是**给「谁来开口」那条路的现成台词** —— P2 的直通作曲器认的就是这个
     *    键(`runtime/src/pets/composer.ts`)。音乐这一侧仍然不认识宠物:它只是按
     *    那条通用约定,把一句已经写好的话摆在它该在的那一格上。
     *
     * `moment` 是 `high`:这是用户刚刚用行动问出来的一句话,比「开始放一首歌」值得
     * 插队说 —— 他张嘴了,而人正等着。
     */
    hostReplied: {
      title: 'The radio host answered something the user said to him',
      payload: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What the host said, in his own words.' },
          say: {
            type: 'string',
            description: 'The same words, as a ready-made line for whoever speaks moments out loud.',
          },
        },
        required: ['text', 'say'],
      },
      moment: { weight: 'high', gist: '用户跟主持人说了话,他回了一句' },
    },
    /**
     * ── 听歌这件事本身的事实(宠物 P4,`docs/design/pet-system-2026-09.md` §11.1)──────
     *
     * 下面六条都是 `music:player` 上**音乐自己的事实**,各自带一格 `moment`:谁想对「用户
     * 跳过了一首歌」起反应,读这一格就够了。音乐不知道有谁在听 —— 这里一个「宠物」都没有。
     *
     * 产地全在装配层(`wiring/music/moments.ts` 的 `MusicMoments` 与电台那几处调用),规矩写在
     * 那一只文件头上。权重的判据:`low` = 只值得记住(每首歌都会有),`normal` = 值得在冷却
     * 允许时说一句,`high` = 用户在用行动表达不满,值得插队说。
     */
    trackStarted: {
      title: 'The radio confirmed a song is really playing',
      payload: {
        type: 'object',
        properties: {
          title: { type: 'string', description: "The player's own title string." },
          artist: { type: 'string' },
          encryptedId: { type: 'string' },
        },
        required: ['title'],
      },
      moment: { weight: 'low', gist: '开始放一首歌' },
    },
    skipped: {
      title: 'The user skipped the song while the radio was on',
      payload: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
      moment: { weight: 'low', gist: '用户跳过了一首歌' },
    },
    skipStreak: {
      title: 'The user skipped several songs in a short time (the third skip within 90 seconds)',
      payload: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          titles: { type: 'array', items: { type: 'string' }, description: 'The skipped titles, oldest first.' },
        },
        required: ['count', 'titles'],
      },
      moment: { weight: 'high', gist: '用户连着跳过了好几首,可能不喜欢现在的方向' },
    },
    liked: {
      title: 'The user hearted the current song',
      payload: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
      moment: { weight: 'low', gist: '用户喜欢了这首歌' },
    },
    resumedAfterPause: {
      title: 'Playback resumed after being paused for at least five minutes',
      payload: {
        type: 'object',
        properties: {
          pausedMs: { type: 'number', description: 'How long it was paused, as observed by the now-playing watcher (accurate to one poll).' },
          title: { type: 'string' },
        },
        required: ['pausedMs'],
      },
      moment: { weight: 'normal', gist: '用户暂停了一阵又回来继续听' },
    },
    interlude: {
      title: 'The song reached an instrumental break in its middle (at least 12 seconds without vocals, by the lyric timeline)',
      payload: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          atSeconds: { type: 'number', description: 'Where in the song the break starts.' },
          lengthSeconds: { type: 'number', description: 'How long the break lasts.' },
        },
        required: ['title', 'atSeconds', 'lengthSeconds'],
      },
      moment: { weight: 'normal', gist: '这首歌到了一段没有人声的间奏' },
    },
  },
  /**
   * `live` —— 一直在变,所以**不主动喂**提示词,只在工具结果里出现(§3 那张表的
   * volatility 三档)。这一格与会话那份自述的 `state.current` 是同一个位置的两种
   * 答案:会话的身份一回合变一次(`turn`),现在放到第几秒每几秒就变一次。
   *
   * `app-intents-2026-09.md` §7 盲点 4 说的正是这一格存在的理由:「音乐不报
   * nowPlaying,AI 就会『再放一遍』」—— 报得到,但不是靠每回合塞进前缀。
   */
  state: {
    nowPlaying: {
      title: 'What the player is playing right now',
      schema: NOW_PLAYING_SCHEMA,
      volatility: 'live',
    },
  },
}
