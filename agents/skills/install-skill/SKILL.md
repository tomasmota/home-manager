---
name: install-skill
description: >
  Install or import third-party Agent Skills from a GitHub URL, repo path, or
  shorthand like owner/repo, especially instead of `npx skills add ...`.
  Choose local public repo, private machine or team ownership before writing;
  preserve bundled resources, upstream license and source revision. Never
  publish, commit or install to a target the user did not request.
metadata:
  repo_root: /Users/tomas/.config/home-manager
  workstation_skills_dir: /Users/tomas/.config/home-manager/agents/skills
  private_skills_dir: /Users/tomas/.agents/local-skills
  runtime_skills_dir: /Users/tomas/.agents/skills
---

# Install Skill

Use for requests to install/add a skill, import a skill from GitHub, or vendor a
third-party skill into local configuration. Do not run `npx skills add ...`.

## Choose the owner first

Read `~/.config/home-manager/agents/AGENTS.md` for the current ownership rules.

| Owner | Use when | Destination | Discovery |
| --- | --- | --- | --- |
| Public repo | Public-safe and licensed for redistribution, portable or workstation-specific | `~/.config/home-manager/agents/skills/<name>/` | `agents.nix` links this tree at `~/.agents/skills` |
| Private machine | Private, license-restricted, or not intended for publication | `~/.agents/local-skills/<name>/` | Configured private skill directory |
| Team | Owned by the team | Existing team repo at `~/.agents/team-skills/<name>/` | Configured team skill directory |

- Ask one short question if publication scope is unclear. Never default private
  or unlicensed material into this public repo.
- Team skills stay in their existing repo. Never copy team contents into the
  public repo or machine-only skills.
- Check names across public, private and team skill directories before writing.
  Duplicate names cause competing discovery; choose one owner per name.
- Write public skills in the repo source, not directly through the runtime link.
- Do not commit, push, publish or install to additional targets without a request.

## Workflow

### 1. Resolve the source

Accept GitHub `tree`, `blob` and raw-content URLs, `owner/repo`, a `SKILL.md`
path, or a skill directory. The skill root is the directory containing `SKILL.md`.
If a directory-looking URL uses `blob`, try the same path with `tree` first.
For a repo-only input, inspect likely skill directories; ask which skill if
multiple candidates match. Prefer GitHub contents APIs or raw content to HTML.
Resolve and record the exact upstream commit SHA, not just a moving branch name.

### 2. Inspect contents and licensing

Read `SKILL.md` and enumerate the whole skill directory recursively. Determine
whether it contains only the skill file or also scripts, references and assets.
Check the upstream license before selecting public ownership. If the license is
missing or unclear, do not publish; ask or choose private ownership.

Use the frontmatter `name` as the destination directory name. If the directory
and name disagree, preserve upstream content and use the declared name unless
there is evidence that the upstream skill is broken.

### 3. Resolve conflicts

Apply the ownership and name-collision rules above before writing. If the
selected destination already exists:

- For an install/add request, ask before replacing it.
- For an update/reinstall/replace/sync request, update carefully; preserve
  unrelated local files unless the user asked for a clean replacement.
- For a collision with another owner, report it and resolve the owner/name first.

### 4. Copy the complete skill

Create the destination if absent, then copy all required files and preserve
relative paths, filenames and executable permissions. Bundled resources are
part of the skill; never copy just `SKILL.md` when it references other files.
Ignore `.git`, CI and repo-wide material unless required by the skill itself.
Never store secrets inside a skill.

Keep content close to upstream. Make only edits required for correct paths,
local ownership rules or invalid frontmatter. Record the source URL, commit SHA
and license in skill metadata or existing documentation; preserve license files.
Do not add wrappers or a separate registry to make a skill discoverable.

### 5. Validate after all files are ready

Use `uvx`, not pip, pipx or system Python package installation:

```sh
uvx --from skills-ref agentskills validate <destination>/
```

Load the `use-uvx` skill if needed. Fix reported errors before delivery. If this
validator is unavailable, state that and at minimum inspect the opening YAML
frontmatter, matching name, `SKILL.md` location and referenced resource paths.
Do not claim validation that was not exercised.

### 6. Check visibility

- Public: `~/.agents/skills/<name>/` should resolve to the repo source. If the
  runtime link is absent, mention that `agents.nix` manages it; do not claim it
  is installed or active yet.
- Private/team: inspect the chosen configured directory without copying its
  contents elsewhere.
- Fresh omp processes discover these paths; an existing session may need
  `/reload-plugins` to refresh skill discovery.

## Delivery

Report the name, selected owner and rationale, source URL/revision, destination,
bundled resources, validation and visibility results. Name steps not performed,
such as publication or a Home Manager switch. Never substitute an unrequested
commit/push or installation into another owner for the requested local import.
