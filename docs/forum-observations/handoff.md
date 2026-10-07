# 论坛冻结报告交接与 OIDC 同步

账本接口已经上线。ChatGPT 不持有 GitHub OIDC，只有本仓库 main 的独立 Actions 作业签发 audience `smart-ledger-v6` 的临时令牌。该工作流不执行预测、模型结算或站点部署。

## 开奖前

完成每日北京时间 20:00 的采集、筛选、标准化、去重和历史评分检查。资料数量至少 25（榜单 15 / 其他 10），且应与上一期合格完整报告相当；25 不是采样上限。先完成统计，再冻结。未完成采集、未确认开奖前或数量不足时，只发送状态说明，不创建交接文件。

将同一份已经发送给用户的冻结数据以原始字节保存为：

- `forum-observations/requests/<issue>/freeze.json`：账本 freeze 契约；authorScores 无真实可用评分时为 `[]`。
- `forum-observations/requests/<issue>/report.md`：完整报告、来源证据、作者表现与选择理由。
- `forum-observations/requests/<issue>/freeze.meta.json`：交接校验信息，不发送到账本。

meta 字段：`issue`、`sha256`（freeze.json 原始字节的 SHA256）、`qualified: true`、`minimumSourceCount`（至少25，并按上一期合格样本量确定）、`reportPath`（上述报告路径），以及下列必须真实完成的布尔值：`top20Checked`、`otherAuthorsChecked`、`allPlayTypesNormalized`、`deduplicated`、`authorHistoryChecked`、`preDrawVerified`。

这些标记是采集方的真实完成声明，脚本不能替代论坛采集和证据核查。不得为了通过校验伪造完成标记。280期已有10份的不完整记录保留原样，不得添加 qualified manifest 或提交。

三个文件在同一个提交中新增到 main；路径变更触发 `Sync isolated forum observations`。提交不会触发现有正式预测工作流。只有新增文件会被处理，修改/删除现有请求被拒绝。Git 不禁止管理员修改历史，因此还须遵守冻结纪律；账本仍由服务端唯一键和冻结保护强制不可覆盖。

首次 freeze HTTP201才记成功。409表示已有冻结，立即停住，不能重算、覆盖或声称内容一致。401/403为权限问题，不能绕过。网络、429和5xx最多重试3次，原 JSON 字节不变。失败保留请求与结果 artifact，先发送 ChatGPT 报告并说明未同步，之后仅重试原文件。

## 开奖后

新增 `forum-observations/requests/<issue>/settle.json`，只包含真实 `{ "issue": <issue>, "actualZodiac": "实际生肖" }`。不得加入排名或作者快照。服务器从原冻结记录计算命中和实际排名；没有 freeze 会拒绝。作者动态历史档案由原采集任务另行更新，不能回填冻结 authorScores。

## 重试与结果确认

在 GitHub Actions 的上述独立工作流选择 Run workflow，branch **main**，填写已有 issue 和 freeze/settle。不要运行 `Run V6 Stable Prediction` 来同步论坛数据。

成功/失败见作业摘要及 `forum-sync-<run_id>-<attempt>` artifact 内的 JSON 收据（期号、操作、原文件 hash、HTTP状态、时间或失败原因）。必须核对 Actions 结果及账本观察页后主动向用户报告；不能只凭代码已提交声称数据已同步。

站点访问层如要求额外令牌，可复用仓库现有 `SITES_SIWC_BYPASS_TOKEN` secret；这只通过访问层，不替代 OIDC。缺少该权限导致401/403时安全停止，由账户管理员配置已有访问授权。不要提交令牌到仓库。

每次工作流先做真实认证检查：使用合法 OIDC 向 freeze 发送 `{}`，必须得到认证之后的 issue 校验 HTTP400，才继续同步。空请求不包含任何预测，不会插入观察记录；401/403或其他响应会阻断同步并如实报告。

本工作流只交接已完成的报告，不负责论坛采集，也不另设定时任务：每日20:00采集仍由现有任务执行。未来任务必须确实新增上述文件到 main 才会触发自动同步；只保存 ChatGPT 附件不会自动上传。

## 本地验证

`node --test tests/forum-observations/*.test.mjs` 使用模拟身份和模拟 HTTP，不生成预测，不写真实账本。真实同步只能由上述授权 Actions 完成。
