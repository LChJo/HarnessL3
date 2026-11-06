# 给 agent 的 HarnessL3 CLI 安装与更新指南

当用户要求安装或更新 L3 CLI 时，按本文执行。npm 包名和实际命令均为 **`harnessl3`**，不是 `l3cli`。安装后同时复制 [harnessl3 运行时 skill](agent-skills/harnessl3/SKILL.md) 及其 `references/` 附件到 Codex 和 Claude Code 的全局技能目录，让真实运行中的 agent 能正确调用 CLI。skill 主入口用于日常工作，附带的安装更新和项目初始化指导仅在需要时读取。完整调用说明见 [CLI 使用说明](docs/USAGE.md)。

安装后的工作约定为全任务入口：所有任务先经L3组织上下文并筛选技能，1%可能相关亦触发；简单问答或只读不绕过。连续任务可复用有效绑定，无需材料时显式空选。已有父L3交接的subagent继承其范围和选择，独立子任务自行建档；引导恢复不递归，无有效目标或CLI能力时明确阻塞。这由宿主主动遵守skill，文件复制成功不证明已在所有真实任务中触发。

## 安装来源与前提

- GitHub 仓库：<https://github.com/LChJo/HarnessL3>。
- 截至 2026-11-06，正式 CLI 为 **0.1.0 源码候选**，尚未发布到 npm；正式实现已合并并推送至 **`main`**，原临时审阅分支已经删除。首次安装和更新均从 GitHub `main` 取得源码，并记录实际提交；主干不等于已发布的稳定版本。
- Windows、macOS、Linux 均需 **Node.js >=24.12.0 且 <25**、随附 npm、Git，以及 GitHub/npm registry 网络访问。先运行 `node --version`、`npm --version`、`git --version`；缺少依赖时先安装，不忽略引擎约束。
- npm 全局 prefix 必须可写，并将其命令目录加入 PATH；不要自动使用管理员权限。私有仓库需要使用机器已有的 GitHub 认证，不能将凭证写入命令或日志。

以下是一次整段执行的安装流程；**首次安装和更新使用同一段命令**。每次新建独立临时目录，从指定 GitHub 分支取得最新源码，按锁文件安装构建依赖，构建 CLI/Web，打包后全局安装，再从已安装包复制运行时 skill。它不切换用户项目分支，也不在用户项目内安装依赖。

## Windows：PowerShell

将以下代码作为一个脚本块执行。使用 `npm.cmd` 避免依赖 PowerShell 的 npm.ps1 执行策略。

```powershell
& {
    $ErrorActionPreference = 'Stop'
    function Invoke-L3Step([string]$Executable, [string[]]$Arguments) {
        & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$Executable failed: $LASTEXITCODE" }
    }
    Invoke-L3Step node @('-e', 'const [a,b]=process.versions.node.split(/\./).map(Number); process.exit(a===24 && b>=12 ? 0 : 1)')
    $ref = 'main'
    $stage = Join-Path ([IO.Path]::GetTempPath()) ('harnessl3-install-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $stage | Out-Null
    Write-Host "Install workspace: $stage"
    Invoke-L3Step git @('clone', '--depth', '1', '--single-branch', '--branch', $ref, 'https://github.com/LChJo/HarnessL3.git', (Join-Path $stage 'source'))
    Push-Location (Join-Path $stage 'source')
    try {
        Write-Host "GitHub ref: $ref; source commit:"
        Invoke-L3Step git @('rev-parse', 'HEAD')
        Invoke-L3Step npm.cmd @('ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund')
        Invoke-L3Step npm.cmd @('run', 'build')
        Invoke-L3Step npm.cmd @('pack', '--ignore-scripts', '--pack-destination', $stage)
        $packages = @(Get-ChildItem -LiteralPath $stage -Filter 'harnessl3-*.tgz' -File)
        if ($packages.Count -ne 1) { throw 'Expected exactly one HarnessL3 package' }
        $prefix = (& npm.cmd prefix -g).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve npm global prefix' }
        $binary = Join-Path $prefix 'harnessl3.cmd'
        if (Test-Path -LiteralPath $binary) {
            Invoke-L3Step $binary @('serve', 'stop', '--json')
        }
        Invoke-L3Step npm.cmd @('install', '-g', $packages[0].FullName, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund')
        Invoke-L3Step $binary @('--version')
        Invoke-L3Step $binary @('--help')
        $modules = (& npm.cmd root -g).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve installed package root' }
        Invoke-L3Step node @((Join-Path $modules 'harnessl3/scripts/install-agent-skills.mjs'))
        Write-Host "Installed command: $binary"
    } finally {
        Pop-Location
    }
}
```

