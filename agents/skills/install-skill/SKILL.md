---
name: install-skill
description: >
  Install or import third-party Agent Skills from a GitHub URL, repo path, or shorthand
  like owner/repo, especially instead of `npx skills add ...`. First classifies ownership
  and publication scope: a portable public skill goes to the canonical `tomasmota/agents`
  checkout (`skills/<name>` plus manifest entry) and reaches this machine only through a
  tested, committed render; a workstation-only public skill goes to a non-generated
  directory under home-manager `agents/skills/`; a private machine-only skill goes to
  `~/.agents/local-skills/`. Asks when publication scope or profiles are unclear. Never
  publishes, commits, or installs to a target the user did not request.
metadata:
  repo_root: /Users/tomas/.config/home-manager
  workstation_skills_dir: /Users/tomas/.config/home-manager/agents/skills
  private_skills_dir: /Users/tomas/.agents/local-skills
  runtime_skills_dir: /Users/tomas/.agents/skills
---

# Install Skill

## When to Use This Skill

Use this skill when the user asks you to:

- install or add an agent skill
- import a skill from GitHub
- vendor a third-party skill into local config
- handle a link that would normally be passed to `npx skills add ...`

Typical inputs:

- `https://github.com/<owner>/<repo>/tree/<ref>/<path>`
- `https://github.com/<owner>/<repo>/blob/<ref>/<path>`
- `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`
- `owner/repo`
- a direct path to `SKILL.md`
- a path to a skill directory

## Classify Destination First

There is no single destination. Before writing anything, classify the skill into exactly one of three owners. Read `~/.config/home-manager/agents/config/README.md` for the current ownership rules; they may have changed since this skill was written.

| Class | Use when | Destination | How it reaches this machine |
| --- | --- | --- | --- |
| Portable public | Public-safe, license permits redistribution, useful on more than this workstation | Canonical public `tomasmota/agents` checkout: `skills/<skill-name>/`, plus a `config/manifest.json` entry with provenance, license and intended profiles | Tested, committed, clean-SHA render consumed by this repo (see below) |
| Workstation-only public | Public-safe but only meaningful on this workstation or platform | Non-generated directory `~/.config/home-manager/agents/skills/<skill-name>/` | Existing `agents.nix` symlink of `~/.agents/skills` to repo `agents/skills` |
| Private machine-only | Private, license-restricted or not for the public repos, or only wanted on this machine | `~/.agents/local-skills/<skill-name>/` | Configured skill path; not tracked in any repo |

Team skills are a separate case: they live in the existing team skills repo checkout linked at `~/.agents/team-skills/`. Edit and deliver them through that repo. Never copy team contents into this repo, the central repo, or `local-skills`.

Decision notes:

- Redistribution: check upstream license before classifying as public. If the license is missing or unclear, do not publish; treat as private or ask.
- If publication scope or intended profiles are unclear, ask one short question before writing. Do not default private or unlicensed material into a public repo.
- Source ownership and installation are separate. A portable skill need not be installed on every profile; the manifest's intended profiles decide that.
- The user's request decides the target. Never install to an additional target, publish, commit, or push on your own initiative.

### Portable public: central repo workflow

Do not write portable skills into home-manager `agents/skills/`. Files for portable skills there are generated output (listed in `agents/config/inventory.mac.json`) and are overwritten by the next render.

1. Locate a **clean** checkout of `tomasmota/agents` (ask where it is if unknown; do not assume a path). Edit only there.
2. Add `skills/<skill-name>/` with the full upstream tree, and register it in `config/manifest.json` with provenance (source URL and revision), license, and intended profiles.
3. Run the central repo's own tests and checks.
4. Committing and pushing the central change is a separate step; do it only when the user asked for it.
5. To consume it here, advance this repo's lock to the committed clean full SHA and render, following "Edit, update and validate" in `agents/config/README.md` (`manage.sh --update <full-SHA>`, then `--check` and the tests).
6. Do not claim that copying files, or pushing centrally, makes the skill available on all profiles. It arrives only through the tested render of a committed SHA for profiles that select it.

If the user wants it only to be usable right now and has not asked for publication, offer the workstation-only or private class instead of silently publishing.

### Workstation-only public: collision check

Check the inventory before any write: `agents/config/inventory.mac.json`.

- Reject the install if `<skill-name>` is a key in either inventory's `skills`, or if any `agents/skills/<skill-name>/...` path appears in either inventory's `artifacts`. Those paths are generated and would be overwritten or flagged by the checker.
- If rejected, report the collision and ask: use another name, change the central source, or choose a different class.
- Also confirm the directory does not already exist (see Conflict Rule).

### Private machine-only

- Destination: `~/.agents/local-skills/<skill-name>/`. Nothing here is tracked in a public repo.
- Check that the name does not collide with a generated or workstation skill (either inventory, or an existing `agents/skills/<skill-name>/`) or an existing team skill, so two skills do not share one name.

## Rules

- Never run `npx skills add ...` for this setup.
- Never clone or copy skills into random temp folders and stop there.
- Always copy the full skill directory, not only `SKILL.md`, when bundled files exist.
- Preserve relative paths for `scripts/`, `references/`, `assets/`, and any other bundled files.
- Keep imported skill contents as close to upstream as possible. Only make minimal edits required for this machine or to fix broken path assumptions.
- If the destination skill already exists, do not overwrite silently unless the user explicitly asked to update, reinstall, or replace it.
- Never overwrite a generated skill (a name or path present in either inventory).
- Never install into `~/.agents/skills` directly unless the user explicitly asks for a one-off manual copy outside repo management. It is a verification target for tracked skills.
- Never store secrets inside imported skill files.
- Never commit, push, publish, or install to a target the user did not request.

