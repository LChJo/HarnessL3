---
name: to-tickets
description: Break a plan, spec or conversation into independently verifiable tracer-bullet tickets with explicit blocking edges. Use existing local task files or a configured tracker when publishing is authorized.
related:
  - ../../meta/setup-matt-pocock-skills/SKILL.md
---

> Skill Hub file reference: use this method under the target project's rules and task authorization; selecting or reading it runs no command or workflow. Linked methods are optional candidates, not automatic selections or archives; [maintenance notes](../../FILE-REFERENCES.md) are optional current-library guidance, and unprovided files or capabilities must be checked.

# To Tickets

Break a plan, spec, or conversation into a set of **tickets** — tracer-bullet vertical slices, each declaring the tickets that **block** it.

Use the project's current task-file or tracker convention and any configured label vocabulary. [Project setup guidance](../../meta/setup-matt-pocock-skills/SKILL.md) is optional if this genuinely needs defining; missing tracker configuration does not block drafting tickets.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the work into **tracer bullet** tickets.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests) — vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to be understood, implemented and verified as one bounded task; no fixed token window or automatic new session is assumed
- Any prefactoring should be done first

</vertical-slice-rules>

Give each ticket its **blocking edges** — the other tickets that must complete before it can start. A ticket with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change — rename a column, retype a shared symbol — whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket — green is promised only there.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Title**: short descriptive name
- **Blocked by**: which other tickets (if any) must complete first
- **What it delivers**: the end-to-end behaviour this ticket makes work

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct — does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?

Resolve material scope or dependency choices with the user. Reuse existing approval when the breakdown is already authorized rather than requiring a second identical confirmation.

### 5. Save the tickets in the established project workflow

Save the agreed tickets within the task's allowed write scope. Use the project's existing task store; the shapes below are examples rather than required setup. External writes require task authorization and working tools; if unavailable, retain a local draft and report that publication remains pending:

- **Local files** → follow the existing task layout. If the project has no convention, one possible layout is `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` in dependency order (blockers first). Each file's "Blocked by" lists the numbers/titles it depends on. The per-ticket template below keeps each ticket independently addressable.
- **A configured issue tracker** → when authorized, publish one issue per ticket in dependency order so blocking edges reference real identifiers. Use supported native relationships or explicit "Blocked by" links, and the project's actual readiness labels. Do not assume a provider, account, paid feature or label already exists.

Work the **frontier**: any ticket whose blockers are all done. For a purely linear chain that means top to bottom.

Do NOT close or modify any parent issue.

<local-ticket-template>

# <NN> — <Ticket title>

**What to build:** the end-to-end behaviour this ticket makes work, from the user's perspective — not a layer-by-layer implementation list.

**Blocked by:** the numbers/titles of the tickets that gate this one, or "None — can start immediately".

**Status:** ready-for-agent

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2

</local-ticket-template>

<issue-template>

## Parent

A reference to the parent issue on the tracker (if the source was an existing issue, otherwise omit this section).

## What to build

The end-to-end behaviour this ticket makes work, from the user's perspective — not layer-by-layer implementation.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Blocked by

- A reference to each blocking ticket, or "None — can start immediately".

</issue-template>

In either form, avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.
