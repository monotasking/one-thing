# 数据目录锁的诊断与离线恢复

本命令复用现有 `inspectStoreLock` 与 `quarantineStoreLockForRecovery`。它不启动 daemon，不装配 Backend，不申请新的写入锁，也不会因为 PID 消失自动解锁。

## 默认只诊断

```sh
onething store lock
onething store lock inspect --store /absolute/path/to/store
```

省略 `inspect` 与显式指定它相同。省略 `--store` 时遵循 CLI 已有的数据目录设置；命令只读取并输出 JSON，目标目录不存在时也不会创建目录。输出包含规范化的数据目录和锁路径、锁协议状态、持有者、进程探测结果，以及锁条目的完整 `identity`。

`processState: "not-running"` 只表示这次探测确认记录的 PID 不存在，并不能证明全部宿主或自动启动器已经停止。`EPERM` 不会被解释为进程退出。未知、损坏、正在初始化或不支持的协议必须保留现场处理。

## 明确离线后恢复

1. 停止访问同一物理数据目录的全部 Desktop、Server、daemon 及开发启动器，并禁用自动重启。在整个操作期间防止任何宿主重新启动。
2. 在保持停机的情况下重新诊断，将结果保存到自选的诊断文件。文件建议放在数据目录外，保留原文件以便核对。

   ```sh
   onething store lock inspect --store /absolute/path/to/store > /absolute/path/to/reviewed-lock.json
   ```

3. 审阅文件中的 `storePath`、`lockPath`、持有者、`processState` 及 `identity`，确认目标正确、旧进程确已退出。不要编辑身份字段，也不要把在线诊断文件直接当作停机证明。
4. 只有完成上述人工检查后才执行：

   ```sh
   onething store lock recover \
     --store /absolute/path/to/store \
     --identity-file /absolute/path/to/reviewed-lock.json \
     --all-hosts-stopped \
     --automatic-restarts-disabled
   ```

两个无值开关是操作者作出的前提断言，并不是工具自动核实停机的能力。恢复必须显式指定 `--store`；读取的是用户提供的既有诊断身份，工具不会用刚读取的新身份替换它。规范化路径不同、身份变化、存活或可能复用的 PID、无法确认的进程状态、未知锁归属或协议均拒绝恢复。参数 `--force`、`--yes` 和在线抢占模式不受支持。

成功时返回 `quarantined: true`、规范化 `storePath` 和 `quarantinePath`。原锁通过既有协议移入 `<store>/run/lock-recovery-<uuid>/backend.lock`，内容保留，不递归删除锁或业务数据，也不清理发现文件、修复账本或启动新实例。随后可以再次运行只读诊断，确认原锁位置为空，再启动一个宿主。

失败以非零退出码和具体错误输出。若复核或移动失败，原协议保留原锁；过程中可能已创建空的诊断目录，不应将这个目录的存在当作恢复成功。不要通过删除锁绕过错误。

## 范围

此入口覆盖既有目录锁以及可诊断的旧文件锁，遵循已有协议的保守规则。它没有新增跨平台 OS 持锁句柄，也没有扩展到网络共享文件系统或未遵循锁协议的旧写入工具。CLI 参数和隔离测试不替代操作者对所有相关宿主停机的确认。
