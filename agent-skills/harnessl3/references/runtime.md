# Runtime reference

Read only when current CLI help is insufficient, or for complex requests, synchronization, retries/history or explicit read-only log binding. The installed CLI and its JSON Schemas define fields and commands.

## Planning before complex changes

Determine the user's current intent from the request, the actual target and the agreed scope and acceptance criteria. Deliver the requested research, discussion, spec or tickets when the user asks for those outputs. Read-only investigation and authorized planning artifacts can proceed while a decision is pending.

Treat a change as complex when it shifts responsibilities across components, changes a public contract, stored data, permissions, compatibility, migration or rollback, or leaves consequential choices, scope or acceptance unclear. Narrow the impact with read-only evidence first.

| Facts at this stage | Next action |
| --- | --- |
| A consequential decision still belongs to the user | Investigate facts, give a recommendation and tradeoff, ask independent questions within the host's limits and wait for actual answers before dependent changes. Use the native question tool when available and permitted. Otherwise make the question and waiting state visible in a review draft or reply. |
| The goal is clear and the complex work lacks a confirmed plan | Present a reviewable short plan with scope, key decisions, sequence and acceptance criteria. Use a durable spec where the project needs one and split tickets when independently verifiable slices or blocking edges matter. Wait for confirmation before modifying behavior, configuration, behavior tests, or external state. |
| The plan or ticket is already agreed | Read the actual artifact and proceed within its agreed scope. Reopen only material scope, acceptance or rollback changes. |
| The user expressly authorizes showing a plan and proceeding | Show the short plan before the first change. Resolve any material choice outside that authorization first. |
| A small change has clear scope, location and approach | Proceed with the project's required checks. Use a quick method only if its body fits the needed work. Reassess before expanding into a complex change. |

Actual answers, explicit delegation and a verifiable approval of the current scope can authorize continuation. Silence, defaults, an async tool acknowledgement and a plan written by the agent leave confirmation pending. When the final decision answer covers the visible plan's scope, decisions and acceptance, use it as confirmation. If it covers only one branch, update the plan and keep the rest pending. Follow the separate onboarding rules for project consent.

Choose applicable methods from this task's actual catalog using their descriptions and IDs. Honor an explicit method name when it exists, including grill-me/grillme for the separate grill-me method. Report a missing named method accurately; use another available path only within the request's scope. An empty selection is valid when the catalog has no suitable method. Keep the phase decision independent of the presence of a particular skill.

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

When supported, task select --compact returns the new result bodies and skill plan once, with a packetRef for the accumulated packet. Default output and full archived receipts are unchanged. Recover only if needed with task handoff <taskId> --batch <packetRef.throughBatchId> on the same target; digest('context-packet', packet) must match packetRef.contentHash. A compact flag changes display, not request identity or observed reads.

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

Keep stdout, stderr and the original CLI exit code separate. Parse the complete stdout envelope and check ok before accessing data. On failure preserve the complete error.code/details; do not index missing data. Do not mix diagnostics into JSON with 2>&1 or truncate errors with head. A successful parser or the last command of a Bash pipeline is not CLI success; save the CLI status even when pipefail is enabled. The usage guide path returned by CLI help contains a guarded result-reader example. In Windows PowerShell 5.1, piping a native command into Select-Object -First/-Last stops the pipeline early and breaks the stdout pipe of a process that is still writing: the process ends with -1 and the host reports exit 255 even when the command succeeded (reproduced with node; independent of 2>&1; complete consumption exits 0). The CLI exit-code contract has no 255, so treat it as a caller-pattern failure before an L3 fault. Capture stdout completely into a variable, save $LASTEXITCODE, and slice only after capture; never combine -First with a native command in one pipeline. Warning-level diagnostics such as EVIDENCE_CHANGED are not command failure: they mark evidence bytes behind the current file and clear only after evidence repair and a successful scoped verification.

For SCHEMA_INVALID, follow details.diagnostics field pointers, constraints and applicable hints, then consult schemaFile/example for the installed contract. Use the packaged empty selection example instead of inventing cache claims. Known context must be exact bodies actually returned and retained in this task; skill/file/source hashes cannot replace context contentHash or this task's first read. Discover concrete fields through task select/context query help and Schema. ok:true can still be partial: keep successful items, handle only missing ones and preserve exit code 4.

task start/prompt returns routing material; select/query returns exact content. Use handoff to recover accumulated content only when needed. expand gives direct-child briefs; read gives exact bodies. Ancestors, endpoints and references do not imply their bodies were read. routingPrompt carries rules; taskId/binding/directory/catalog come from structured data, not parsing the prompt.

One joint selection records the current stage's methods. Read complete version-matched bodies, then apply their actions, waiting conditions and deliverables within project rules and user authorization. Use selected methods for distinct needs of this stage and defer future-stage methods until the stage changes. Apply an interview through actual questions and answers, a planning method through its reviewable output, and an implementation method through its agreed scope and checks. Selection, delivery and observable behavior have separate evidence. Related entries remain optional; known context requires actual bodies retained in this task.

### Recover incomplete delivery

