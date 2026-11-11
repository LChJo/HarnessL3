# Runtime reference

Read only when current CLI help is insufficient, or for complex requests, synchronization, retries/history or explicit read-only log binding. The installed CLI and its JSON Schemas define fields and commands.

## Continuation and skill routing

At every user turn, reassess the current action against skill descriptions. Reuse suitable captured project and skill bodies that remain identifiable in context; this reuse is not a new CLI read. Obtain only missing material or required new versions. Descriptions filter candidates; an explanation, procedure recommendation or advice to skip a step requires the relevant selected body (or its suitable captured version). Distinguish single-ticket work, complete-spec work, research, explanations and retrospectives by actual purpose rather than a mandatory pipeline. Do not read the whole catalog for a judgement about one method. The agent chooses skills; the CLI records selection and returns bytes, without executing a model.

| Current turn | Operations |
| --- | --- |
| Same goal/target, suitable versions, matching selected skills | Reuse available bodies; task read only missing selected files, attachments only when needed |
| Changed skills/skill versions on the same suitable model snapshot | task select --stage with the intended skills and missing context; read newly required bodies |
| New goal or required new model/current verified source binding | task start, then select the intended skills and missing project context |
| No applicable skill and a reusable recorded empty selection | Keep the empty selection; no skill-file request is needed |
| Lost bodies or file references | Recover once with task handoff using the actual taskId; then perform this turn's skill reads |
| Missing project context | context query only the missing targets under a suitable binding |

For example, a ticket-writing turn may select planning/to-tickets and the implementation turn development/implement. Retain project bodies and append an explicit task select --stage; empty context means no new project material. Earlier batch packet/plan/catalog and skill bytes remain unchanged and readable with --batch. A second selection without --stage is rejected. A new model version still needs a new task; an old packet must not be presented as today's model or verified source. Do not reuse known across tasks.

Use a fresh requestId for each intentional read or stage; retain it for retries. Replay/reuse is not a new observed read, and skill reads do not renew context retention. Closed tasks supply only captured bytes. Use --stage to select edited skill versions on an open task; task prompt refreshes an unselected catalog. CLI --skill/--path resolve recorded references, including the requested historical --batch, and an explicit expectedHash remains checked.

Own edits still need stage synchronization, not automatic task creation. Plans, todos and replies do not close tasks; actual completion/cancellation of the recorded scope plus recorded sync state does. A skill switch alone does not close another unfinished task. Closed tasks remain read-only. Each new task follows the main skill's once-per-task card; repeated skill reads on an existing task do not repeat it.

Use the main skill's ordered routing for missing CLI or project setup. Do not initialize a current project just to restore historical handoff/skill bytes. Declined/cancelled onboarding stays ordinary execution for the same task; valid parent handoffs inherit scope and selection.

## Permission and host startup failures

Distinguish command startup from a CLI response. `Failed to create unified exec process`, sandbox provisioning failures and `helper_sandbox_lock_failed` originate before the requested shell/CLI starts. Do not parse them as CLI JSON, reinstall L3, or infer that a reference file itself is unreadable. Try an available permitted native file reader for references. If all command startup is blocked, report the host failure and continue independent work; repairing the host belongs to its own setup/support path.

For a started CLI, `IO_ERROR` with `details.reason:permission-denied` retains the OS code, and path/syscall when supplied by the OS. It does not establish whether the cause is the sandbox, filesystem ACL or another OS policy. Preserve stdout/stderr, exit code and requestId. Review the actual failed operation before retrying; an RPC failure may follow a commit, so inspect the original receipt if execution is uncertain.

When the current host exposes and permits command/path approval, use its real tool schema to request only the failed command and required access, then wait for the actual result. A normal onboarding question cannot grant execution permission. With `never`, managed denial or no approval capability, state that limitation and the blocked operation; do not promise an approval dialog, retry unchanged, or ask the user to disable the sandbox. A denial ends this recovery attempt, not independent user work.

