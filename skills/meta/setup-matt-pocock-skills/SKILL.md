---
name: setup-matt-pocock-skills
description: Optional guidance for documenting a project's existing task store, triage vocabulary and domain-document conventions. Use only when those conventions need clarification; no tracker or host initialization is required.
---

> Apply this method within the target project's rules and task authorization. Selecting or reading it does not execute commands or grant additional permissions.

# Project Workflow Conventions

The historical method name is retained for provenance; its category path follows this library's current organization. This editable file helps understand or document the target project's workflow; it is not an installer or a prerequisite for using the other files.

For a chosen hosted tracker, verify the target repository is reachable before documenting a working integration; do not create a remote or repository automatically. Check triage-label existence and prepare missing-label changes only within the authorized setup scope. If a project still uses legacy `CONTEXT.md`/`CONTEXT-MAP.md`, discuss a move to the GLOSSARY names when migration is needed; preserve existing authority, stable identities and incoming references rather than renaming unrelated documents.

## 1. Read the existing rules

Confirm the target project and worktree. Read its `AGENTS.md` and any explicitly designated authority, current task/spec locations, domain model, and decision records. Use `CLAUDE.md` only when that project actually designates it; do not prefer it merely because it exists, create a competing entry point, or overwrite another task's configuration.

Look for existing task files and configured tools before proposing changes. Git remotes can identify a repository but do not prove an issue-tracker account, authenticated CLI, write permission or desired provider. A missing `docs/agents/` or `GLOSSARY.md` is not a setup failure.

## 2. Identify only the conventions this task needs

- **Task store**: reuse local task/spec files or the already configured tracker. External services are optional. If the task only needs a draft, write it in the authorized artifact location without initializing a tracker.
- **Triage roles**: relevant only when the user actually needs incoming-work triage. Map who clarifies, prioritizes and implements work to the existing labels; do not create new labels or a second state machine automatically.
- **Domain knowledge**: reuse the established authoritative model, glossary and decisions. LikeC4 or another existing model does not need a duplicate `GLOSSARY.md` just to satisfy this method. When terminology needs work, record the term's agreed meaning and boundaries in that existing authority.

Ask only for decisions the project evidence and current authorization do not already settle. Preserve unknown access/capabilities explicitly instead of assuming installation or login.

## 3. Prepare concrete changes when configuration is requested

Summarize the existing conventions and the smallest necessary documentation change. A repository may keep short pointers in its existing `AGENTS.md` and details in its established docs location. Do not invent a new agent entry point or change the project's authoritative model.

The following are optional seed templates, not a mandatory file layout:

- [Local Markdown task store](issue-tracker-local.md)
- [GitHub example](issue-tracker-github.md), only for a configured and authorized GitHub workflow
- [GitLab example](issue-tracker-gitlab.md), only for a configured and authorized GitLab workflow
- [Triage role mapping](triage-labels.md), only when triage is in scope
- [Domain document consumer rules](domain.md), adapted to the actual model/layout

The templates preserve useful work-item and blocking-edge conventions; inspect actual tools and platform capabilities before using command examples. Another provider can be documented in plain prose from the project's existing workflow.

## 4. Apply only the authorized documentation change

Reuse any existing approval for routine project maintenance. When a new user decision is required, present the actual proposed result first. Preserve surrounding user edits and update an existing convention in place rather than appending a duplicate.

Changing a local convention file does not create labels, publish issues, send comments, install tools or configure credentials. Perform those external actions only when requested and supported, and report what actually happened.

## 5. Report the resulting convention

State which artifact is authoritative, what changed and what remains unknown. The files stay directly editable. Skill Hub refreshes its own derived skill directory; it does not rewrite project rules or skill bodies.
