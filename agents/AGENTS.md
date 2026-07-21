# This machine
- My terminal is ghostty
- Almost everything is configured using home-manager. All config is located at `~/.config/home-manager/`. If I ask you to change some configuration in home-manager, this is where you will find it. Read `~/.config/home-manager/AGENTS.md` for more information.

# Tips for you
- if you want to run kubectl commands, first check my contexts with `kubectl config get-contexts`
- if you want to run commands in a context, use `kubectl --context`, not `kubectl config use-context`
- For read-only GitLab API requests, always use `glab api --method GET <endpoint>`. Do not rely on the implicit method, add request-body flags, or specify another method later in the command.
- it's more important to me that you give me accurate information, than being quick to answer. I would rather you take a long time but do good reasearch with google search tools and reading as much documentation as possible and adequate
- Never use the `gemini_quota` tool. It can inspect the active local Google Cloud project, which may be work-related and unrelated to the user's personal projects.

# Local-only skills
- If I ask for a skill that should stay only on this machine or should not live in the public home-manager repo, create it under `~/.agents/local-skills/`.
- Only put shared/public skills in `~/.config/home-manager/agents/skills/`.

# Git
- never commit or push changes for me unless explicitly asked to
