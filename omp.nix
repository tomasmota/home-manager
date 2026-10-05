# Oh My Pi (omp) — daily-driver candidate alongside OpenCode.
#
# This module is imported on the darwin target only. ~/.omp/agent/config.yml
# is a writable file because omp locks and rewrites it at runtime (a store
# symlink breaks every launch). Ownership is split:
#   - `policy` (safety and plumbing) is reapplied on every switch;
#   - `preferences` (model roles, their fallback chains, UI) are starting
#     values only: they fill missing keys, and anything changed through the
#     TUI or `omp config set` survives a switch.
# agents/omp/merge-config.sh does the merge in place of upstream's whole-file
# copy. `omp config get modelRoles` is the source of truth for live roles.
#
# Model selectors below match the pinned upstream catalog. Account-specific
# availability still needs `omp models` verification after auth-broker logins.
{
  config,
  lib,
  pkgs,
  omp,
  ...
}: let
  ompDir = "${config.xdg.configHome}/home-manager/agents/omp";

  runtime = import ./agents/runtime {
    inherit pkgs;
    home = config.home.homeDirectory;
  };

  # The renderer copies the canonical reviewer at agents/config/lock.json's
  # revision; keep the omp adapter and its relative imports together in-store.
  permissionReviewer = pkgs.runCommand "omp-auto-approve-jev" {} ''
    mkdir -p "$out"
    cp ${./agents/opencode/lib/permission-review}/*.js "$out/"
    cp ${./agents/omp/auto-approve-jev.ts} "$out/auto-approve-jev.ts"
  '';

  # Inco is not an omp builtin. Reuse OpenCode's active Inco key through its
  # documented local credential API at request time (omp caches the stdout in
  # memory only); the key never lands in the store, models.yml or omp's DB.
  incoKey = pkgs.writeShellScript "omp-inco-key" ''
    set -o pipefail
    ${runtime.opencode}/bin/opencode api get /api/credential 2>/dev/null |
      ${pkgs.jq}/bin/jq -er 'first(.data[] | select(.integrationID == "inco" and .active) | .value | select(.type == "key") | .key)'
  '';

  # Mirrors OpenCode's builtin `inco` provider (openai-compatible package,
  # same base URL and literal model id). Inco's public /v1/models reports
  # reasoning_effort unsupported for this SKU, so none is sent.
  models = {
    providers.inco = {
      baseUrl = "https://api.inco.ai/v1";
      api = "openai-completions";
      apiKey = "!${incoKey}";
      models = [
        {
          id = "glm-5.3-flash:fast";
          name = "GLM-5.3-Flash (Fast)";
          reasoning = true;
          input = ["text" "image"];
          cost = {
            input = 0.15;
            output = 0.5;
            cacheRead = 0.03;
            cacheWrite = 0;
          };
          contextWindow = 1000000;
          maxTokens = 131072;
          compat.supportsReasoningEffort = false;
        }
      ];
    };
  };

  yaml = pkgs.formats.yaml {};

  # Reapplied on every switch: wins over anything set at runtime. `yolo` is
  # only safe while both review extensions load, so these stay together.
  policy = {
    # Credential source: the local omp auth broker (see darwin/omp.nix).
    # Loopback only; the bearer token lives in ~/.omp/auth-broker.token.
    auth.broker.url = "http://127.0.0.1:8765";

    # Native typed judgments; Jev is not a tool-calling chat advisor.
    modelRoles.judge = "typesafe/jev-latest";

    # `judge = []`: the native TypeSafe judge has no substitute (a prompted
    # model never follows a native one). `smol = []` keeps the cheap role
    # isolated: without it the `default` chain applies to every chat role
    # that has none, silently upgrading cheap work to a paid model.
    retry.fallbackChains = {
      smol = [];
      judge = [];
    };

    # Steer bundled agents to this workstation's roles without forking their
    # definitions; custom agents keep frontmatter aliases.
    task.agentModelOverrides.reviewer = "@reviewer";
    # Subagent nesting: explicit copy of the upstream default (2 levels).
    task.maxRecursionDepth = 2;

    tools = {
      # The Jev extension reviews executable actions before this native
      # default-allow gate. Explicit bash/MCP denies remain authoritative.
      approvalMode = "yolo";
    };

    bash.patterns = import ./agents/omp/bash-patterns.nix;
    extensions = [
      "${./agents/omp/mcp-policy.ts}"
      "${permissionReviewer}/auto-approve-jev.ts"
    ];
    # Max shared budgets: 30s Jev + 2 x 60s fallback, plus auth overhead.
    extensionHandlers.toolCallTimeoutMs = 180000;

    # OTLP export only initializes with an endpoint configured; off anyway.
    telemetry.otlpExportEnabled = false;

    skills.customDirectories = [
      "~/.agents/local-skills"
      "~/.agents/team-skills"
    ];

    # Background chat advice is distinct from Jev permission review.
    advisor.enabled = false;
  };

  # Starting values only: fill keys missing from the live file. Change roles
  # day to day with /model or `omp config set modelRoles <record>` (README).
  preferences = {
    modelRoles = {
      # Root default: OpenAI Sol, high reasoning (OpenCode parity).
      default = "openai-codex/gpt-6.1-sol:high";
      # Cheap/quick workloads: bundled sonic (mechanical) + scout
      # (read-only exploration) both resolve @smol. The `:fast` suffix
      # is part of Inco's literal model id (OpenCode parity), not a
      # thinking level; see models.yml above.
      smol = "inco/glm-5.3-flash:fast";
      # Hard reasoning: deep profile + bundled reviewer/security-reviewer
      # fallback tier.
      slow = "anthropic/claude-opus-5-5:xhigh";
      # Bundled `task` agent (general-purpose fan-out).
      task = "anthropic/claude-sonnet-5-5:high";
      # Implementation (custom coder agent).
      coder = "anthropic/claude-opus-5-5:high";
      # Terminal-driven investigation (custom terminal agent).
      terminal = "openai-codex/gpt-6.1-sol:xhigh";
      # Bundled `reviewer` retargeted via task.agentModelOverrides.
      reviewer = "openai-codex/gpt-6.1-sol:xhigh";
      # Keyless Exa (public MCP unless an Exa credential exists), OpenCode's
      # websearch provider. Unset fallbacks keep the rest of the built-in
      # web priority list as non-explicit backups.
      web = "web/exa";
    };

    # Reactive quota fallback (OpenCode proactive <20% polling has no omp
    # equivalent): rescues the turn on 429/quota, primary restored later.
    # Role-keyed so bundled and custom subagents inherit their role's chain.
    # OpenAI-side roles fall back to Anthropic and vice versa, at the role's
    # own effort. Revisit a chain when its role's model changes.
    retry.fallbackChains = {
      default = ["anthropic/claude-opus-5-5:high"];
      terminal = ["anthropic/claude-opus-5-5:xhigh"];
      reviewer = ["anthropic/claude-opus-5-5:xhigh"];
      slow = ["openai-codex/gpt-6.1-sol:xhigh"];
      task = ["openai-codex/gpt-6.1-sol:high"];
      coder = ["openai-codex/gpt-6.1-sol:high"];
    };

    # `auto` and Smart stop detection both ride the judge role (one Jev
    # judgment per classified turn / text-only stop).
    defaultThinkingLevel = "auto";
    features.unexpectedStopDetection = "smart";
    hideThinkingBlock = true;

    compaction.keepRecentTokens = 12000;

    theme.dark = "dark-catppuccin";
  };

  mergeConfig = pkgs.writeShellScript "omp-merge-config" ''
    export PATH=${lib.makeBinPath [pkgs.yq-go pkgs.coreutils]}:$PATH
    exec ${pkgs.bash}/bin/bash ${./agents/omp/merge-config.sh} "$@"
  '';
in {
  imports = [omp.homeManagerModules.default];

  config = {
    programs.omp = {
      enable = true;
      settings = policy;
    };

    # Replaces upstream's whole-file copy of `settings` with the
    # preferences/live/policy merge (see the header comment).
    home.activation.ompConfig = lib.mkForce (lib.hm.dag.entryAfter ["writeBoundary"] ''
      run ${mergeConfig} ${yaml.generate "omp-preferences.yml" preferences} \
        ${yaml.generate "omp-policy.yml" policy} "$HOME/.omp/agent/config.yml"
    '');

    # MCP commands atomically replace the pathname, so use a writable copy
    # rather than a home.file symlink. Restore the declared servers on switch.
    home.activation.ompMcp = lib.hm.dag.entryAfter ["writeBoundary"] ''
      run mkdir -p "$HOME/.omp/agent"
      run install -m 600 ${./agents/omp/mcp.json} "$HOME/.omp/agent/mcp.json"
    '';

    home.file = {
      # omp only reads models.yml, so a read-only store file is safe.
      ".omp/agent/models.yml".source =
        (pkgs.formats.yaml {}).generate "omp-models.yml" models;

      # Sticky rules: read-only for omp, safe to link into the checkout.
      ".omp/agent/RULES.md".source =
        config.lib.file.mkOutOfStoreSymlink "${ompDir}/RULES.md";

      # Custom task agents for the OpenCode profiles with no bundled
      # equivalent (coder, terminal, deep). The bundled task/sonic/scout/
      # reviewer/security-reviewer agents cover general/quick/explore/review
      # through modelRoles and task.agentModelOverrides instead of forks.
      ".omp/agent/agents".source =
        config.lib.file.mkOutOfStoreSymlink "${ompDir}/agents";
    };
  };
}