Keep the original envelope, exit status and stderr separately. Expose the complete routing prompt, relevant catalog entries, and all required method text to the current agent. Use structured field selection for metadata and `task select --compact` for duplicate packet content. If a tool display is truncated, read the missing text from the preserved response or the original request receipt. If the specific result is still missing, resolve the correct batch and read just the required archived file. Verify target, task, batch, method ID, path, byte count and hash. A saved response, hash, excerpt or missing tail on its own leaves delivery incomplete. A single oversized body can be read in ordered ranges from the intact response while the needed text remains available.

For partial responses, retain successful items and the individual errors; use the correct references to recover missing items only. After compaction or transfer, recover the exact task and batch with `task handoff` when the references were lost, then use `task read --batch` for the missing selected body. A change to the current library does not change that batch. Missing or corrupt archived bytes leave that content unavailable; preserve existing user decisions whose scope can still be verified. Explain the affected phase and continue independent work when a required body or decision cannot be recovered.

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

For SOURCE_NESTED_REPOSITORY or unsupported source entries, inspect the reported boundary and intended coverage. Do not silently exclude it, delete its .git, or rewrite ignore rules. An explicitly chosen project source exclusion changes coverage and never clears a referenced evidence failure.

### Sync recovery

SOURCE_ROOT_UNAVAILABLE means the registered directory is missing or no longer its safe directory. History and pending changes are retained, and native watching is suspended. Restore the actual directory or review its registration, then refresh synchronization. Do not delete archives, merge identities, or claim current verification. A new proof's scopeStatus describes the declared scope; state/pendingPaths describe the whole workspace. A passed scope can leave other work pending; older receipts need not contain scopeStatus.

1. Read `sync status`: when `scanPending:true` or `SOURCE_CHANGING` remains after its bounded complete recapture, let active edits/builds settle and refresh within a bounded wait. Keep the scope pending while activity continues.
2. On `SYNC_RACE`, preserve the receipt and inspect `error.details.recovery.cause`, `reviewScope`, `current` and `conflicts`. These describe that attempt; refresh status to obtain current facts. Re-review changed source, model and evidence in the authorized scope, including relevant incoming links. Equal final hashes can follow a real byte rollback and do not make an old epoch valid.
3. After that review, prepare a new declaration with the fresh binding and a new requestId. Recheck the checks and scope; changing only `sourceEpoch` or replaying the original requestId is not recovery. Verify and finish the normal stage lifecycle when the actual declared scope passes.
4. If ongoing writes or an unresolved evidence/model problem prevents completion, state which scope is pending and the concrete next action in the user's language. Preserve completed business work and archived history. Ask the user only for a real decision or missing access, rather than treating a race code as an unexplained task ending.

Keep authoritative .harness model/config/evidence/aliases, related source/docs and actual project skill files together: version them in Git projects; back them up with plain-directory projects. Keep machine settings/credentials, logs, history/snapshots/archived skills, indexes/caches/layouts separate and preserved. Do not copy global libraries or external link entities. Ignored/untracked/uncheckable Git ownership is diagnostic, not permission to stage, change ignores or delete files. Review actual diff and existing commit authorization.

## Retries, history and observation

- For PROJECT_ID_CONFLICT with recovery.reason=same-git-common-dir, review the root/common directory, canonical origin, both IDs and exact config bytes. Matching registered repositories use ordinary register to record legacy IDs locally without changing shared files; existing authorization can cover this recovery. Preserve worktree/task UUIDs and historical bytes. A changed origin or unrelated directory/repository must not be merged. The returned command may retain paired repair flags where no safe Git association exists: that advanced operation changes only the current config ID after byte backup and proof invalidation, and needs authorization for that change. Never rewrite registry UUIDs by hand or modify other checkouts. Changed bytes require a fresh review; lost responses require original request-status and record inspection before another write. Association or repair does not complete source/model synchronization.

- Save the request ID emitted on stderr. request status <request-id> inspects progress or the original durable receipt without dispatching the operation again. A timeout limits CLI waiting, not accepted server work; unknown after lookup/restart does not prove non-execution. Preserve the original ID and inspect before retrying. --timeout-ms sets a larger bounded wait only when appropriate; --quiet-progress suppresses stderr progress.
- Correct cwd/target conflicts explicitly. New-version requests cannot use stale bindings; catalog-only changes before selection may use task prompt. Closed tasks cannot receive new batches.
- history show restores captured batches without today's missing content. Browsing, handoff and skill reads do not extend the 60-day context retention window. Damage/uncollected evidence stays unknown.
- For logs, consult agent bind --help only with authorized, known host/session/absolute log path. No latest-session guessing or recursive scans. File change is not a read; read is not understanding.
- The default user data root shares one persistent service across projects; explicit roots are independent. Service scope/lifetime/startedAt and Web login/session expiry are different. Five-minute one-use codes and twelve-hour browser sessions are not process lifetimes. Recover an authenticated link when needed; a bare service address is not a login.
- GC/migration are separate actions, not setup-error repair. Preserve user skills, active .skills-library-<UUID> entities and history. Never force unknown processes or run competing writers to escape an initialization lock.