## Workflow

### 1. Resolve Source

Start from user input and determine actual skill root.

If input is a GitHub URL:

- Parse owner, repo, ref, and path.
- Accept both `tree` and `blob` URLs.
- If a directory-looking path is pasted with `blob`, try same path as `tree` before assuming the URL is wrong.
- If URL points at `SKILL.md`, skill root is parent directory.
- If URL points at a directory, verify that directory contains `SKILL.md`.

If input is `owner/repo` only:

- Inspect repository for likely skill directories such as `skills/*/SKILL.md`, `.agents/skills/*/SKILL.md`, or `*/SKILL.md`.
- If exactly one obvious skill matches, use it.
- If multiple candidates match, ask one short disambiguation question.

### 2. Inspect Upstream Layout

Determine whether upstream skill is:

- single-file skill: only `SKILL.md`
- bundled skill: `SKILL.md` plus supporting files or directories

Read `SKILL.md` frontmatter.

- Prefer `name` field as canonical skill name.
- Ensure destination directory matches `name`.
- If frontmatter name and directory name disagree, preserve upstream contents but install under frontmatter `name` unless clear evidence says upstream is broken.

Record the upstream license and the exact source revision (commit SHA), since the portable class needs them as manifest provenance.

### 3. Classify and Resolve Destination

Apply "Classify Destination First". Set `<dest>` to the class's directory joined with `<skill-name>`:

- portable public: `<agents-checkout>/skills/<skill-name>/` (plus manifest entry)
- workstation-only public: `~/.config/home-manager/agents/skills/<skill-name>/`
- private machine-only: `~/.agents/local-skills/<skill-name>/`

Run the collision checks for the class before any write.

### 4. Copy Into Destination

Install behavior:

- Create `<dest>` if absent.
- Copy every required file from upstream skill root into `<dest>`.
- Preserve filenames and relative structure.
- Do not add wrapper files unless needed.
- If upstream only ships `SKILL.md`, destination still must be a directory containing that file.

### 5. Machine-Specific Adjustments

Only make edits if required for this machine to use skill correctly.

Allowed examples:

- change hardcoded skill paths to the path expectations of the chosen destination
- update instructions so agents write future files into the chosen destination class's directory
- fix obviously invalid frontmatter or broken relative references

Avoid unnecessary rewrites, stylistic cleanup, or opinionated refactors. Machine-specific edits do not belong in a portable public skill; if they are needed, choose another class or split a small local adapter.

### 6. Validate

Validate installed skill after all files are in place. Use `uvx`; never `pip`, `pipx`, or `python3 -m pip` (the environment is Nix-managed). Load the `use-uvx` skill if unsure.

```bash
uvx --from skills-ref agentskills validate <dest>/
```

Alternative: `uv tool run --from skills-ref agentskills validate <dest>/`

If the validator is unavailable and cannot be run through `uvx`, at minimum verify:

- `SKILL.md` exists at destination root
- file starts with `---`
- frontmatter `name` matches directory name
- any referenced bundled directories exist

For the portable class, also run the central repo's tests, and for the consumer run the checks in `agents/config/README.md` after the lock update.

### 7. Verify Visibility

Verify by class:

- Portable public: after the committed SHA is rendered here, `<skill-name>` appears in the intended profile's inventory (`skills` and `artifacts`) and under `~/.agents/skills/<skill-name>/` through the existing symlink. If not rendered yet, say the skill is not available here yet. Do not claim an installed or active state beyond what was checked.
- Workstation-only public: the skill appears under `~/.agents/skills/<skill-name>/`. If the repo copy exists but the runtime path does not, report that the home-manager symlink may need refresh and mention `agents.nix` manages that link.
- Private machine-only: the skill exists under `~/.agents/local-skills/<skill-name>/`, a configured skill path. A restart or location reload may be needed for the running client; say so rather than assuming.

## GitHub Handling Notes

For GitHub sources, prefer API or raw-content fetches over HTML scraping.

- Use GitHub contents APIs or raw URLs when possible.
- For directory installs, enumerate directory contents recursively and copy whole tree.
- Preserve executable scripts if upstream ships them.
- Ignore `.git`, CI files, screenshots, and repo-wide docs unless they are part of skill directory itself.

## Output To User

Report:

- installed skill name
- chosen class and why (portable public, workstation-only public, or private machine-only)
- source URL or source repo/path (and revision)
- destination path, and for portable skills whether it is committed and rendered here
- whether bundled files were included
- validation result
- visibility result per the class, including anything not done (commit, push, lock update, profile selection)

## Example

User:

`install this skill: https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering/blob/main/skills/context-fundamentals`

Expected behavior:

1. Normalize pasted GitHub path and resolve actual skill root.
2. Fetch `skills/context-fundamentals/` including `SKILL.md` and any bundled files; note license and revision.
3. Classify. If the user has not said whether it is public or which profiles want it, ask. Suppose they say it is only for this workstation and public-safe: check the Mac inventory for a `context-fundamentals` collision, then install into `~/.config/home-manager/agents/skills/context-fundamentals/`. If they want it shared on all profiles, use the central checkout and manifest workflow instead and do not commit unless asked.
4. Validate with `uvx --from skills-ref agentskills validate <dest>/`.
5. Verify visibility as described for the class and report it.

## Conflict Rule

If destination already exists:

- it is generated (in either inventory): stop; never overwrite. Report and ask which class or name to use, or whether the central source should change.
- user said install/add: ask before replacing
- user said update/reinstall/replace/sync from upstream: proceed carefully, preserving any unrelated local files unless user asked for clean replacement
