/**
 * `gate:plugin` 的夹具插件(第④步批 4)。零运行时依赖(装后校验要求如此)。
 * 注册一条以自己 id 命名的命令:经宿主的 `ctx.exec` 跑探针程序 `onething-gate-probe`,把它的 stdout 原样报回。
 * 同一份文件被门复制成几份(不同 id),于是「哪几个插件在跑」从命令表上一眼看得出。
 */
export default function gateExecPlugin(api) {
  api.registerCommand(`/${api.id}`, {
    description: 'Run the gate probe through the host exec',
    async handler(_args, ctx) {
      const result = await ctx.exec('onething-gate-probe', ['from-plugin'])
      ctx.notify(`exit=${result.exitCode} stdout=${String(result.stdout).trim()} stderr=${String(result.stderr).trim()}`, 'info')
    },
  })
}
