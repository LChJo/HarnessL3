# Runtime reference

Read only when current CLI help is insufficient, or for complex requests, synchronization, retries/history or explicit read-only log binding. The installed CLI and its JSON Schemas define fields and commands.

## Continuation and missing material

Execute earlier todos, implement the agreed plan, and handle clarifications under the same actual goal. With an identifiable task, matching target/binding, recorded selection and sufficient returned bodies, work directly: no entry/status/handoff probes or repeated reads/cards. Reuse is not a new observed read.

Recover lost material once with the actual taskId and task handoff. Query only missing context bodies, and task read only missing selected skill bytes. Old/closed bindings describe captured versions; create a new task only when current-version material or a different skill selection requires it. Own edits still need stage synchronization, not per-message entry. Plans, todos and replies do not close tasks; actual completion/cancellation plus recorded sync state does. Closed tasks remain read-only.

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

Parse the single JSON envelope and exit code. On failure inspect error.code/details; on success inspect the actual data kind/status/scope. ok:true can still be partial. Keep successful items and address only the missing ones.

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
