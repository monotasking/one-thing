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
 * (`seek` / `volume` / `prev` / `radio-resume` / `radio-stop` 也不在这一批:前两条
 * 带数值参数、后三条是音乐条自己的手势,它们今天没有任何一条模型路径,而
 * 「先给能力面开一格,再去找调用方」正好是反的。留账。)
 */

import type { JsonSchema, ResourceSpec } from '@onething/core/resource'

export const MUSIC_RESOURCE_SCHEME = 'music'

/** 电台这个单例的路径。地址是 `music:radio`。 */
export const MUSIC_RADIO_PATH = 'radio'
/** 播放器这个单例的路径。地址是 `music:player`。 */
export const MUSIC_PLAYER_PATH = 'player'

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
