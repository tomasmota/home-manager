# Format and client compatibility

Read this when writing frontmatter, choosing a client-specific feature, or diagnosing a format failure. Use the portable Agent Skills format by default; add client extensions only when the requested target needs them.

## Portable format

A skill is a directory with a file named exactly `SKILL.md`. Its first line is `---`, followed by YAML frontmatter, a closing `---`, and Markdown instructions. No title, blank line, or byte-order mark precedes the opening delimiter.

| Field | Portable requirements |
| --- | --- |
| `name` | Required, 1–64 characters; matches the parent directory. Prefer ASCII lowercase letters, numbers, and single hyphens for cross-client compatibility. No leading, trailing, or consecutive hyphens. |
| `description` | Required, 1–1024 characters. State the user goal, activation conditions, and important exclusions. Front-load the main use case because some clients shorten descriptions. |
| `license` | Optional license name or reference to the bundled license. Do not invent a license or remove upstream notices. |
| `compatibility` | Optional, 1–500 characters when present. Include actual runtime, system, network, or client requirements, not generic assurances. |
| `metadata` | Optional mapping from string keys to string values. Quote values such as versions; use this for arbitrary descriptive metadata, not working client controls. |
| `allowed-tools` | Experimental, space-separated string in the portable format. Syntax and enforcement vary by client; check the target documentation. |

These are the portable top-level fields recognized by the reference validator. A top-level `version` belongs under `metadata` unless the target explicitly defines it. Do not add optional fields with placeholder values such as `(optional)`.

The standard requires `name` and `description` even if a particular client accepts less. Keep those fields when portability matters. Stay below 500 lines and about 5,000 tokens in the main file; these are context-budget recommendations, not a reason to add filler up to the limit.

## A complete minimal example

The directory containing this example would be named `change-notes`:

```markdown
---
name: change-notes
description: >
  Draft release notes from structured change entries. Use when the user wants
  release notes from a JSON change list. Not for inventing changes or publishing
  a release.
---

# Change Notes

1. Read the supplied JSON list. Each entry needs a type and a description;
   ask for missing required data instead of inventing it.
2. Put feat entries under Features and fix entries under Fixes. Omit chore
   entries and empty sections. Preserve the supplied descriptions.
3. Add a Breaking changes section only for entries whose breaking field is
   explicitly true. A missing flag is not evidence of a breaking change.
4. Return Markdown headings and bullet lists. Do not publish the result.
```

For example, `[{"type":"fix","description":"Handle blank labels"}]` should produce a Fixes section containing that description, with no Features or Breaking changes section. An actual consumer run still needs to verify this behavior; a copyable example is not an evaluation result.

## Resources and paths

- `scripts/`: deterministic or repeatedly recreated executable logic. Prefer existing tools when sufficient.
- `references/`: policies, schemas, examples, and detailed instructions read on demand.
- `assets/`: output templates, images, fonts, and other material used in the deliverable.
- `evals/`: optional test prompts and sanitized fixtures, not live customer data or generated run outputs.

Other files and directories are allowed. Each resource should have a purpose; do not generate empty directories, generic READMEs, or unused templates.

Link resources directly from `SKILL.md` using paths relative to the skill root, and say when each should be read or run. Avoid chains where one reference is the only way to discover another. Add a table of contents when a long reference needs it. Resolve executable paths from the skill's actual directory, not from the user's working directory. Use the target's supported mechanism or an explicitly resolved absolute path in a tool call; do not invent universal variables such as `${SKILL_DIR}` as client interpolation.

## Client-specific features

Client behavior is not part of the portable format merely because one host supports it. Consult the live target documentation before relying on syntax, invocation policy, resource discovery, or reload commands.

| Target | Examples of extensions and checks |
| --- | --- |
| Claude Code | Fields such as `disable-model-invocation`, `user-invocable`, `argument-hint`, and `context: fork`. Dynamic shell context is executable code, not inert Markdown. Use invocation controls for consequential workflows when appropriate, while keeping task authorization explicit. |
| ChatGPT / Codex | Optional `agents/openai.yaml` for interface metadata, tool dependencies, and invocation policy such as `allow_implicit_invocation`. The YAML file does not replace `SKILL.md`. Local directories and installable plugins have different distribution requirements. |
| This workstation / omp | Public source is in the Home Manager checkout; private and team skills retain their existing owners. Do not substitute a vendor's default directory or slash command for the configured local discovery paths. |

`allowed-tools` is not a portable sandbox or an authorization grant. Neither an invocation policy nor skill text replaces host permissions or user approval for side effects. Do not turn on broad permissions to make an evaluation pass.

## Validation and diagnosis

For a portable skill, after all intended files are prepared:

```sh
uvx --from skills-ref agentskills validate "$SKILL_DIR"
```

Here `SKILL_DIR` denotes the actual skill directory, not `SKILL.md` or a ZIP. Substitute the resolved path in a tool call. This command validates common frontmatter and naming, not behavior, bundled code, client configuration, or archive completeness.

- **Missing frontmatter:** inspect the first bytes, delimiters, and YAML syntax.
- **Invalid name:** check length, spelling, hyphens, and the parent directory name.
- **Unexpected fields:** decide whether the field is a typo, arbitrary metadata, or a documented target extension. Do not delete a required client control or move it into inert `metadata` just to obtain a green validator result.
- **Client-specific skill:** validate common fields against the specification and use the target's supported configuration checks and a real invocation. If the portable validator rejects a documented extension, report that limitation explicitly rather than claiming a full portable pass. Any temporary projection used to check common fields is not the delivered skill.
- **Tool version mismatch:** inspect the installed command's help and upstream documentation rather than guessing a replacement executable. Keep using `uvx` or `uv run`; do not fall back to a global package install.

## Authoritative sources

- [Agent Skills specification](https://agentskills.io/specification)
- [Agent Skills authoring best practices](https://agentskills.io/skill-creation/best-practices)
- [Scripts and dependency declarations](https://agentskills.io/skill-creation/using-scripts)
- [Claude Code skill features and frontmatter](https://code.claude.com/docs/en/skills)
- [ChatGPT and Codex skills](https://learn.chatgpt.com/docs/build-skills)
- [OpenAI plugin skill authoring](https://developers.openai.com/plugins/build/skills)
