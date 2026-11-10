# Project initialization and registration

Read for an uninitialized/unregistered existing Git worktree, explicit onboarding, or a placeholder/incomplete model. A ready project does not need repeated initialization or whole-project modeling.

## Identify the actual setup requirement

Use the intended existing worktree as the command working directory. If facts are missing, establish them with:

```text
git rev-parse --show-toplevel
git branch --show-current
harnessl3 worktree list --json
```

A missing .harness/project.json requires initialization; an existing config with an unregistered worktree requires registration. Do not guess the most recent project, create Git/worktrees, or infer a target from an empty registry.

TARGET_REQUIRED with details.onboarding is a request for consent, not a generic CLI outage. Its worktreeRoot is the actual path; state distinguishes initialization-required from registration-required; command is a suggested argument array. nextAction:ask-user and question guide the current agent. fallback:continue-without-l3, including on older CLIs, applies only after decline/cancellation. Older confirmationRequired:true also requires asking. Other missing/conflicting targets do not authorize initialization.

## Ask once, then follow the answer

Reuse explicit authorization for this path/action. Otherwise follow the main skill's question-tool rule and make one native question-tool call before setup; printing a question and options is not that call.

The tool question must identify the actual absolute worktree path and the required action. For initialization, explain that missing .harness configuration, model, evidence and alias files will be added, the worktree registered, and the user skill library created only if absent; existing content is preserved. For an existing configuration, ask to register instead and state that configuration/model files are preserved. Offer consent-and-continue and work-without-L3-for-this-task, with a recommendation when useful.

Use the actual tool name/schema exposed by this host, including an allowed async variant when appropriate. Keep the decision pending until the user answers; neither an async return nor a default/preselected choice is consent. The JSON CLI stays non-interactive.

- Consent: execute the matching operation below, complete semantic review/modeling, then resume the original task.
- Decline/cancel: ordinary execution; do not create configuration/registration/tasks or ask again for the same goal. Reconsider only when the user requests onboarding or changes task/worktree.
- Pending: independent work only. Silence/time passing is not consent. On failure, preserve user content, explain the actual gap and avoid initialization loops.

For authorized initialization, in that target directory:

```text
harnessl3 init --name "Project name" --json
harnessl3 model validate --json
harnessl3 worktree list --json
```

For authorized registration of an existing configuration:

```text
harnessl3 worktree register <actual-existing-worktree-path> --json
harnessl3 model validate --json
```

Run validation in the registered target directory, or use its returned --worktree UUID without a conflicting registered cwd. Another worktree lacking context uses init in that worktree; never copy another repository's projectId or replace configuration to bypass a conflict.

init only creates missing files, registers identity, initially seeds skills and parses the model. initialization.stage:scaffold-ready and semanticStatus:not-assessed are mechanical results, not semantic completion. Inspect actual project/worktree IDs, modelCreated, topology counts and nextAction.

## The current agent completes semantic onboarding

Use existing file tools and the current model; do not launch another agent/model or generate architecture guesses from directory names.

1. **Read and report progress.** Read project documentation, structure, key entry points and enough source to support component responsibilities/dependencies. Distinguish production, prototype/history and external sources. Preserve valid model/evidence identities and user content.
2. **Model and report progress.** Edit .harness/model/*.c4 with actual composition, briefs, necessary relations and views; record sources, claims and review scope in evidence.json. Tools can write/hash bytes; the current agent performs semantic judgment. A directory listing or root-only scaffold does not cover a multi-module project. Do not invent nodes for counts.
3. **Validate and review coverage.** Run model validate, inspect actual topology/views, and compare key components/dependencies/evidence with the read scope. Confirm the structure through Web or the same core read model; browsing is not an agent-body read. Repair gaps through files. Parsing success is not semantic coverage.

Report real stages, covered/uncovered scope, actual counts and diagnostics, not invented percentages. A placeholder, missing key structure or failed validation remains mechanically ready/modeling incomplete; do not claim completed onboarding.

## Resume without losing boundaries

After correct-target setup, semantic modeling/review, parsing and coverage checks, return to the main skill's chosen operation. If current modeling requires a fresh task binding, create it for the actual user goal; retain old snapshots as captured. Onboarding alone is not returned task context. Show the main skill's required output card only after actual context and necessary skill bodies return.

Keep the existing data root (--data-dir, HARNESSL3_HOME or platform default), outside all registered worktrees; do not substitute a temporary root to disguise recovery. Version project model/config/evidence/aliases and referenced project docs/actual skill files with related source. Keep machine settings, credentials, logs, archives and derived indexes separate and preserved; do not copy external skill entities into Git. Initialization consent does not authorize commit/push.

The default user service is persistent with no idle expiry; explicit roots may have separate instances. A login code lasts five minutes/one use and a browser session twelve hours; neither is the process lifetime. Do not delete .harness, skills or history to repair setup. Archive-only handoff/read/history recovery does not require reinitializing today's project.
