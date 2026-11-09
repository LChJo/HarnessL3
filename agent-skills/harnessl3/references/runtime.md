# Runtime reference

Read only when current CLI help is insufficient, or for complex requests, synchronization, retries/history or explicit read-only log binding. The installed CLI and its JSON Schemas define fields and commands.

## Continuation and skill routing

At every user turn, reassess the current action against the available skill descriptions. Project context and skill routing are separate: retain sufficient project bodies, but return the chosen skill bodies through task read for this turn even if an earlier turn read them. The agent chooses skills; the CLI records selection and returns bytes, without routing or executing a model itself.

| Current turn | Operations |
| --- | --- |
| Same goal/target, suitable captured versions, matching selected skill set | task read the required selected SKILL.md files with their archived paths/hashes; read attachments only when needed |
| Changed skill set (including a change to empty), new goal, or required current versions unavailable in the old binding | task start, then one task select for this stage's skills and missing project context, then task read chosen bodies |
| No applicable skill and a reusable recorded empty selection | Keep the empty selection; no skill-file request is needed |
| Lost bodies or file references | Recover once with task handoff using the actual taskId; then perform this turn's skill reads |
| Missing project context | context query only the missing targets under a suitable binding |

For example, a ticket-writing turn may select planning/to-tickets and the next implementation turn development/implement. Keep project context already available in the conversation. On the new task, select context as {"expand":[],"read":[],"known":{}} when no project material is missing. task start still returns briefs/catalog; the new packet is empty, not an inherited copy. Do not put another task's hashes in known or claim its bodies were returned by the new task. A second selection on the old task is rejected with SELECTION_EXISTS; preserve its original plan, group/IDs and archived bytes. Stage tasks use ordinary task IDs/titles; no parentTaskId or stage-specific CLI field exists.

Use a fresh requestId for each intentional turn's skill read; retain it for retries of that read. Same-request replay is not a new observed read. Reused context is likewise not a new read and skill reads do not renew context retention. An old/closed task can supply its captured skill bytes, but cannot supply today's edited skill under an old hash. Refresh the catalog through a new task when current skill descriptions/bytes are needed; task prompt can refresh only an unselected task.

Own edits still need stage synchronization, not automatic task creation. Plans, todos and replies do not close tasks; actual completion/cancellation of the recorded scope plus recorded sync state does. A skill switch alone does not close another unfinished task. Closed tasks remain read-only. Each new task follows the main skill's once-per-task card; repeated skill reads on an existing task do not repeat it.

Use the main skill's ordered routing for missing CLI or project setup. Do not initialize a current project just to restore historical handoff/skill bytes. Declined/cancelled onboarding stays ordinary execution for the same task; valid parent handoffs inherit scope and selection.

## Discover the current interface

Consult only the command/contracts needed for the next operation:

```text
harnessl3 task select --help
harnessl3 context query --help
harnessl3 task read --help
harnessl3 sync verify --help
```

Help provides required/optional arguments, return semantics, and actual Schema/example paths. Read required local references, not the whole contract tree. Do not invent fields or copy example IDs/hashes/bindings. For older help, npm root -g locates harnessl3/docs/USAGE.md and docs/spec/contracts; custom installs use their actual package root. Contracts must match the running version.

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

Use the project's authoritative locations for long-term specs, task documents, decisions and handoffs. Project task Markdown is distinct from machine task archives; a temporary directory name does not determine authority or Git ownership. A handoff should record actual task/worktree/version and relevant paths.

- Add: reuse a suitable entity; maintain descriptions, evidence and links without creating one entity per document.
- Modify: review meaning, related descriptions/relations/claims and versions before refreshing hashes/times.
- Move/rename: preserve identity, repair evidence paths/incoming links; aliases are for entity locator changes.
- Delete/replace: remove current stale references, preserve historical snapshots and bytes.

Use file tools for LikeC4 and evidence. Inspect model validate/sync status, resolve actual changed/missing/unreadable evidence, then use the current sync verify contract with real target, source epoch/version, model revision, scope, disposition and checks. No semantic change still needs actual review evidence; no pending change needs no fabricated proof.

Mechanical evidence anomalies cannot be cleared with a blanket passed claim. A healthy unrelated local scope can be saved while other work remains pending. New concurrent changes invalidate old declarations; recheck rather than resubmitting stale versions. Scoped proof is not whole-project semantic synchronization, and task close does not prove user-work success.

Version authoritative .harness model/config/evidence/aliases, related source/docs and actual project skill files together. Keep machine settings/credentials, logs, history/snapshots/archived skills, indexes/caches/layouts separate and preserved. Do not copy global libraries or external link entities. Ignored/untracked/uncheckable Git ownership is diagnostic, not permission to stage, change ignores or delete files. Review actual diff and existing commit authorization.

## Retries, history and observation

- Same requestId and semantic request can replay; different content must not reuse it. On cancellation/lost responses, inspect the committed receipt via actual task show/handoff before retrying a write.
- Correct cwd/target conflicts explicitly. New-version requests cannot use stale bindings; catalog-only changes before selection may use task prompt. Closed tasks cannot receive new batches.
- history show restores captured batches without today's missing content. Browsing, handoff and skill reads do not extend the 60-day context retention window. Damage/uncollected evidence stays unknown.
- For logs, consult agent bind --help only with authorized, known host/session/absolute log path. No latest-session guessing or recursive scans. File change is not a read; read is not understanding.
- The default user data root shares one persistent service across projects; explicit roots are independent. Service scope/lifetime/startedAt and Web login/session expiry are different. Five-minute one-use codes and twelve-hour browser sessions are not process lifetimes. Recover an authenticated link when needed; a bare service address is not a login.
- GC/migration are separate actions, not setup-error repair. Preserve user skills, active .skills-library-<UUID> entities and history. Never force unknown processes or run competing writers to escape an initialization lock.
