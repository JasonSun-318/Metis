# 定时任务

ArcMind 只在主 Chat 会话中提供定时任务。可以在终端输入 `/schedule` 使用结构化表单，或者直接告诉模型“在什么时候、按什么周期、执行什么任务”。两种入口共用同一套全局存储和调度逻辑；所有 Chat 会话看到同一份任务列表。

## 创建和运行

`/schedule` 只要求填写任务内容、执行周期和时间。支持：

- 指定日期和时间执行一次；
- 每天指定时间；
- 每周指定星期和时间；
- 每月指定日期和时间；
- 从指定日期时间开始，每隔若干分钟或小时。

时间按创建时设备的 IANA 时区保存。夏令时跳变使用兼容规则；每月的 29、30、31 日会在较短月份取该月最后一天。

在 Chat 中创建时，模型会提交不依赖当前对话也能理解的完整说明；时间、周期或任务对象不明确时会先询问。模型只能提交任务说明和时间周期，不能选择运行目录、时区、模型、权限或沙箱。Code、定时任务执行会话和子代理都不会获得 `/schedule`、提示词或工具。

执行目录由创建入口自动确定：

- 用户选择了目录的 Chat 会话复用该目录；
- 普通托管 Chat 会话或不指定来源会话的 AppServer 请求使用任务专属目录。

任务专属目录会被同一周期任务的多次执行复用。每次执行都会创建一个全新的、可在普通会话列表中看到的只读 Chat 会话，不会继承创建任务时的对话、附件、记忆、Skill、扩展、MCP 或子代理。

## 安全和在线条件

调度器只在至少一个 ArcMind CLI 或 AppServer 进程运行时工作，不会安装系统服务。多个进程同时运行时只有一个进程取得全局调度锁，最多并行执行两个不同任务；同一任务不会重叠运行。

无人值守执行使用严格的 workspace-write 隔离：结构化文件工具和 Shell 都不能读取或写入任务工作目录之外的用户文件。为了启动命令，沙箱只额外开放标准操作系统运行库、可执行目录和本次运行的独立临时目录读取权限；Shell 网络被禁止，`web_search` 和 `web_fetch` 仍由可信宿主执行。隔离运行时不可用时任务会失败，不会退回 Full 权限或无隔离执行。

关机超过一分钟错过的周期会合并为一条未执行记录，并把下次时间推进到未来；任务重叠会记录为已跳过。失败不自动重试，用户可以选择“立即运行”。

## 结果和删除

每次执行都有独立结果记录和可见只读会话；模型失败、中断或没有最终文本时也会保留已经创建的会话，供用户查看失败现场。会话保存在执行目录对应的普通 Chat 会话目录，并带有 `taskId`/`runId` 标识；AppServer 在运行完成时增量登记它，不需要重新扫描全部会话。`/schedule` 可以查看未读数量、执行历史和完整结果；模型可以用 `list` 找回任务 ID，再用 `get` 查询最新执行状态和结果会话。AppServer 可通过 `session/list`、`session/open`、`session/readItems` 只读查看，并用 `session/close` 释放内存投影。执行会话不能继续输入、转向、归档、分叉或重命名，也不会通知或唤醒创建任务的原会话。

暂停保留任务和全部历史；编辑只影响之后的执行；立即运行不会改变原周期。删除任务会等待正在执行的实例结束或取消，然后删除任务元数据、全部执行记录、全部执行会话，以及 ArcMind 创建的任务专属目录。用户选择的固定目录和任务在其中生成的文件永远不会随任务删除。

## AppServer 接口

能力标识为 `schedules.v1`。方法包括：

- `schedule/create`、`schedule/list`、`schedule/get`、`schedule/update`
- `schedule/pause`、`schedule/resume`、`schedule/delete`、`schedule/run-now`
- `schedule/run/list`、`schedule/run/get`、`schedule/run/mark-read`
- `schedule/subscribe`、`schedule/unsubscribe`

事件包括 `schedule/updated`、`schedule/deleted`、`schedule/runCompleted`、`schedule/runFailed`、`schedule/runMissed`、`schedule/runSkipped` 和 `schedule/refreshed`。事件只包含列表刷新所需的摘要，不包含会话正文、工具参数、思考内容、凭据或内部文件路径。

任务存储损坏时，普通会话仍可使用；所有定时任务方法返回明确的 `SCHEDULE_STORE_CORRUPT` 错误，直到用户修复存储文件。
