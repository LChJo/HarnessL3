# HarnessL3 安装与更新

按本文从 GitHub 安装或更新 **`harnessl3`** 命令，并将 [运行时 skill](agent-skills/harnessl3/SKILL.md) 及其参考附件安装到 Codex 和 Claude Code 的全局技能目录。让 agent 阅读本页即可执行安装。日常调用见 [CLI 使用说明](docs/USAGE.md)。

运行时 skill 引导 agent 为任务选择上下文与技能，并在连续任务中复用选择。首次使用前，请新建或刷新宿主会话。

## 安装来源与前提

- GitHub 仓库：<https://github.com/LChJo/HarnessL3>。
- Windows、macOS、Linux 从源码安装均需 **Node.js >=24.12.0 且 <25**、随附 npm、Git，以及 GitHub/npm registry 网络访问。普通目录运行只需对应 Node.js；Git 项目运行仍需 Git。已有安装包可通过 npm 安装，无需为普通目录另建 Git 仓库。先运行 `node --version`、`npm --version`、`git --version`；缺少依赖时先安装，不忽略引擎约束。
- npm 全局 prefix 必须可写，并将其命令目录加入 PATH；不要自动使用管理员权限。私有仓库需要使用机器已有的 GitHub 认证，不能将凭证写入命令或日志。

