# HarnessL3 安装与更新（按需读取）

仅在 CLI 缺失、版本不兼容或用户要求安装/更新时读取本文件。日常 `task` / `context` / `sync` 调用无需读取。

## 确认当前状态

```text
node --version
npm --version
git --version
harnessl3 --version
```

需要 Node.js >=24.12.0 且 <25、npm 和 Git。CLI 未安装时，最后一条命令会提示找不到命令。

## 取得并执行安装流程

完整的一次执行脚本以仓库根目录 `INSTALL.md` 为唯一维护入口，避免在附件中复制另一套安装命令。

- 已有 npm 全局安装时，用 `npm root -g` 找到其下 `harnessl3/INSTALL.md`，仅在安装流程仍与目标 GitHub 来源一致时使用。更新以目标来源的最新指南为准。
- 没有 CLI 或本地文档过旧时，使用现有网页/文件下载工具取得 [GitHub 安装指南](https://github.com/LChJo/HarnessL3/blob/main/INSTALL.md) 并读取正文。需要原文时使用 [Raw Markdown](https://raw.githubusercontent.com/LChJo/HarnessL3/main/INSTALL.md)，下载到用户项目外的临时目录。
- 根据实际平台执行指南中的 PowerShell 或 Bash 整段脚本。首次安装与更新共用流程：独立临时克隆 → `npm ci` → 构建 → 打包 `.tgz` → 全局安装 → 复制整个运行时 skill 目录及参考附件。

安装和更新均执行最新 GitHub 指南中的脚本。用户仅要求完成开发任务且尚未授权安装时，说明入口缺失，不据此自动更改本机环境。

已有 `.tgz` 且用户要求安装该包时可执行：

```text
npm install -g <harnessl3包绝对路径.tgz> --omit=dev --ignore-scripts --no-audit --no-fund
node <已安装harnessl3包绝对路径>/scripts/install-agent-skills.mjs
```

安装包路径由实际 npm prefix/root 确认，不能把占位符原样执行。Codex 使用 `~/.agents/skills/harnessl3`，Claude Code 使用 `~/.claude/skills/harnessl3`（或 `CLAUDE_CONFIG_DIR/skills/harnessl3`）；安装复制结果和宿主实际加载分开验证。不要自动启动宿主。

## 更新与验证边界

更新前按实际数据根停止旧服务：`harnessl3 serve stop --json`；多个显式 `--data-dir` 分别停止。保留 npm prefix、机器数据根、项目 `.harness`、用户技能及 `.skills-library-<UUID>` 实体和全部历史。更新不需要 GC、迁移或重建项目。

更新由已有 L3 任务发起时，先在旧服务仍可访问时，取得 `task handoff <实际taskId> --json`，明确以 UTF-8 写入 worktree 外文件；不要把封套中的 requestId 或当前时间当成 taskId。该文件是更新后只读比较的依据，不能以新返回覆盖原件。

更新后核对 `harnessl3 --version` / `--help` 的版本/构建源提交和两个宿主的 skill 复制结果；安装指南中的验证工具检查实际运行文件、服务构建身份与 RPC。回到旧任务所属 worktree，用已安装的 `scripts/verify-install.mjs --handoff-before <实际UTF-8文件>` 对照原包；显式数据根继续传原 `--data-dir`。只有 `historyCheck:matched-before-update` 才表示此交接比较成功，未提供原包为 not-requested。初始化活锁期间等待同一所有者，不能将 BUSY 当作已停止或删除锁；未知业务结果不自动重发。CLI旧包在安装临时目录的 previous 中，skill备份路径在各变更文件的 backup 中。失败时保留错误和实际完成范围。更新 skill 后，请新建或刷新宿主会话。
