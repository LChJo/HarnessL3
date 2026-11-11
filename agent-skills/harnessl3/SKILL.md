---
name: harnessl3
description: >
  Default context entry for all tasks: use when asking, researching, planning,
  implementing, debugging, reviewing, continuing, or handing off is even 1% relevant.
  Reuse captured context and skill bodies across turns; reassess skills each turn.
  Applies to main agents and subagents with parent handoffs.
---

# Route skills each turn; reuse project context

For every user turn, reassess skills for the current action. Reuse identifiable captured bodies that are still available and suitable; read only missing or newly required skill versions and project context. Follow the stages below; ask questions and report progress in the user's language.

## 1. Route the current turn

```text
User request
|-- Setup already declined/cancelled for this task -> work normally; do not ask again
|-- Unanswered setup question -> independent work only; keep the question pending
|-- Valid parent handoff -> inherit scope/selection; obtain only missing bodies
|-- Same goal/target, suitable captured versions and matching chosen skill set
|   `-- reuse available bodies; task read/query only missing material
|-- Same goal/target/model snapshot, changed skills/skill versions
|   `-- task select --stage -> read missing selected bodies; retain earlier batches
`-- New goal, no suitable task, or required new model/source binding
    `-- task start -> select skills and only missing project context
```

Planning -> implementation can keep the goal while changing skills (for example, to-tickets -> implement). A matching empty skill choice needs no file read. Recover lost content/references once with task handoff; query only missing context. See [continuation details](references/runtime.md#continuation-and-skill-routing) when switching stages.

Proceed to stages 2-3 for the chosen operation. Reuse known setup facts and authorization; extra version/help/status probes are unnecessary. Briefs and references are not bodies. Normal stage synchronization still applies.

## 2. Resolve prerequisites only when needed

```text
Chosen CLI operation
|-- CLI missing/incompatible -> read install-update.md
|   |-- Installation/update authorized -> install, then resume this operation
|   `-- No authorization -> offer installation; pending: independent work only;
|                         declined/cancelled: work without L3 for this task
|-- Archive-only handoff/read/history -> preserve its original target; no project initialization
`-- Live project operation
    |-- No usable existing directory -> explain the missing target; do independent work
    |-- .harness/project.json missing -> project-init.md: ask to INITIALIZE this actual path
    |-- Config exists but worktree is known unregistered -> project-init.md: ask to REGISTER
    `-- Ready, or registration state unknown -> execute; route onboarding errors below
```

Do not create Git/worktrees, probe all prerequisites, or install software merely because a message arrived. Installation and project initialization are separate permissions. Reuse explicit authorization for the relevant action/path; otherwise follow the question-tool rule below.

### Ask through the host's question tool

For a required user decision or setup consent, use the native question tool actually exposed and permitted by this host/mode (for example `AskQuestion`, `AskUserQuestion`, `request_user_input`, or `request_user_input_async`). **Call the tool** with its real schema; a question and bullet options in chat do not open that UI. Ask one self-contained question in the user's language, include the actual target/impact, give concise choices and a recommendation when useful, then wait for the answer before dependent work. Look up facts yourself and reuse confirmed decisions.

An async tool returning control is not a user answer; continue only independent work while the decision is pending. Never claim a dialog appeared without a successful tool call.

For initialization/registration: consent -> follow the project reference, then resume; decline/cancel -> ordinary work without further L3 calls for this task; pending -> independent work only. Silence is not consent. Initialization includes the current agent's reading, modeling and coverage review; scaffold-ready or parsing success alone is insufficient.

## 3. Execute and handle the actual result

```text
Chosen operation
|-- Success
|   |-- task start -> one joint context/skill selection; an explicit empty selection is valid
|   `-- handoff/query/read -> use actual returned content for the current turn
|-- TARGET_REQUIRED with error.details.onboarding -> return to project setup in stage 2
|-- Source/model/closed-task conflict -> obtain a new binding only if current material is needed
`-- Other failure -> resolve the specific cause; explain unrecoverable gaps and do independent work
```

`onboarding` is a consent request, including on older CLIs. `fallback:continue-without-l3` applies only after decline/cancellation, never merely after a nonzero exit. Use its actual worktreeRoot/state; target conflicts without onboarding are not permission to initialize.

If the host cannot create the command process (for example sandbox provisioning or `helper_sandbox_lock_failed`), the command did not run and there is no CLI result to parse. Use an available permitted file reader for references. For a blocked command or CLI permission error, request narrowly scoped host approval only when the exposed tool and current policy allow it; otherwise report the blocker and continue independent work without claiming L3 succeeded. Never require full access, change host ACLs/settings, or relocate existing data as entry recovery. See [permission recovery](references/runtime.md#permission-and-host-startup-failures) when that reference is accessible.

Default task start captures a model snapshot without scanning source; source status is unknown. Use verified mode only when current complete source binding is actually needed; sync verify always retains strict full checks. Use task select --stage for intentional skill changes on the same task, preserving earlier plans/bytes. Command help exposes shorthand flags and task-owned defaults; do not manually reconstruct bindings/hashes when the CLI can resolve them. Own edits still require stage synchronization. Before first selection, task prompt can refresh a changed catalog. On timeout/cancellation/lost response, use request status with the original ID before any retry; progress on stderr identifies that ID. Unknown is not evidence of non-execution.

## Work and task lifecycle

- Use the actual existing directory or Git worktree/branch. The nearest .harness/project.json or .git boundary owns the target; without either, init targets cwd. Plain directories need no Git; never downgrade a damaged registered Git target. Consult command --help/Schema only when needed; take IDs, bindings and file hashes from real responses.
- Write non-ASCII JSON to an explicit UTF-8 file outside the worktree, then use --file. Use stdin only with guaranteed UTF-8 bytes; default PowerShell native pipelines can corrupt text. Preserve already-corrupted history.
- After source/long-term document changes, maintain current LikeC4 descriptions, relations, evidence and incoming links; preserve identities/history and verify the actual scope. See [stage synchronization](references/runtime.md#document-maintenance-and-stage-synchronization).
- Evolve the model as implementation grows. New/removed modules, entry points, dependencies, responsibility moves and major refactors require structural review in the authorized stage. Use `model maintain --mode supplement` for gaps, `--mode revise` for corrections or `--mode rebuild` for a reassessment when needed; reuse suitable guidance already returned. The current agent edits files, preserves continuing IDs/history and checks actual view coverage. A small new project can have a small accurate graph; planned work is not implemented structure. Guidance/hints are not completed modeling; source checks and scoped sync proofs remain required. See [modeling guidance](references/project-init.md#the-current-agent-completes-semantic-onboarding).
- Keep project .harness authority, related source/docs and actual project skill files together: version them in Git projects; back them up with plain-directory projects. In-place Git adoption preserves UUIDs/history and invalidates current source proofs; use a new task for changed bindings. Preserve and isolate machine settings/credentials, derived indexes, history and external skill libraries. This is not authorization to stage/commit/push.
- A plan, todo list or final reply does not trigger task close. Keep the task open while its work or confirmation is pending; close after actual completion/cancellation and recorded sync state. Closed tasks are read-only; subagents never close a parent task.
- For JSON calls, keep stdout/stderr separate and save the CLI exit code. Check ok before reading data; preserve complete error.code/details on failure. Parser/head success is not CLI success.
- Preserve partial/unresolved/unknown states. Selection/read does not prove understanding or execution.

## Output card: once per actual task

After actual context and required skill bodies return (also for an explicit empty selection), obtain result.url with web open --no-open --task <actual-taskId> --json. Show this required localized card in commentary, then work:

```markdown
> **HarnessL3 · 本次输出**
>
> ↗ [查看HarnessL3的输出](actual result.url)
```

Do not wrap the rendered card in a code block. Keep the URL only in the link target; add no usage/selection instructions or routine expiry text. Do not repeat for continuation, delta reads or the final reply. It does not indicate completion. If Web is unavailable, say so and continue usable CLI work; do not invent a link.

## Load references only for the selected path

- Missing/incompatible CLI, installation or updates: [install-update.md](references/install-update.md).
- Uninitialized/unregistered project, consent or incomplete modeling: [project-init.md](references/project-init.md).
- Complex requests, sync, retries/history or explicit log binding: [runtime.md](references/runtime.md).
- Parent handoff or independent delegated task: [subagent.md](references/subagent.md).

Entry recovery must not recursively enter L3. Do not preload all references, install Hooks, launch agents, scan unknown sessions, or delete user skills/history to repair setup.