**首次安装和更新使用同一段命令**。脚本在独立临时目录下载源码、安装依赖、构建并全局安装 CLI，再从安装包复制运行时 skill。

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
        $sourceCommit = (& git rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the downloaded source commit' }
        Invoke-L3Step npm.cmd @('ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund')
        Invoke-L3Step npm.cmd @('run', 'build')
        Invoke-L3Step npm.cmd @('pack', '--ignore-scripts', '--pack-destination', $stage)
        $packages = @(Get-ChildItem -LiteralPath $stage -Filter 'harnessl3-*.tgz' -File)
        if ($packages.Count -ne 1) { throw 'Expected exactly one HarnessL3 package' }
        $prefix = (& npm.cmd prefix -g).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve npm global prefix' }
        $modules = (& npm.cmd root -g).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve installed package root' }
        $installed = Join-Path $modules 'harnessl3'
        if (Test-Path -LiteralPath (Join-Path $installed 'package.json')) {
            $previous = Join-Path $stage 'previous'
            New-Item -ItemType Directory -Path $previous | Out-Null
            Invoke-L3Step npm.cmd @('pack', $installed, '--ignore-scripts', '--pack-destination', $previous)
            Write-Host "Previous package: $previous"
        }
        $binary = Join-Path $prefix 'harnessl3.cmd'
        if (Test-Path -LiteralPath $binary) {
            Invoke-L3Step $binary @('serve', 'stop', '--json')
        }
        Invoke-L3Step npm.cmd @('install', '-g', $packages[0].FullName, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund')
        Invoke-L3Step $binary @('--version')
        Invoke-L3Step $binary @('--help')
        Invoke-L3Step node @((Join-Path $modules 'harnessl3/scripts/install-agent-skills.mjs'))
        Invoke-L3Step node @((Join-Path $modules 'harnessl3/scripts/verify-install.mjs'), '--expected-commit', $sourceCommit, '--report', (Join-Path $stage 'verification.json'))
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
    source_commit=$(git rev-parse HEAD)
    npm ci --include=dev --ignore-scripts --no-audit --no-fund
    npm run build
    npm pack --ignore-scripts --pack-destination "$stage"
    packages=("$stage"/harnessl3-*.tgz)
    test "${#packages[@]}" -eq 1
    test -f "${packages[0]}"
    prefix=$(npm prefix -g)
    package_root="$(npm root -g)/harnessl3"
    if test -f "$package_root/package.json"; then
        mkdir "$stage/previous"
        npm pack "$package_root" --ignore-scripts --pack-destination "$stage/previous"
        printf 'Previous package: %s\n' "$stage/previous"
    fi
    binary="$prefix/bin/harnessl3"
    if test -x "$binary"; then
        "$binary" serve stop --json
    fi
    npm install -g "${packages[0]}" --omit=dev --ignore-scripts --no-audit --no-fund
    "$binary" --version
    "$binary" --help
    node "$package_root/scripts/install-agent-skills.mjs"
    node "$package_root/scripts/verify-install.mjs" --expected-commit "$source_commit" --report "$stage/verification.json"
    printf 'Installed command: %s\n' "$binary"
)
```

安装后的命令不依赖临时源码目录。`verification.json` 记录源提交、依赖锁指纹、实际运行文件指纹、服务构建身份和 RPC 检查结果；`--version` 保留包版本，`--help` 另显示构建源提交。只有验证成功才输出安装完成。需要保留验证凭据和回滚包时，请先将它们存放到项目源码以外的长期位置，再回收本次临时目录。

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

新建或刷新宿主会话后，Codex 可用 `$harnessl3`，Claude Code 可用 `/harnessl3`，也可按描述自动发现。示例请求：“用 harnessl3 取得当前项目上下文，完成这个修复，并核验源码与模型同步。”如果会话中找不到 skill，先检查上表中的文件是否存在，再刷新会话。

skill 的安装更新、项目接入、运行细节与子任务说明位于 `references/`，由 agent 按需读取。具体命令参数可通过 `harnessl3 --help` 逐层查看。运行时 skill 与 Skill Hub 中的普通技能分开存放。

## 更新、验证与故障处理

1. 更新前确认原安装所用的 Node/npm prefix 和数据根。若显式使用多个 `--data-dir`，先分别执行旧 CLI 的 `serve stop --data-dir <绝对路径> --json`；脚本只停止默认或 `HARNESSL3_HOME` 指向的数据根中的服务。
2. 重新执行本平台脚本，同时更新 CLI 与运行时 skill。更新期间暂缓其它 agent 对同一安装的调用；后续 CLI 调用按需启动新服务。
3. 在原工作目录执行 `harnessl3 --version` 和 `harnessl3 --help`，确认 PATH 命令与脚本输出一致，构建源提交符合下载记录。Windows 用 `Get-Command harnessl3 -All`，macOS/Linux 用 `type -a harnessl3` 排查多个安装。找不到命令时，将 Windows 的 `npm prefix -g` 或 macOS/Linux 的 `$(npm prefix -g)/bin` 加入 PATH，或使用脚本输出的绝对命令路径。
4. 检查运行时 skill 复制结果，确认两个宿主都返回成功，再新建或刷新宿主会话。

运行时验证会启动或复用当前数据根的服务，确认实际运行的是新构建并执行只读 RPC；默认总等待上限120秒，可通过验证工具的 `--timeout-ms <毫秒>` 调整，最长600秒。该等待上限是故障处理参数。初始化中的活锁显示 `unavailable` 和 `startup-in-progress`，应等待同一启动进程；不要删除锁或强杀未知进程。进度写入 stderr，最终只输出一个 JSON 结果。`checks` 仅列成功阶段；验证失败不意味着包替换或技能复制未发生。

服务运行状态与后台档案恢复进度分别记录。控制端点运行不表示每个工作区都已完成恢复；已知任务的历史交接以原包比较结果为准，失败或未检查范围保留在报告中。

更新前已有明确的 L3 任务时，在停止旧服务前将 `task handoff <实际taskId> --json` 的完整结果以 UTF-8 保存到项目外。更新后回到该任务所属的原工作目录，执行：

```text
node <已安装harnessl3包绝对路径>/scripts/verify-install.mjs --handoff-before <更新前handoff.json> --report <本机核验结果.json>
```

显式数据根加上 `--data-dir <原绝对路径>`。工具按该结果中的真实 task/worktree ID 只读恢复并比较上下文包、技能计划与版本绑定，不创建任务、不续期。成功返回 `historyCheck:"matched-before-update"`；未提供旧包时返回 `"not-requested"`，不能据此声称历史交接已核验。响应丢失或归档读取失败会保留错误，不自动重发业务请求。

任一步失败即停止，保留报错和临时目录。下载失败时检查网络和已有 GitHub 认证，构建失败时检查 Node.js 版本。安装失败后，重新检查现有 `harnessl3` 命令是否可用；修复问题后重跑脚本。需要回退时，先确认相应服务已停止，再用 `npm install -g <previous中实际旧包.tgz> --omit=dev --ignore-scripts --no-audit --no-fund` 恢复 CLI；从旧包重新复制运行时 skill，按该版本能力重新核验。回退包不回写或恢复历史数据，旧版本不支持当前格式时保留数据并报告版本错误。

更新程序保留原机器数据根（`HARNESSL3_HOME` 或系统默认位置）、项目 `.harness`、任务/快照/历史和用户技能。不要删除数据根、执行 GC/迁移或重置技能库来完成更新。默认 `skills` 可能是 symlink/junction，同级 `.skills-library-<UUID>` 是活动用户内容，也必须保留；更新包不会覆盖已有技能库。存储边界见[存储规格](docs/spec/storage.md)。

## 安装后进入用户项目

安装成功不等于已经初始化项目。只有用户要求接入某个项目时，才在该**已有普通目录或 Git worktree** 中执行：

```text
harnessl3 init --name "项目名称" --json
harnessl3 model validate --json
```

`init` 会创建缺失的项目上下文文件并登记当前 worktree，不创建或切换 Git 分支。接着按 [CLI 使用说明](docs/USAGE.md)执行任务选择和读取；只有需要浏览器界面时才执行 `harnessl3 web open`。
