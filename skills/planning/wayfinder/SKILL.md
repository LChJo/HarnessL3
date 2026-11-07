---
name: wayfinder
description: Clarify a large uncertain effort through a shared map of decision tickets, resolving the frontier until implementation can be planned. Use existing local task artifacts or a configured tracker; session and provider controls are optional.
---

> Apply this method within the target project's rules and task authorization. Selecting or reading it does not execute commands or grant additional permissions.

A large idea is wrapped in fog: the way from here to the **destination** is not visible yet. Wayfinding charts a **shared map** in the project's existing task artifacts, then works its **decision tickets** — questions whose resolution is a decision, not slices of a build to execute. The map may span several work periods without assuming a particular agent session size or a session-control command.

The destination varies per effort, and naming it is the first act of charting — it shapes every ticket. It might be a spec to hand off and iterate on, a decision to lock before planning starts, or a change made in place like a data-structure migration. The map is domain-agnostic — engineering work, course content, whatever fits the shape.

## Plan, don't do

Wayfinder is **planning** by default: each ticket resolves a decision, and the map is done when the way is clear — nothing left to decide before someone goes and does the thing. The pull to just do the work is usually the signal you've reached the edge of the map and it's time to hand off. An effort can override this in its **Notes** — carrying execution into the map itself — but absent that, produce decisions, not deliverables.

## Refer by name

Every map and ticket is an addressable task artifact with a **name**. In narration and Decisions-so-far, use the title with its path or issue link so humans can judge relevance without opening every item. IDs remain identities, not a substitute for useful names.

## The Map

The map is one artifact in the project's existing task store; each decision ticket is separately addressable and linked from it. A configured tracker may use an issue and child issues; local files work too. Reuse the project's authority and labels instead of installing a second planning system.

The map is an **index**, not a store. It lists the decisions made and points at the tickets that hold their detail; a decision lives in exactly one place — its ticket — so the map never restates it, only gists it and links.

**Where artifacts, blocking edges and frontier queries live is project-specific.** Read the existing task convention and clarify only the missing details this work needs. Do not initialize an external tracker as a prerequisite. Without one, draft in the already authorized local artifact location.

### The map body

The whole map at low resolution, loaded once per session. Open tickets are **not** listed — they are open child issues, found by query.

```markdown
## Destination

<what reaching the end of this map looks like — the spec, decision, or change this effort is finding its way to. One or two lines; every session orients to it before choosing a ticket.>

## Notes

<domain; skills every session should consult; standing preferences for this effort>

## Decisions so far

<!-- the index — one line per closed ticket: enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [<closed ticket title>](link) — <one-line gist of the answer>

## Not yet specified

<!-- see "Fog of war": in-scope fog you can't ticket yet; graduates as the frontier advances -->

## Out of scope

<!-- see "Out of scope": work ruled beyond the destination; closed, never graduates -->
```

### Tickets

Each ticket is linked to the map with a stable local path or tracker identity. Its body states one bounded, reviewable question; no fixed token budget is assumed:

```markdown
## Question

<the decision or investigation this ticket resolves>
```

