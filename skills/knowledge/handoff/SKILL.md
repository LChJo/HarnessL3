---
name: handoff
description: Capture confirmed task state, references, verification and next steps in a handoff artifact for the current or a later agent. Use when work needs a durable continuation note; no session control is assumed.
---

> Apply this method within the target project's rules and task authorization. Selecting or reading it does not execute commands or grant additional permissions.

Write a handoff document summarising the current task so the current or a later agent can continue. Use the destination and retention convention already established for this project; if none exists, provide a draft or choose a clearly identified local temporary file within the task's allowed write scope.

Identify whether this is a temporary continuation note or durable project knowledge. For an actual L3 task, include its returned taskId, worktree and relevant versions; a Markdown handoff and the CLI's archived handoff serve different purposes. If retained as project knowledge, maintain current context/evidence links and review its Git ownership with the related changes.

Include a "suggested method files" section only where useful. Link actual Skill Hub file references and say why they may help; the receiving agent decides what to read. Do not invent slash commands or mark suggestions as selected/executed.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

Include task/worktree, relevant versions, confirmed decisions, verification, unknowns and the next concrete step. This document does not clear context, open a session, choose a model/provider or launch another agent; those actions depend on the host and the user's intended workflow.
