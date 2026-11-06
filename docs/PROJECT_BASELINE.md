# HarnessL3 原型归档基准

- 冻结设计：v0.16；归档日期2026-11-06；分支 `archive/prototype-v0.16`，独立worktree。
- 原型来源：已公开提交bfa3dd7对应的src/server、原型scripts/tests、examples和skills。归档前202个受保护文件与实施前SHA-256一致。
- 当前正式基准在[正式首版分支](https://github.com/LChJo/HarnessL3/blob/codex/harnessl3-v1-20261106/docs/PROJECT_BASELINE.md)，此页仅记录冻结原型。

## 范围

Slate统一连线无限画布、五类上下文、folder→skill→file的Skill Hub、批量渐进披露、原型60天/批次历史、按需C4。文本仍为权威，技能是普通文件，选择不代表执行，未采集操作保持未知。

仍依赖明确配置的MGRP来源，使用本机JSON档案和有限Codex日志解析，不包含正式CLI、多项目登记、SQLite和双宿主正式适配。本次只适配根package/lock及归档说明，原型业务源码、模型和技能保持原字节。

原85份任务和2份快照继续保存在原工作区，不上传或移入本分支。测试仅创建归档worktree内的自有数据；机器路径和日志不随Git分发。设计资料见[原型入口](prototype/README.md)和[历史基准](prototype/archive/baseline-history-v0.16.md)。

## 此次验证

本次生产构建、45项程序、6项CLI/HTTP、16项脑图、8项历史和10项技能集成均通过；模型40对象/32关系/5视图，74证据/42来源文件匹配。113份源码/配置/模型/技能原始字节核对一致，详情见[归档记录](prototype/ARCHIVE.md)。既有报告继续保留历史语境，不以历史数量替代新实测。
