# CLI 与运行时 skill 职责核对

2026-11-06；worktree `codex/harnessl3-v1-20261106`。首次职责核对基于0.21，后续0.22增量见下文；D01–D14、业务命令与JSON封套保持，0.22另增D15全任务入口/子任务继承。

## 当前连续对话约定（v0.40）

项目上下文复用不跳过每轮技能判断/正文返回。主skill只保留顺序与分支，阶段切换细节放入现有runtime参考；同技能使用task read，技能集合或所需版本变化使用新task的一次select并空选已持有的项目内容。CLI不负责模型路由，新task不继承旧packet或跨任务known；旧任务内不能二次选技能。程序命令组合、安装复制和真实宿主遵循分别验证，详见[实施状态](STATUS.md)。

## 判断与依据

用户的判断方向正确：skill重点描述调用时机、流程判断、返回结果的含义和后续工作；参数、字段、默认值、Schema与错误约定应由当前安装版本的CLI及其契约提供。仍需保留少量启动示例，以及“目录不等于正文”“选择不等于执行”等领域规则。

这里采用的是格式规范和官方工程实践，不把它们称为一项统一强制的“agent CLI标准”：

- [Agent Skills规范](https://agentskills.io/specification#progressive-disclosure)区分元数据、激活后的主正文、按需资源，允许将详细技术参考拆出；这支持主文件保持精简，附件仅在需要时读取。
- [OpenAI的CLI配套skill建议](https://github.com/openai/skills/blob/main/skills/.curated/cli-creator/SKILL.md#companion-skill)强调使用顺序、启动/发现/读写路径和少量实例，接口参考可留在CLI文档或附件；其[CLI模式](https://github.com/openai/skills/blob/main/skills/.curated/cli-creator/references/agent-cli-patterns.md#help-is-interface)要求帮助足以让只拿到二进制的后续agent发现能力，并保持机器输出可处理。
- [Anthropic写作建议](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#concise-is-key)强调正文成本及按需参考。[GitHub CLI帮助](https://cli.github.com/manual/gh_help)是按命令路径取得详情的现成实例。

具体接口不必随每次业务结果重复发送。分层帮助负责发现参数；本地Schema/示例负责精确格式；业务响应负责当次真实ID、版本、内容、范围与错误。是否提供专门的机器Schema命令是工程选择，本项目继续使用已有文件工具读取CLI给出的契约路径。API型CLI示例中的认证、doctor或raw request也不自动成为L3的新增范围。

## 实际核对与处理

| 项目 | 修改前实际状态 | 本轮处理/结论 |
| --- | --- | --- |
| skill职责 | 主文件有请求形状、字段、参数、proof与错误细节，和包内契约重叠 | 主文件改为调用时机/返回含义/使用方式与3个启动示例，详细操作移至 `references/runtime.md` |
| 分层帮助 | `task select --help`、`sync verify --help`逐字等于766字符的顶层总览 | 现有 `--help` 支持总览、命令组和具体命令；未知主题返回参数错误 |
| 参数发现 | 部分具体命令的必需参数未出现在帮助中 | 用法、必需/可选参数直接复用解析器注册表；说明与实际参数名同处当前安装包 |
| 请求契约发现 | 包内已有9个Schema和15个示例，帮助没有入口 | 具体请求命令输出安装包内请求Schema/示例的绝对路径；根必需字段从实际Schema读取，不在skill另抄定义；嵌套字段按需读本地 `$ref` |
| 响应与错误 | JSON封套、错误码、退出码和partial已有实现；无效参数实跑返回code2/INVALID_ARGUMENT | 保留协议；帮助提供响应Schema、状态与退出码说明，skill保留如何使用结果的判断 |
| 动态材料 | `task start` 已返回任务/绑定/目录/catalog和筛选提示，提示也包含联合选择要求 | 继续以当前实际返回为准，移除主skill对这些字段的重复教学 |
| 附件安装 | 复制器已支持整个目录、备份和链接检查 | 新增runtime参考随包复制；Codex仍为 `~/.agents/skills`，Claude Code目录不变 |

首次精简时主文件按相同PowerShell方式测得不含换行字符数由3801降为1176，约减少69%；这是该轮记录，不是当前文件长度或token/模型效果测量。后续用户明确要求加入全任务触发和子任务入口约定，相关新增内容属于主skill职责。

首次核对发现`routingPrompt`重复了业务响应中已有的绑定、目录和catalog；v0.22增量已处理：提示只保留规则并指向结构化字段，不嵌入任务身份/目的/绑定/目录/catalog。非JSON展示也只打印一次规则；旧幂等回执原文保持，JSON字段不变。单一隔离夹具的提示2574→1043字节、完整JSON入口4363→2700字节，不外推为通用性能或模型效果。

## v0.22全任务入口与子任务

用户进一步确认所有任务安装后先通过L3组织上下文和筛选技能，参考本机harnesslite的1%门槛及子任务分支。主skill覆盖问答、讨论、研究、规划、实施、调试、审查、继续、记录、交接、复盘，不因轻量/只读跳过；同一有效任务可复用，无需材料空选。subagent有父交接则继承范围与选择，独立范围自行建档，不重选或关闭父任务。

该约定新增D15/FR15/TC27，已同步当前基准和AGENTS。真实触发仍依赖宿主主动遵守文件型skill，不能把复制、文本核对或既有API调用切片说成模型行为验收。CLI不新增父子字段、agent调度/权限隔离、Hook或自动worktree；无有效目标/能力真实报告，入口恢复避免递归。

## 验证与边界

修改前在独立数据根实测：两项子帮助与总览相同、没有契约发现入口；无效输入返回结构化错误，且没有创建数据根。先增加3项TC22帮助发现测试，实际全部失败后实现修补，再编译并转绿。测试核对命令组范围、具体用法、schema/example可读及字段来源、静态帮助不启动服务、JSON模式例外与未知主题错误。

其它实际回归与最新包证据见[实施状态](STATUS.md)。复制成功、静态测试和包消费者工作流不证明真实Codex/Claude Code已加载skill或按预期选择参考；本轮未启动宿主。新增行为的本轮范围为Windows，不复用旧三平台CI结果冒称此增量已三平台验证。