Separate installation writes (npm prefix, host skill roots and sibling backups) from runtime access (package/reference reads, the original machine data root, project files, selected skill roots including real link targets, local loopback RPC and service startup when needed). Resolve only paths relevant to the failure. Keep data/history and UUIDs in place; changing `--data-dir` creates a different service/archive, not recovered access. Do not alter host configuration, ACLs, locks or service identity to bypass the restriction. A successful unrestricted run does not verify sandbox compatibility.

## Discover the current interface

Consult only the command/contracts needed for the next operation:

```text
harnessl3 task select --help
harnessl3 context query --help
harnessl3 task read --help
harnessl3 sync verify --help
```

Help provides required/optional arguments, return semantics, and actual Schema/example paths. Read required local references, not the whole contract tree. Do not invent fields or copy example IDs/hashes/bindings. For older help, npm root -g locates harnessl3/docs/USAGE.md and docs/spec/contracts; custom installs use their actual package root. Contracts must match the running version.

Use the exact Request schema, Referenced schema and Usage guide paths from help; do not infer filenames from command names or assume dist, source files or development tests are installed. Confirm actual local paths before reading them.

| Operation | Purpose |
| --- | --- |
| task select | One joint context/skill selection using the actual entry binding/catalog |
| context query | Batch missing direct-child briefs or exact bodies without reselecting skills |
| task read | Read selected archived bytes by their references/hashes, not today's skill files |
| sync verify | Declare the actual reviewed stage scope against current versions |

Save a requestId for reliable retries. Non-ASCII JSON belongs in an explicit UTF-8 file outside the scanned worktree; default PowerShell native pipelines may replace text before the CLI sees it. Use stdin only with guaranteed UTF-8 bytes. For example:

```powershell
[System.IO.File]::WriteAllText($requestFile, $requestJson, [System.Text.UTF8Encoding]::new($false))
harnessl3 task select <actual-taskId> --file $requestFile --json
```

Do not treat archived replacement characters/question marks as recoverable originals.

## Interpret actual returns

Keep stdout, stderr and the original CLI exit code separate. Parse the complete stdout envelope and check ok before accessing data. On failure preserve the complete error.code/details; do not index missing data. Do not mix diagnostics into JSON with 2>&1 or truncate errors with head. A successful parser or the last command of a Bash pipeline is not CLI success; save the CLI status even when pipefail is enabled. The usage guide path returned by CLI help contains a guarded result-reader example.

For SCHEMA_INVALID, follow details.diagnostics field pointers, constraints and applicable hints, then consult schemaFile/example for the installed contract. Use the packaged empty selection example instead of inventing cache claims. Known context must be exact bodies actually returned and retained in this task; skill/file/source hashes cannot replace context contentHash or this task's first read. Discover concrete fields through task select/context query help and Schema. ok:true can still be partial: keep successful items, handle only missing ones and preserve exit code 4.

task start/prompt returns routing material; select/query returns exact content. Use handoff to recover accumulated content only when needed. expand gives direct-child briefs; read gives exact bodies. Ancestors, endpoints and references do not imply their bodies were read. routingPrompt carries rules; taskId/binding/directory/catalog come from structured data, not parsing the prompt.

One joint selection records candidates, not execution. Read needed archived skill bodies, then use ordinary authorized tools. Do not automatically select related methods or claim understanding. Known-content declarations require bytes actually returned and retained in this task. New prompt wording never rewrites historical receipts.

After actual context and required skill bodies return, follow the main skill's once-per-task commentary card. Empty selections also qualify. Do not repeat for continuation or final replies, invent links, or infer task completion from the card.

## Document maintenance and stage synchronization

