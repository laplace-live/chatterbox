# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Code style

### Comments

Comments must be **sparse and terse** — verbosity is the problem; a long comment is worse than no comment. One exception: **JSDoc/TSDoc doc-comments** (`/** … */`) attached to a declaration surface in editor hover and autocomplete — keep them, but keep them tight.

- **Keep doc-comments on declarations.** A `/** … */` block on a function, method, class, type, interface, or exported const earns its place by showing in hover tooltips and IntelliSense — don't delete it just because it echoes the name (e.g. keep `/** Read the active global prompt. */` over `getActiveGlobalPrompt()`). Hold it to one line where you can; reach for `@param`/`@returns`/`@example` only to add what the signature can't say (units, ranges, edge cases, ownership). Never pad it into a paragraph.
- **Cut name-restaters elsewhere.** Delete any `//` inline note or block comment on local variables and implementation details that merely restates a name, signature, type, or an obvious operation.
- **Condense long block comments to 1–2 lines.** Compress multi-paragraph module headers, design-rationale essays, and per-item writeups down to their single essential point (usually a non-obvious _why_). Drop history, tangents, and cross-references to unrelated modules.
- **Keep only genuinely non-obvious information, in 1–2 lines** — a subtle edge case, a non-obvious _why_, a workaround, an invariant, units/ranges, or a gotcha. Never a paragraph.
- **Prefer self-documenting names.** For local/internal logic, skip the comment unless it's genuinely non-obvious or you're asked to add one; a good name beats a comment.
- **Never remove or alter** functional/tooling directives (`@ts-expect-error`, `@ts-ignore`, `/// <reference>`, `biome-ignore`, `eslint-disable`, `prettier-ignore`, `@vite-ignore`), `TODO`/`FIXME`/`HACK` notes, or license headers. When cleaning comments, change only comments — never code.
