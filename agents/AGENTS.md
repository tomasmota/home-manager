# Shared agent instructions and skills

This directory owns the public workstation instructions and skills locally.
There is no external source checkout, generator, inventory or render step.

## Sources of truth

- `global/AGENTS.md`: shared user instructions, linked to `~/.agents/AGENTS.md`.
- `skills/<name>/`: public skills, linked together at `~/.agents/skills`.
- `../agents.nix`: generic Home Manager links for the shared sources.
- `../omp/`: native omp configuration, safety rules, extensions and task agents.

## Ownership

- Edit useful public instructions and skills here, including vendored skills.
  Preserve upstream license and revision information when importing a skill.
- Private machine skills belong in `~/.agents/local-skills/`. Never copy their
  contents into this public checkout.
- Team skills belong in the existing team repo at `~/.agents/team-skills/`.
  Edit and deliver them there; never copy them here or into machine-only skills.
- Before adding a skill, check public, private and team names for collisions.
  Ask if publication scope is unclear; never default private material to public.
- Do not commit, push or publish unless the user requests it.

Fresh omp processes discover these shared paths and the configured private/team
skill directories. Native user instructions can shadow the shared instruction
file; do not install a second user `AGENTS.md` under `~/.omp/agent/`.

## Checks

Follow the applicable repository instructions before running checks. Existing
behavior regressions live beside the handoff launcher and omp extensions; see
`../omp/README.md` for their commands. There is no generated-file validation step.
