---
name: domain-modeling
description: Build and sharpen a project's domain model. Use when discussing codebase terminology, writing or editing a GLOSSARY.md, or recording or editing an ADR.
---

> Apply this method within the target project's rules and task authorization. Selecting or reading it does not execute commands or grant additional permissions.

# Domain Modeling

Actively build and sharpen the project's domain model as you design. This is the *active* discipline — challenging terms, inventing edge-case scenarios, and writing the glossary and decisions down the moment they crystallise. (Merely *reading* `GLOSSARY.md` for vocabulary is not this skill — that's a one-line habit any skill can do. This skill is for when you're changing the model, not just consuming it.)

## File structure

First locate the target project's authoritative model and documentation rules. The layouts below are examples for projects that use a glossary and ADR files; an existing LikeC4 model or other established authority stays authoritative. Update it within the task's scope instead of creating a duplicate glossary or baseline.

A project with a single glossary context may use:

```
/
├── GLOSSARY.md
├── docs/
│   └── adr/
│       ├── 0001-event-sourced-orders.md
│       └── 0002-postgres-for-write-model.md
└── src/
```

If a `GLOSSARY-MAP.md` exists at the root, the repo has multiple contexts. The map points to where each one lives:

```
/
├── GLOSSARY-MAP.md
├── docs/
│   └── adr/                          ← system-wide decisions
├── src/
│   ├── ordering/
│   │   ├── GLOSSARY.md
│   │   └── docs/adr/                 ← context-specific decisions
│   └── billing/
│       ├── GLOSSARY.md
│       └── docs/adr/
```

Create new glossary or ADR files only when needed and permitted by the project's chosen layout. Missing `GLOSSARY.md` or `docs/adr/` alone is not a reason to create them.

Retained terminology and decision documents are part of the same knowledge change: maintain their current model/evidence links and Git ownership. Repair references when a document moves or is superseded, preserving stable identities and archived history.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in `GLOSSARY.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update GLOSSARY.md inline

When a term is resolved, record it promptly in the project's authoritative location. For a dedicated `GLOSSARY.md` glossary, [GLOSSARY-FORMAT.md](GLOSSARY-FORMAT.md) offers a template; adapt it to existing project conventions.

Keep a dedicated glossary focused on domain terms rather than turning it into a scratchpad or implementation spec. Respect the established purpose of an existing `GLOSSARY.md` that serves a broader role.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use the format in [ADR-FORMAT.md](ADR-FORMAT.md).
