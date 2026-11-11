# 技能来源与升级核对

2026-11-11；HarnessL3候选0.1.1，默认7类26项方法。此文件记录内容来源与适配判断，目录与版本仍从真实文件派生，不是运行时注册表。

## 对照范围

用户确认以只读本地参考库 `E:/Ai/skills` 为源：上游版本 **1.3.2**，提交 [4ae2317ddb22b046e26455e4f9c9b3aaaf62212d](https://github.com/mattpocock/skills/commit/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d)。上一轮导入基点为 [2ab9580](https://github.com/LChJo/skills/commit/2ab958093e83e0ec752e6c1c5932da465bf23e0c)。核对两点间的提交、CHANGELOG、实际正文、附件及L3既有适配；没有联网核对“最新”，没有回写参考库。

最初给出的 `I:/aimana/mldesigner/skills` 实际包含另一组插件开发技能，未作为本次来源。当前分发普通方法25项来自稳定范围，quick为L3方法。保留[MIT许可](LICENSE)，pr另外保留[CREDITS](development/pr/CREDITS.md)。

## 当前方法与处理

| L3方法 | 上游路径（skills/下） | 本次判断与落点 |
| --- | --- | --- |
| architecture/codebase-design | engineering/codebase-design | 保留深模块词汇及本地附件；GLOSSARY命名、获授权的独立探索使用新上下文 |
| architecture/domain-modeling | engineering/domain-modeling | 术语讨论、GLOSSARY和ADR编辑均可适用；附件改为GLOSSARY-FORMAT，既有权威模型优先 |
| architecture/improve-codebase-architecture | engineering/improve-codebase-architecture | 保留已内联的架构词汇、HTML报告与访谈分支；探索隔离上下文，不恢复跨方法依赖 |
| development/quick | 无，本地方法 | 保留明确小改动和简单问答；需核查长期关联时退出quick |
| development/implement | engineering/implement | 传入工单先读取并说明标题；歧义才询问；保留本地TDD/双轴审查要点和提交授权边界 |
| development/implement-spec | engineering/implement-spec | 新增整份规格的依赖图/就绪frontier；顺序执行可用，独立worker及worktree仅按实际支持和授权 |
| development/prototype | engineering/prototype | 逻辑分支由终端原型改为可分享的单HTML，保留纯逻辑、场景按钮和可运行证据；不强制建分支或删除 |
| development/pr | engineering/pr | 新增面向审阅的摘要、实际证据与合并影响；项目模板优先，图示按用途选择，保留作者致谢 |
| development/wizard | engineering/wizard | 新增仅人能完成的操作向导；保留最新template.sh，修复Readline、env引号/链接、EOF、清屏及运行中编辑问题 |
| discovery/grilling | productivity/grilling | 访谈由逐问升级为独立问题frontier分轮；事实自行查找，按宿主询问工具限制组织并等待回答 |
| discovery/grill-with-docs | engineering/grill-with-docs | 保留访谈及领域建模的必要行为内联，复用已确认决策，不恢复grilling/domain-modeling硬依赖 |
| discovery/research | engineering/research | 保留原始来源和引用要求；获授权的读者用新上下文，保留本地研究位置和知识维护 |
| discovery/to-questionnaire | productivity/to-questionnaire | 新增已晋升但原清单漏列的方法；问接收方和所需信息，覆盖知识缺口，草拟不等于发送 |
| knowledge/handoff | productivity/handoff | 补齐OS临时目录解析和真实路径；长期交接仍服从项目留存位置，不强制会话控制 |
| knowledge/teach | productivity/teach | 测验正确答案位置变化；输出相对已约定学习工作区，格式附件相对方法目录，保留单课与课程分支 |
| knowledge/wait-what | productivity/wait-what | 新增上一条消息的重新解释；用户语言和既有词汇优先，GLOSSARY不是前提 |
| meta/writing-for-agents | productivity/writing-for-agents | 替换writing-great-skills；覆盖所有agent消费的文档，合并原术语参考，技能机制单独披露并按Hub改写 |
| meta/setup-matt-pocock-skills | engineering/setup-matt-pocock-skills | 保留可选约定梳理，不变成强制安装；纳入目标仓库、旧命名迁移和tracker修复，不自动建Git/remote |
| planning/to-spec | engineering/to-spec | 已有讨论直接综合，保留本地文档与外部发布边界；无新增必要语义，未机械搬回Skill工具调用 |
| planning/to-tickets | engineering/to-tickets | 现有来源事项拆为子事项；native阻塞边完整时省略重复正文，否则保留文本回退 |
| planning/triage | engineering/triage | 外部PR发现遵从配置，显式指定PR不因作者被过滤；先读body/comments/diff，拒绝缺陷前先解释 |
| planning/wayfinder | engineering/wayfinder | 决策票不套实现ready标签；先创建再用真实ID连线，按票据类型处理；研究不默认开PR |
| quality/code-review | engineering/code-review | 搜集所有适用标准，存在时包含CODING_STANDARDS/CONTRIBUTING；独立双轴按真实返回聚合，保留本地无委派分支 |
| quality/diagnosing-bugs | engineering/diagnosing-bugs | 强制变异先与原件比较，防止修改未生效却信任red；补脱敏和最新人工回路模板，不自动读未知日志 |
| quality/tdd | engineering/tdd | 每个候选测试接口说明能捕获与遗漏什么；保留已同意接口/完成标准，模块接口词汇内联，不恢复硬依赖 |
| quality/retro | engineering/retro | 新增会话环境复盘；所需写作原则内联，机械问题优先确定性检查；只读已知会话，建议不自动安装Hook/CI或改全局配置 |

文字标点整理及Skill工具措辞变化逐项核对；没有新增语义的部分保留L3现有表述，不用上游整份覆盖抹掉项目权威、留存、普通目录或授权适配。

## 依赖与分类

上游的engineering/productivity分类不替换L3的用途分类。保留方法继续使用当前ID；新增方法按上表放置。源码引用、附件路径和当前导航一并核对，旧任务group/ID及已归档字节不改。

| 上游依赖 | L3处理 |
| --- | --- |
| grill-with-docs、triage → grilling/domain-modeling | 访谈轮次和即时术语/决策维护要点内联；既有权威优先 |
| improve-codebase-architecture → codebase-design/grilling/domain-modeling | 保留现有架构词汇、候选判断、访谈及知识维护，不恢复跨文件夹链接 |
| tdd → codebase-design | 小量接口/模块/测试面词汇内联；接口尚未确定时识别该设计决策 |
| implement、implement-spec → tdd/code-review | 必要测试与标准/规格审查完成标准内联；其它方法只按实际需要另选 |
| retro → writing-for-agents | 写作准则内联到第一步，保留默认复盘时应用写作规范的目的 |
| wayfinder → research/prototype/grilling/domain-modeling | 按票据类型和Notes处理，独立能力来自实际目录；不自动读取或启动它们 |
| setup → tracker/domain模板 | 同方法真实附件保留；模板示例不证明登录、功能支持或写入授权 |

方法只链接自身附件。没有重新引入related清单、跨技能Markdown链接、宿主专用agents/openai.yaml、Skill工具或slash调用。用户自己的related候选仍兼容，但不会自动选择、归档或执行。

## ask-matt核对与内置路由

ask-matt仍不作为普通方法，避免与内置Skill Hub形成两个路由。核对其正文和新增PHASE-BOUNDARIES后，skill-hub/2吸收：

- 简述只作选取方向；解释技能、推荐具体步骤或建议跳步前，先读相关所选正文，合适且可辨认的已读版本可复用。对应上游[#1194](https://github.com/mattpocock/skills/pull/1194)，修复只信摘要就建议跳过步骤。
- 区分单票实现、整份规格、调查、解释与复盘目的；用实际目录描述选择，不抄另一份固定流程表。
- 阶段边界先考虑保留当前推理；跨目标/宿主/接收方才需要可携带交接。独立任务需实际委派能力及授权，给新上下文和最小明确交接。
- 保留L3同任务--stage与缺失才读取，不导入固定150k门槛、自动/clear或/compact、每票必清上下文、工作目录必访谈、强制setup或自动worktree。
- 新pr/retro/implement-spec等角色由真实描述披露，不把读到上游流程等同授权运行整条流程。

## 退役及未分发内容的原因

- writing-great-skills是[干净改名与重构](https://github.com/mattpocock/skills/commit/17f22a371b664caa1fc0dd53cc8f0d4ea0e9ef25)：覆盖范围扩大为所有agent文档，原GLOSSARY合并入正文，技能专用机制移至SKILL-MECHANICS。不留当前包装别名。
- resolving-merge-conflicts[不再需要独立方法](https://github.com/mattpocock/skills/commit/daa01d8aa68ad5c61b68970ec2018d0ce9567be6)，由agent处理实际冲突，不把它替换为另一条强制流程。
- personal/和deprecated的[删除原因](https://github.com/mattpocock/skills/commit/c66bdeeee002d81e3f8b21403c07f9a0d7bea6da)：已被吸收或不再使用；obsidian-vault硬编码作者私人路径且可被自动触发。L3本轮前未分发这些内容。
- chief-of-staff仍是beta，要求全部工作委派、跨任务wiki、周期复盘及主动环境改进，会扩大执行与留存边界；本次不默认引入。software-factory也是beta，是设计工厂的语言及调查附件，未获上游稳定晋升；本次只记录评估。
- 上游SCOPE/CONTRIBUTING、issue表单及triage-label/needs-info工作流用于“实际失败且符合其哲学”的上游贡献治理、请求分类和14天未回复关闭。它们不成为L3产品的工单策略、自动工作流或新的项目权威。CHANGELOG用于溯源，不复制为L3自己的历史。

## 升级边界

正常init/安装继续只在根不存在时播种，已有库即使为空也不覆盖。本次用户另行授权本机升级：先备份原包、实际junction实体和文件清单，逐文件比较后合并确认的内置内容。保留用户文件、入口实体、原UUID和任务历史；不把持久实体当缓存替换或删除。旧方法与旧附件在历史中仍按原引用读取，缺失不能用新版补造。
