---
name: install-skill
description: >
  Install or import third-party Agent Skills into Tomás' home-manager-managed repo.
  Use when asked to install, add, import, vendor, or copy a skill from a GitHub URL,
  repo path, or shorthand like owner/repo, especially instead of `npx skills add ...`.
  Places skills in `~/.config/home-manager/agents/skills/<skill-name>/` so they appear
  in `~/.agents/skills/` through the existing `agents.nix` symlink.
metadata:
  repo_root: /Users/tomas/.config/home-manager
  canonical_skills_dir: /Users/tomas/.config/home-manager/agents/skills
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

## Local Source Of Truth

Install into repo source, not runtime mirror.

- Canonical location: `~/.config/home-manager/agents/skills/<skill-name>/`
- Runtime mirror: `~/.agents/skills/<skill-name>/`

`agents.nix` already symlinks `~/.agents/skills` to repo `agents/skills`. Treat `~/.agents/skills` as verification target only. Do not install there directly unless user explicitly asks for a one-off manual copy outside repo management.

## Rules

- Never run `npx skills add ...` for this setup.
- Never clone or copy skills into random temp folders and stop there.
- Always copy the full skill directory, not only `SKILL.md`, when bundled files exist.
- Preserve relative paths for `scripts/`, `references/`, `assets/`, and any other bundled files.
- Keep imported skill contents as close to upstream as possible. Only make minimal edits required for this machine or to fix broken path assumptions.
- If destination skill already exists, do not overwrite silently unless user explicitly asked to update, reinstall, or replace it.
- Never store secrets inside imported skill files.

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

### 3. Copy Into Repo

Destination must be:

`~/.config/home-manager/agents/skills/<skill-name>/`

Install behavior:

- Create destination directory if absent.
- Copy every required file from upstream skill root into destination.
- Preserve filenames and relative structure.
- Do not add wrapper files unless needed.
- If upstream only ships `SKILL.md`, destination still must be a directory containing that file.

### 4. Machine-Specific Adjustments

Only make edits if required for this machine to use skill correctly.

Allowed examples:

- change hardcoded skill paths to repo-managed path expectations
- update instructions so agents write future files into `~/.config/home-manager/agents/skills/`
- fix obviously invalid frontmatter or broken relative references

Avoid unnecessary rewrites, stylistic cleanup, or opinionated refactors.

### 5. Validate

Validate installed skill after all files are in place.

Preferred validation:

```bash
uv tool run --from skills-ref agentskills validate ~/.config/home-manager/agents/skills/<skill-name>/
```

Shorthand variant if available:

```bash
uvx --from skills-ref agentskills validate ~/.config/home-manager/agents/skills/<skill-name>/
```

Fallback if `uv` unavailable:

```bash
python3 -m pip install -q skills-ref
agentskills validate ~/.config/home-manager/agents/skills/<skill-name>/
```

If validator is unavailable and cannot be installed, at minimum verify:

- `SKILL.md` exists at destination root
- file starts with `---`
- frontmatter `name` matches directory name
- any referenced bundled directories exist

### 6. Verify Runtime Path

Confirm installed skill also appears under:

`~/.agents/skills/<skill-name>/`

If repo copy exists but runtime path does not, report that home-manager symlink may need refresh and mention `agents.nix` manages that link.

## GitHub Handling Notes

For GitHub sources, prefer API or raw-content fetches over HTML scraping.

- Use GitHub contents APIs or raw URLs when possible.
- For directory installs, enumerate directory contents recursively and copy whole tree.
- Preserve executable scripts if upstream ships them.
- Ignore `.git`, CI files, screenshots, and repo-wide docs unless they are part of skill directory itself.

## Output To User

Report:

- installed skill name
- source URL or source repo/path
- repo destination path
- whether bundled files were included
- validation result
- whether skill is visible under `~/.agents/skills/`

## Example

User:

`install this skill: https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering/blob/main/skills/context-fundamentals`

Expected behavior:

1. Normalize pasted GitHub path and resolve actual skill root.
2. Fetch `skills/context-fundamentals/` including `SKILL.md` and any bundled files.
3. Install into `~/.config/home-manager/agents/skills/context-fundamentals/`.
4. Validate skill.
5. Confirm presence at `~/.agents/skills/context-fundamentals/`.

## Conflict Rule

If destination already exists:

- user said install/add: ask before replacing
- user said update/reinstall/replace/sync from upstream: proceed carefully, preserving any unrelated local files unless user asked for clean replacement
