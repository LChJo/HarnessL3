# Installation and updates

Read only for a missing/incompatible CLI or a requested install/update. Ordinary task/context/sync calls do not require this reference.

## Establish what is missing

When not already known, check the relevant prerequisites:

```text
node --version
npm --version
harnessl3 --version
```

Requires Node.js >=24.12.0 and <25 and npm. Git is needed for source installation and managed Git projects; plain-directory runtime does not require it. A missing command is an installation issue, not an uninitialized project. If installation was not authorized, explain what is missing and offer to install; do not change the machine silently. While awaiting an answer, do independent work only. Reuse existing explicit authorization.

Check git --version only when source installation or a managed Git target actually requires it.

## Use the maintained installation guide

The repository-root INSTALL.md is the single maintained procedure; do not maintain a second installer here.

- For an existing global package, locate harnessl3/INSTALL.md with npm root -g. Use it only if its procedure still matches the intended GitHub source; updates use that source's current guide.
- If unavailable or outdated, retrieve and read the [GitHub guide](https://github.com/LChJo/HarnessL3/blob/main/INSTALL.md), or its [raw Markdown](https://raw.githubusercontent.com/LChJo/HarnessL3/main/INSTALL.md), with available web/file tools. Download outside the user's project.
- Run the guide's complete PowerShell or Bash procedure for the actual platform: isolated temporary clone, npm ci, build, package, global installation, and copying the entire runtime skill with references.

For an existing package explicitly chosen by the user:

```text
npm install -g <absolute-package.tgz> --omit=dev --ignore-scripts --no-audit --no-fund
node <actual-installed-package>/scripts/install-agent-skills.mjs
```

Resolve real paths through npm prefix/root; never execute placeholders. Default targets are ~/.agents/skills/harnessl3 for Codex and ~/.claude/skills/harnessl3 for Claude Code, or CLAUDE_CONFIG_DIR/skills/harnessl3. Copying files and the host actually loading them are separate observations. Do not launch the host.

## Preserve data and check the actual update

Before updating, capture any existing task handoff while the old service is reachable, using its actual taskId. Write the full response as UTF-8 outside the worktree; preserve it as the before-update original. An envelope requestId or timestamp is not a taskId.

Stop the old service for the actual data root with harnessl3 serve stop --json; handle explicit --data-dir roots separately. Preserve npm prefix, machine data, project .harness, all user skills, the active .skills-library-<UUID> entity and all history. Updates do not require GC, migration or project reinitialization. BUSY/startup-in-progress means wait for the same owner, not successful stop; do not remove a live lock or force unknown processes.

After installation, check version/help build source and skill-copy results. The guide's verification tool checks actual runtime files, service build identity and RPC. In the original task worktree, compare the saved handoff using the installed scripts/verify-install.mjs --handoff-before <actual-UTF-8-file>; keep the original --data-dir if any. Only historyCheck:matched-before-update confirms that comparison; missing input means not-requested. Do not replace the original with the new response or resend unknown business writes.

Retain failures and actual completed scope. The installer retains the previous package in its temporary previous directory and reports per-file skill backup paths. Refresh or start a new host session to load updated skill instructions, then resume the original operation without recursively starting a setup task.
