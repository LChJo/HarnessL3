# 项目初始化与登记（按需读取）

仅在用户要求接入项目、缺少 `.harness/project.json`，或已有配置尚未登记时读取。已接入项目的日常任务直接使用主 skill 的运行流程，不重复初始化。

## 首次接入已有 Git worktree

确认 CLI 已安装，用户已经授权接入当前项目。使用终端的工作目录参数进入目标已有 worktree，核对：

```text
git rev-parse --show-toplevel
git branch --show-current
harnessl3 worktree list --json
```

在这个目标目录内执行：

```text
harnessl3 init --name "项目名称" --json
harnessl3 model validate --json
harnessl3 worktree list --json
```

`init` 只创建缺失的 `.harness/project.json`、`.harness/model/*.c4`、证据/别名文件，以及首次默认技能库并登记已有 worktree；不会执行 `git init`、创建/切换分支或替换已有模型和用户技能。检查返回的 project/worktree UUID 与实际路径，保存目标 ID。初始化模板只是项目边界，后续需要按真实来源补充对象、关系、简述和证据。

## 已有配置或另一个已有 worktree

已有 `.harness/project.json` 且只需登记时，使用实际绝对路径：

```text
harnessl3 worktree register <已有worktree绝对路径> --json
harnessl3 model validate --json
```

`model validate` 在刚登记的目标目录执行，或显式传其返回的 `--worktree <UUID>`；不能仍处于另一个已登记 worktree 后强行指定不同目标。另一个已有 worktree 缺少项目上下文时，在该目录执行 `init`，由 CLI 核对 Git common-dir 和项目身份。不要复制其它仓库的 projectId，也不要替换已有配置来绕过冲突。

机器数据根使用原配置：`--data-dir`、`HARNESSL3_HOME` 或系统默认位置，且必须与所有登记 worktree 的目录树互不包含。不要为了绕过报错换一个临时数据根冒充项目已恢复。

## 验证后开始工作

确认命令返回 `ok:true`、模型校验结果有效且目标正确后，回到主 skill：

```text
harnessl3 task start --title "本次实际任务目的" --json
```

只有用户需要界面时才运行 `harnessl3 web open`。初始化或校验失败时报告实际状态，不通过删除 `.harness`、用户技能或历史重试；无效模型修正前不声明已接入可用。
