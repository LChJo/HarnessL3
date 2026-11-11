# v1 可校验契约

v0.46：新增selection-input/query-input描述CLI接受的任务自有缺省字段；原selection/query继续校验规范化请求。snapshot绑定显式mode、来源unknown且sourceScanRevision=null；旧无mode仍要求扫描策略哈希。file-read允许省略expectedHash并从原方案解析，显式值仍检查；selection.stage表示追加阶段，旧归档不重写。

状态：正式实现共用的协议工件。所有 schema 使用 JSON Schema Draft 2020-12；`$id` 的 `https://harnessl3.local/` 只是稳定逻辑标识，不是在线服务。核心以Ajv2020执行完整契约校验；请求/响应遵守[CLI 文档](../cli-contract.md)与[模型文档](../model-context.md)，功能及平台结果见[实施状态](../../implementation/STATUS.md)。

| Schema | 验证对象 |
| --- | --- |
| [model-maintenance](model-maintenance.schema.json) | model maintain的版本化agent指引、拓扑/视图覆盖提示和最近来源观测；非执行回执或语义完成证明 |
| [workspace](workspace.schema.json) / [source-policy](source-policy.schema.json) | 工作区git/directory类型、可空Git字段及扫描适配器策略；缺kind兼容旧Git登记 |
| [common](common.schema.json) | UUID、SHA-256、UTC 时间、路径、目标、来源版本、binding、简述、精确正文和批次共享字段 |
| [project-config](project-config.schema.json) / [aliases](aliases.schema.json) / [evidence](evidence.schema.json) | 随 Git 的最小配置、显式旧定位映射及依据 |
| [selection](selection.schema.json) | 一次上下文/技能联合选择，空集合合法 |
| [query](query.schema.json) | 混合 expand/read/known，至少一个目标 |
| [file-read](file-read.schema.json) | 按方案指纹读取多份归档文件 |
| [sync-proof](sync-proof.schema.json) | 阶段核验声明与 CAS 前置条件，非自动语义证明 |
| [response](response.schema.json) | 互斥成功/错误封套，入口、选择、批读、交接、归档文件、管理结果及 legacy 档案 |

`examples/` 共 16 份虚构项目 JSON，展示完整字段与响应。文件读取例含 SKILL.md 与一个附件，UTF-8 正文、字节数和 SHA-256 匹配；选择/交接/known/批次/目标互相对应；源文件、模型、任务均为文档 fixture，不是本机项目观测。校验脚本以虚构 `src/cancel.ts` 的 `export function cancel() {}\n`、project-config 的排除/技能路径和明确的空 Git ignore 输入复算 source-manifest/source-scan-policy；复算实际示例的目录/正文/技能文件指纹。modelRevision 仅作虚构模型 manifest 的格式与版本绑定示例，不是当前仓库核验结论。

请求 schema 验证 CLI 归一化之后的对象：requestId 必需。raw `--file` 可省略此字段，由 `--request-id` 或 CLI 生成值补齐后验证；flag 和文件同时提供必须相等。响应始终含 requestId 和 replayed（首返 false、幂等回放 true），以便关联丢失响应；未知自动 ID 不构成可恢复重试保证。

在仓库现有 Node 环境运行，无需修改 package 或安装依赖：

```text
node docs/spec/contracts/validate.mjs
```

脚本解析全部 schema、解析本地 `$ref`、对每个示例执行所用关键字检查，并验证反例必须失败及部分跨字段/文件内容指纹。它仅实现**这些 schema 已使用的关键字子集**，新增未知关键字会失败；不宣称是通用 Draft 2020-12 校验器。正式核心另使用兼容该草案的Ajv2020及格式断言；本脚本仍用于独立检查文档正反例。

可另用兼容 Draft 2020-12 的工具复核。例如临时 npm 工具缓存中的 Ajv（不改项目依赖）：

```text
npm exec --yes --package=ajv-cli --package=ajv-formats -- ajv validate --spec=draft2020 --strict=false -c ajv-formats -r "docs/spec/contracts/common.schema.json" -r "docs/spec/contracts/evidence.schema.json" -s "docs/spec/contracts/response.schema.json" -d "docs/spec/contracts/examples/*response.json"
```

该命令只覆盖响应示例；其他请求/配置须按上表分别指定 schema。格式断言需启用 date-time/uri（Ajv 为 ajv-formats），不能只把 format 当注释。

JSON Schema 不表达 task 真实归属、版本当前性、ID 唯一的跨文件关系、同 skillId 不同 reason 的重复选择、range 的两端大小、路径真实解析后的符号链接边界、返回内容 hash/bytes、实际日志来源、CAS 和“语义已核验”。这些由核心服务做独立语义校验，必须加入[验收](../acceptance.md)。`response.commandResult.result` 为管理命令扩展对象，必需字段按 CLI 字段表验证；legacy record 保留旧格式，不能按新实体 schema 补造。

反例至少覆盖：必需字段遗漏、schemaVersion/枚举错误、引用的深层字段类型、非法 UUID/hash、请求空目标、重复目标、未知字段、目录穿越/绝对路径/反斜杠/NUL、空 checks、非法 sourceVersion、无依据 verified、推断伪装已验证、封套成功错误并存以及旧档案伪补扫描版本。通过本脚本只证明文档样本与约束一致，不替代正式 CLI 或产品 A01–A10 验收。