## macOS / Linux：Bash

在 Bash 中执行以下整个脚本块；括号将目录和变量变更限制在子 shell。

```bash
(
    set -euo pipefail
    node -e 'const [a,b]=process.versions.node.split(/\./).map(Number); process.exit(a===24 && b>=12 ? 0 : 1)'
    ref='main'
    stage=$(mktemp -d "${TMPDIR:-/tmp}/harnessl3-install-XXXXXXXX")
    printf 'Install workspace: %s\n' "$stage"
    git clone --depth 1 --single-branch --branch "$ref" \
        https://github.com/LChJo/HarnessL3.git "$stage/source"
    cd "$stage/source"
    printf 'GitHub ref: %s; source commit:\n' "$ref"
    git rev-parse HEAD
    npm ci --include=dev --ignore-scripts --no-audit --no-fund
    npm run build
    npm pack --ignore-scripts --pack-destination "$stage"
    packages=("$stage"/harnessl3-*.tgz)
    test "${#packages[@]}" -eq 1
    test -f "${packages[0]}"
    prefix=$(npm prefix -g)
    binary="$prefix/bin/harnessl3"
    if test -x "$binary"; then
        "$binary" serve stop --json
    fi
    npm install -g "${packages[0]}" --omit=dev --ignore-scripts --no-audit --no-fund
    "$binary" --version
    "$binary" --help
    package_root="$(npm root -g)/harnessl3"
    node "$package_root/scripts/install-agent-skills.mjs"
    printf 'Installed command: %s\n' "$binary"
)
```

