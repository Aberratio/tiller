# The smell baseline

A fixed set of code smells (Fowler, *Refactoring*, ch. 3) that the Standards axis carries even when the repo documents nothing. Paste this file into the Standards brief in full — the sub-agent has no other access to it.

Three rules bind it:

- **The repo overrides.** A documented repo standard always wins; where the repo endorses something the baseline would flag, the smell is suppressed.
- **Always a judgement call.** Each entry is a labelled heuristic ("possible Feature Envy"), never a hard violation. Documented-standard breaches can be hard; baseline smells cannot.
- **Skip what tooling enforces.** Formatting, import order, and anything a linter already fails the build on is noise in a review.

Each smell reads *what it is* → *how to fix*:

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design is murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

## Pre-existing debt

A smell the diff **extends** rather than introduces gets its own label:

> **pre-existing — amplified by this change**

Report it with the count that makes the amplification visible ("this markup block already repeats 3× in the sibling route; the diff adds a 4th"), name the proper fix, and recommend a separate tech-debt task. Reporting it as though the diff created it makes the signal dishonest, and fixing it here quietly expands a focused change into an unrelated refactor. Whether to take it on anyway is the author's call, made explicitly.
