---
name: improve-codebase-architecture
description: Scan a codebase for deepening opportunities, present them as a visual HTML report, then grill through whichever one you pick.
related:
  - ../../discovery/grilling/SKILL.md
  - ../codebase-design/SKILL.md
  - ../domain-modeling/SKILL.md
---

> Skill Hub file reference: use this method under the target project's rules and task authorization; selecting or reading it runs no command or workflow. Linked methods are optional candidates, not automatic selections or archives; [maintenance notes](../../FILE-REFERENCES.md) are optional current-library guidance, and unprovided files or capabilities must be checked.

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability.

This method is informed by the project's authoritative domain model and a shared design vocabulary:

- Read [codebase-design](../codebase-design/SKILL.md) when its vocabulary (**module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**) helps: deletion test, interface as test surface, one hypothetical adapter versus a demonstrated seam. Use the project's established terms when they differ.
- The domain language in `CONTEXT.md` gives names to good seams; ADRs in `docs/adr/` record decisions this command should not re-litigate.

## Process

### 1. Explore

**Scope before you scan — YAGNI.** Deepening a module pays off by making future changes to it easier, so put extra weight on the parts of the codebase that have recently changed. Decide *where* to look before you look:

- If the user named a direction — a module, a subsystem, a pain point — take it, and skip the inference below.
- Otherwise, walk back a good stretch of the commit history (`git log --oneline`) to find the codebase's hot spots — the files and areas that keep coming up — and let those paths pull your attention first. If the changes are scattered with no clear hot spot, widen the net.

Read the project's domain glossary (`CONTEXT.md`) and any ADRs in the area you're touching first.

Explore with the current agent's ordinary file/search tools. A separately scoped reader is optional when supported and authorized; no fixed Agent tool or agent type is required. Note where understanding creates friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want.

### 2. Present candidates as an HTML report

Write a report in the task's authorized artifact location, following existing project conventions. HTML is useful for comparing candidates visually; provide its path or use a concise Markdown report if creating HTML is outside scope. Do not assume an OS opener or visible browser is available.

Prefer self-contained CSS/SVG where offline viewing matters. Existing Mermaid or styling tools may help when available; the reference HTML's CDN setup is an optional example, not a required network dependency. Each candidate should make the before/after structure easy to compare.

For each candidate, render a card with:

- **Files** — which files/modules are involved
- **Problem** — why the current architecture is causing friction
- **Solution** — plain English description of what would change
- **Benefits** — explained in terms of locality and leverage, and how tests would improve
- **Before / After diagram** — side-by-side, custom-drawn, illustrating the shallowness and the deepening
- **Recommendation strength** — one of `Strong`, `Worth exploring`, `Speculative`, rendered as a badge

End the report with a **Top recommendation** section: which candidate you'd tackle first and why.

**Use CONTEXT.md vocabulary for the domain, and the [codebase-design](../codebase-design/SKILL.md) vocabulary for the architecture.** If `CONTEXT.md` defines "Order," talk about "the Order intake module" — not "the FooBarHandler," and not "the Order service."

**ADR conflicts**: if a candidate contradicts an existing ADR, only surface it when the friction is real enough to warrant revisiting the ADR. Mark it clearly in the card (e.g. a warning callout: _"contradicts ADR-0007 — but worth reopening because…"_). Don't list every theoretical refactor an ADR forbids.

See [HTML-REPORT.md](HTML-REPORT.md) for the full HTML scaffold, diagram patterns, and styling guidance.

Do NOT propose interfaces yet. After the file is written, ask the user: "Which of these would you like to explore?"

### 3. Grilling loop

Once a candidate needs a design decision, the [grilling method](../../discovery/grilling/SKILL.md) may help walk its constraints, dependencies, module shape and surviving tests. Reuse decisions already confirmed for the task.

When confirmed decisions change the domain knowledge, consult [domain-modeling](../domain-modeling/SKILL.md) if useful and maintain the project's actual authority within scope:

- **Naming a module after a new domain concept?** Record the resolved term in the project's authoritative model/glossary; do not create a second one just for this method.
- **Sharpening a fuzzy term?** Keep the relevant authority current when that edit is in scope.
- **User rejects the candidate with a load-bearing reason?** Offer an ADR, framed as: _"Want me to record this as an ADR so future architecture reviews don't re-suggest it?"_ Only offer when the reason would actually be needed by a future explorer to avoid re-suggesting the same thing — skip ephemeral reasons ("not worth it right now") and self-evident ones.
- **Want to explore alternative interfaces for the deepened module?** Read [codebase-design](../codebase-design/SKILL.md) and its design-it-twice comparison method. Parallel readers are optional and depend on the host and task authorization.