构建显式执行后使用 `npm pack --ignore-scripts`，避免重复构建；安装的是 `.tgz`，不是临时源码目录的链接。流程依据 npm 官方的 [pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/) 与 [install](https://docs.npmjs.com/cli/v11/commands/npm-install/) 契约。临时源码和包保留供核对，安装后的命令不依赖它们。

## 运行时 skill 的复制与调用

安装脚本最后显式运行包内的 `scripts/install-agent-skills.mjs`，复制单独分发的整个 `agent-skills/harnessl3/`（含 `SKILL.md` 和 `references/`），不使用 npm postinstall。默认目标为：

| 宿主 | 全局 skill 文件 |
| --- | --- |
| Codex | `~/.agents/skills/harnessl3/SKILL.md` |
| Claude Code | `~/.claude/skills/harnessl3/SKILL.md`；设置 `CLAUDE_CONFIG_DIR` 时使用该目录下的 `skills/harnessl3/SKILL.md` |

Codex 使用当前官方的[用户级技能目录](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)，Claude Code 使用其[个人技能目录](https://code.claude.com/docs/en/skills#choose-where-skills-load)。Windows 的 `~` 对应当前用户主目录。尚未安装宿主也会创建目标目录；不会自动安装或启动宿主。

Codex 统一使用 `~/.agents/skills`。仅在用户明确指定其它自定义技能根时，给最后的复制命令加上 `--codex-skills-dir <全局skills绝对路径>`；Claude Code 可用 `--claude-skills-dir <全局skills绝对路径>` 覆盖。可单独重跑这一步，例如：

```text
node <已安装harnessl3包绝对路径>/scripts/install-agent-skills.mjs --codex-skills-dir <Codex全局skills绝对路径> --claude-skills-dir <Claude全局skills绝对路径>
```

复制程序输出 JSON：`ok:true` 时，两条 `results` 分别给出主入口路径、目录级 `installed` / `unchanged` / `updated`，以及 `files` 中的每文件结果；每次成功后都会核对主入口和全部附件字节。更新已有文件前，将原字节按相对路径备份到 skills 根的同级 `.harnessl3-skill-backups/<UUID>/`，对应文件结果给出 `backup` 路径；其它 skill 和未被本包覆盖的用户附件保留。备份不放进技能扫描目录，避免出现重复 skill。写入前核查整个待复制文件清单；目标 skill 或附件路径是 symlink/junction 时，程序报错保留原件，先核对该路径的用途，不跟随链接替换。

退出码非0或 `ok:false` 时不要报告“两宿主接入完成”；`results` 只包含已经完成的宿主复制，`current.files` 列出失败宿主中已核对完成的文件，可按错误修正目录后重跑。CLI 可能已安装成功，skill 复制仍可能失败，需分别报告。

新建或刷新宿主会话后，Codex 可用 `$harnessl3`，Claude Code 可用 `/harnessl3`，也可按描述自动发现。示例请求：“用 harnessl3 取得当前项目上下文，完成这个修复，并核验源码与模型同步。”需在真实宿主中确认能发现 skill；文件复制成功不等于宿主已加载或已经调用 CLI。

该 skill 聚焦全任务触发、子任务分支、返回含义及如何使用结果，保留少量启动示例；具体参数通过当前CLI的分层`--help`及其给出的Schema/示例路径发现。四份额外指导放在 `references/install-update.md`、`references/project-init.md`、`references/runtime.md` 与 `references/subagent.md`，仅需要时读取，不预读附件或将其正文拼入默认提示。安装更新附件指向本文的权威脚本，初始化附件提供实际接入命令，运行参考提供复杂请求/同步/恢复判断，子任务参考提供父交接核对与独立建档约定。它不启动subagent、自动绑定日志或执行所选方法，与 Skill Hub 的7类21项可编辑方法、机器数据根中的用户技能库分别存放；不会把全部 Hub 方法复制进 Codex/Claude Code。

## 更新、验证与故障处理

1. 更新前确认原安装所用的 Node/npm prefix 和数据根。若显式使用多个 `--data-dir`，先分别执行旧 CLI 的 `serve stop --data-dir <绝对路径> --json`；脚本只停止默认或 `HARNESSL3_HOME` 指向的数据根中的服务。
2. 重新执行本平台脚本，安装指定分支的最新提交。更新期间暂缓其它 agent 对同一安装的调用；后续 CLI 调用按需启动新服务。不要用 `npm update -g harnessl3` 或 `npm install -g harnessl3@latest`，当前没有已发布的 npm 版本。
3. 在原工作目录执行 `harnessl3 --version` 和 `harnessl3 --help`，确认 PATH 命令与脚本输出一致。Windows 用 `Get-Command harnessl3 -All`，macOS/Linux 用 `type -a harnessl3` 排查多个安装。找不到命令时，将 Windows 的 `npm prefix -g` 或 macOS/Linux 的 `$(npm prefix -g)/bin` 加入 PATH，或使用脚本输出的绝对命令路径。
4. 检查运行时 skill 复制结果，必要时在新宿主会话中验证发现。保存安装来源分支、`git rev-parse HEAD` 的完整提交、Node 版本、CLI 版本、两份 skill 路径/更新备份和验证结果。同为 `0.1.0` 也可能对应不同提交，不能只凭版本号判定已更新。

任一步失败即停止，保留报错和临时目录，不报告安装成功。分支不存在或仓库不可访问时，先核查来源/已有认证，不自动回退到 `main`。构建失败发生在替换安装之前；安装失败后需重新检查现有命令是否可用。需要回退到已记录提交时，在新的临时克隆中取得该完整提交、以 detached HEAD 检出，再从 `npm ci` 开始构建打包安装，不在用户项目中切换版本。

更新程序保留原机器数据根（`HARNESSL3_HOME` 或系统默认位置）、项目 `.harness`、任务/快照/历史和用户技能。不要删除数据根、执行 GC/迁移或重置技能库来完成更新。默认 `skills` 可能是 symlink/junction，同级 `.skills-library-<UUID>` 是活动用户内容，也必须保留；更新包不会覆盖已有技能库。存储边界见[存储规格](docs/spec/storage.md)。

本文核查依据为项目基准 **0.22**、D05/D06/D13/D14/D15、FR12/15，关联TC26安装范围及TC27宿主入口增量；文件复制/API切片不等于真实宿主触发验收。未来改用正式分支、tag 或 Release 资产时，先核实实际发布内容，再更新本文的安装来源，不将审阅分支称为稳定发行版。

## 安装后进入用户项目

安装成功不等于已经初始化项目。只有用户要求接入某个项目时，才在该**已有 Git worktree** 中执行：

```text
harnessl3 init --name "项目名称" --json
harnessl3 model validate --json
```

`init` 会创建缺失的项目上下文文件并登记当前 worktree，不创建或切换 Git 分支。接着按 [CLI 使用说明](docs/USAGE.md)执行任务选择和读取；只有需要浏览器界面时才执行 `harnessl3 web open`。