Model evolution belongs to the same authorized development stage. New/removed modules, entry points, dependencies, responsibility moves or major refactors require comparing current sources with model composition, relationships and view coverage. `model maintain --mode supplement|revise|rebuild` provides current-agent guidance and mechanical coverage hints; choose one mode and reuse suitable guidance. It does not edit files, request a source scan or clear pending changes. `sync status.modelMaintenance` only suggests review from observed pending state; it is not an architecture audit. Use file tools to evolve the model/evidence, preserve continuing IDs/history, validate actual views and then submit the existing scoped proof. No semantic change still requires real reviewed scope. Do not declare planned modules implemented or grow graphs merely to reach counts.

Use the project's authoritative locations for long-term specs, task documents, decisions and handoffs. Project task Markdown is distinct from machine task archives; a temporary directory name does not determine authority or Git ownership. A handoff should record actual task/worktree/version and relevant paths.

- Add: reuse a suitable entity; maintain descriptions, evidence and links without creating one entity per document.
- Modify: review meaning, related descriptions/relations/claims and versions before refreshing hashes/times.
- Move/rename: preserve identity, repair evidence paths/incoming links; aliases are for entity locator changes.
- Delete/replace: remove current stale references, preserve historical snapshots and bytes.

Use file tools for LikeC4 and evidence. Inspect model validate/sync status, resolve actual changed/missing/unreadable evidence, then use the current sync verify contract with real target, source epoch/version, model revision, scope, disposition and checks. No semantic change still needs actual review evidence; no pending change needs no fabricated proof.

Mechanical evidence anomalies cannot be cleared with a blanket passed claim. A healthy unrelated local scope can be saved while other work remains pending. New concurrent changes invalidate old declarations; recheck rather than resubmitting stale versions. Scoped proof is not whole-project semantic synchronization, and task close does not prove user-work success.

For SOURCE_NESTED_REPOSITORY or unsupported source entries, inspect the reported boundary and intended coverage. Do not silently exclude it, delete its .git, or rewrite ignore rules. An explicitly chosen project source exclusion changes coverage and never clears a referenced evidence failure. For SYNC_RACE, inspect error.details.conflicts and the original receipt; run sync status again, review the fresh scope and submit a new declaration with a new requestId. Equal source/model hashes do not override a changed epoch. Do not automatically copy only the new epoch into the old proof.

Keep authoritative .harness model/config/evidence/aliases, related source/docs and actual project skill files together: version them in Git projects; back them up with plain-directory projects. Keep machine settings/credentials, logs, history/snapshots/archived skills, indexes/caches/layouts separate and preserved. Do not copy global libraries or external link entities. Ignored/untracked/uncheckable Git ownership is diagnostic, not permission to stage, change ignores or delete files. Review actual diff and existing commit authorization.

## Retries, history and observation

- Save the request ID emitted on stderr. request status <request-id> inspects progress or the original durable receipt without dispatching the operation again. A timeout limits CLI waiting, not accepted server work; unknown after lookup/restart does not prove non-execution. Preserve the original ID and inspect before retrying. --timeout-ms sets a larger bounded wait only when appropriate; --quiet-progress suppresses stderr progress.
- Correct cwd/target conflicts explicitly. New-version requests cannot use stale bindings; catalog-only changes before selection may use task prompt. Closed tasks cannot receive new batches.
- history show restores captured batches without today's missing content. Browsing, handoff and skill reads do not extend the 60-day context retention window. Damage/uncollected evidence stays unknown.
- For logs, consult agent bind --help only with authorized, known host/session/absolute log path. No latest-session guessing or recursive scans. File change is not a read; read is not understanding.
- The default user data root shares one persistent service across projects; explicit roots are independent. Service scope/lifetime/startedAt and Web login/session expiry are different. Five-minute one-use codes and twelve-hour browser sessions are not process lifetimes. Recover an authenticated link when needed; a bare service address is not a login.
- GC/migration are separate actions, not setup-error repair. Preserve user skills, active .skills-library-<UUID> entities and history. Never force unknown processes or run competing writers to escape an initialization lock.
