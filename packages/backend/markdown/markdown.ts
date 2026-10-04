// markdown 功能的主入口:Markdown 正文里引用的附件与资产怎么落盘、怎么按路径读回来
// (`markdown-asset-service.ts`、`markdown-asset-sandbox.ts`,以及给界面的 IPC 形状 `markdown-ipc-operations.ts`)。
//
// 它对外的面今天只有第二入口 `markdown-client-api.ts`(给 HTTP 服务器挂路由,谁可以引它由 `client-api:gate` 管)。
// 主入口从前是两行 `export *`,把两只文件的 19 个名字全交了出去,但外面没有一处经主入口拿过它们;
// 入口只交外面真用的名字(命名规范 N3,决策 D228 / D235),所以这里今天一个名字都不交。外面要用时,把名字具名加在这里。
export {}