Each ticket carries a `wayfinder:<type>` label — one of `research`, `prototype`, `grilling`, `task` (see [Ticket Types](#ticket-types)).

When concurrent workers exist, use the project's existing claim/ownership convention so they do not duplicate work. A tracker assignment or local claim is a write and requires the task's authorization; if unavailable, identify the intended item and the ownership uncertainty explicitly.

Record blocking with supported native relationships or explicit local links; do not assume a provider, subscription tier or special API. A ticket is **unblocked** when its actual blockers are resolved; the **frontier** is the open, unblocked, unclaimed set — the edge of the known.

The answer isn't part of the body — it's recorded on resolution (see [Work through the map](#work-through-the-map)). Assets created while resolving a ticket are linked from the issue, not pasted in.

## Ticket Types

Every ticket is either **HITL** — human in the loop, worked *with* a human who speaks for themselves — or **AFK**, driven by the agent alone. A HITL ticket only resolves through that live exchange; the agent never stands in for the human's side of it (a grilling agent that answers its own questions has broken this).

- **Research** (AFK): Read primary sources or local knowledge to surface a fact a decision needs, and capture cited findings in the project's existing research location. The current agent can do this; an independently scoped reader is optional when available and authorized.
- **Prototype** (HITL): Raise the fidelity of the discussion by making a cheap, rough, concrete artifact to react to — an outline, a rough take, a stub, or minimal UI/logic code that tests the unresolved design question. Links the prototype as an asset. Use when "how should it look" or "how should it behave" is the key question.
- **Grilling** (HITL): Resolve open design choices in conversation, one question at a time, and record confirmed terms and decisions in the project's existing authority. Look up facts first and wait for the user's decisions. The default case.
- **Task** (HITL or AFK): Manual work that must happen before a *decision* can be made — nothing to decide, prototype, or research, but the discussion is blocked until it's done. Signing up for a service so its API can be judged, provisioning access, moving data so its shape can be seen. This is the one type that *does* rather than decides — and it earns its place by unblocking a decision, not by delivering the destination. The agent drives it alone where it can (AFK); otherwise it hands the human a precise checklist (HITL). Resolved when the work is done; the answer records what was done and any resulting facts (credentials location, new URLs, row counts) later tickets depend on.

## Fog of war

The map is _deliberately_ incomplete: don't chart what you can't yet see. Beyond the live tickets lies the **fog of war** — the dim view of decisions and investigations you can tell are coming but can't yet pin down, because they hang on questions still open. Resolving a ticket clears the fog ahead of it, graduating whatever's now specifiable into fresh tickets — one at a time, until the way to the destination is clear and no tickets remain.

The map's **Not yet specified** section is where that dim view is written down: the suspected question, the area to revisit later. It's the undiscovered frontier _toward_ the destination — everything here is in scope, just not sharp enough to ticket. Write as loosely or as fully as the view allows; it doubles as a signpost for collaborators reading where the effort is headed.

**Fog or ticket?** The test is whether you can state the question precisely now — _not_ whether you can answer it now.

- **Ticket when** the question is already sharp — even if it's blocked and you can't act on it yet.
- **Not yet specified when** you can't yet phrase it that sharply. Don't pre-slice the fog into ticket-sized pieces: it's coarser than a ticket, and one patch may graduate into several tickets, or none, once the frontier reaches it.

**Not yet specified** excludes what's already decided (Decisions so far), what's already a live ticket, and what's out of scope (the next section).

## Out of scope

Fog only ever gathers _toward_ the destination. The destination fixes the scope, so work beyond it is **out of scope** — it isn't fog, and it doesn't belong in **Not yet specified**. It gets its own **Out of scope** section on the map: work you've consciously ruled out of _this_ effort. Scope, not sharpness, lands it here.

Out-of-scope work never graduates — the frontier stops at the destination — so it returns only if the destination is redrawn, and then as a fresh effort, not a resumption.

Ruling something out of scope is a scoping act, not a step on the route. When a ticket that already exists turns out to sit past the destination — mis-scoped in while charting, or exposed by a resolution — **close it** (a closed ticket is unambiguously off the frontier) and leave one line in the **Out of scope** section: the gist plus why it's out of scope, linking the closed ticket. It stays out of **Decisions so far**, which records the route actually walked — a scope boundary isn't a step on it.

## Invocation

Two modes. Work through bounded decisions with explicit checkpoints; continue another item only when the task scope and available context support it. Do not clear context, open a new session or choose a model/provider on behalf of this method.

### Chart the map

User invokes with a loose idea.

1. **Name the destination.** Resolve the open scope decisions with the user one question at a time, recording confirmed terminology and choices, to pin down what this map is finding its way to — the spec, decision, or change. The destination fixes the scope, so it's settled first.
2. **Map the frontier.** Explore breadth-first, surfacing open decisions and first steps. If the path is already clear and bounded, a map adds no value; continue the authorized planning or implementation work rather than imposing an extra phase.
3. **Create the map** (label `wayfinder:map`): Destination and Notes filled in, Decisions-so-far empty, the fog sketched into **Not yet specified**.
4. **Create the tickets you can specify now** as child issues of the map — then wire blocking edges in a **second pass** (issues need ids before they can reference each other). Wiring sorts them into the frontier and the blocked; everything you can't yet specify stays in the fog — the **Not yet specified** section.
5. **Resolve independent research where useful.** Read primary sources in the current agent, or use independently scoped readers when available and authorized. Keep cited findings in the existing artifact location and link them from the ticket. A new branch, worktree or commit is not required by this method.
6. Record the map's current frontier, confirmed decisions and unknowns. Charting does not silently start the implementation phase.

### Work through the map

User invokes with a map (URL or number). A ticket is **optional** — without one, you pick the next decision, not the user.

1. Load the **map** — the low-res view, not every ticket body.
2. Choose the ticket. If the user named one, use it. Otherwise take the first appropriate frontier item and follow the authorized ownership convention.
3. Resolve it — **zoom as needed**: read related ticket bodies and method references only when useful. The Notes block's suggestions do not select or execute files automatically; verify actual references and capabilities. Resolve remaining choices with the user one at a time and keep confirmed terminology and decisions in the project's existing authority.
4. Record the resolution in its existing artifact and append a context pointer to Decisions-so-far. Maintain affected project-model/evidence links for retained maps and tickets, including repairs when tickets move or are removed; keep archived history. Post comments or close external issues only when those writes are authorized and supported; otherwise retain a local draft and report the pending publication.
5. Add newly-surfaced tickets (create-then-wire); graduate any fog the answer has made specifiable, clearing each graduated patch from **Not yet specified** so it lives only as its new ticket. If the answer reveals a ticket — this one or another — sits beyond the destination, **rule it out of scope** rather than resolving it on the route. If the decision invalidates other parts of the map, update or delete those tickets.

The user may run unblocked tickets in parallel, so expect other sessions to be editing the tracker concurrently.
