/**
 * R2b —— 切换开关(设计文档 §7 纪律 2)。
 *
 * 一个进程级的内部 flag,**不进设置页、不进 IPC、不进会话状态**:它只在切换期
 * 存在,R4 删旧树时连同它一起消失。所有接线点(三处引擎缝 + 目录投影 + 装配)
 * 只认这一个函数 —— 一个开关有两个读法就等于两个开关。
 *
 * 每次现读 `process.env`,不缓存:测试要能在一个进程里翻开关,而缓存会让"翻了
 * 却没生效"变成一种只在测试里出现的假象。
 *
 * R4a(2026-08-18 用户拍板):默认值翻成**开**。`ONETHING_TOOLKIT=0` 是杀开关,
 * 出问题一秒回旧路;`=1` 仍被接受(向后兼容启动脚本)。R4b 删旧树时连同这个
 * 文件一起消失。
 */

export const TOOLKIT_FLAG_ENV = 'ONETHING_TOOLKIT'

export function isToolkitEnabled(): boolean {
  return process.env[TOOLKIT_FLAG_ENV] !== '0'
}
