# Oh My Pi (omp) — daily-driver candidate alongside OpenCode.
#
# This module is imported on the darwin target only. Settings are declarative:
# the upstream Home Manager module writes them
# to ~/.omp/agent/config.yml as a writable copy because omp locks and rewrites
# that file at runtime (a store symlink breaks every launch). Runtime-persisted
# changes to config.yml are therefore overwritten on each `darwin-rebuild
# switch`, matching this repo's repo-is-source-of-truth policy for agent tools.
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

  # Inco is not an omp builtin. Reuse OpenCode's active Inco key through its
  # documented local credential API at request time (omp caches the stdout in
  # memory only); the key never lands in the store, models.yml or omp's DB.
  incoKey = pkgs.writeShellScript "omp-inco-key" ''
    set -o pipefail
    ${config.home.profileDirectory}/bin/opencode api get /api/credential 2>/dev/null |
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
in {
  imports = [omp.homeManagerModules.default];

  config = {
    programs.omp = {
      enable = true;
      settings = {
        # Credential source: the local omp auth broker (see darwin/omp.nix).
        # Loopback only; the bearer token lives in ~/.omp/auth-broker.token.
        auth.broker.url = "http://127.0.0.1:8765";

        modelRoles = {
          # Root default: OpenAI Sol, high reasoning (OpenCode parity).
          default = "openai-codex/gpt-6.1-sol:high";
          # Cheap/quick workloads: bundled sonic (mechanical) + scout
          # (read-only exploration) both resolve @smol. The `:fast` suffix
          # is part of Inco's literal model id (OpenCode parity), not a
          # thinking level; see models.yml below.
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
          # Bundled `reviewer` retargeted to Sol xhigh via
          # task.agentModelOverrides below (OpenCode reviewer profile).
          reviewer = "openai-codex/gpt-6.1-sol:xhigh";
          # Native typed judgments; Jev is not a tool-calling chat advisor.
          judge = "typesafe/jev-latest";
        };

        # Steer bundled agents to this workstation's model choices without
        # forking their definitions; custom agents keep frontmatter aliases.
        task.agentModelOverrides.reviewer = "@reviewer";

        defaultThinkingLevel = "high";
        hideThinkingBlock = true;

        # Reactive quota fallback (OpenCode proactive <20% polling has no omp
        # equivalent): rescues the turn on 429/quota, primary restored later.
        retry.fallbackChains = {
          "openai-codex/*" = ["anthropic/claude-opus-5-5"];
          "anthropic/*" = ["openai-codex/gpt-6.1-sol:high"];
        };

        tools = {
          # Unknown MCP tools prompt in the parent even if the policy fails.
          # Headless task children have an upstream yolo-mode limitation.
          # Explicit local-write grants preserve the usual coding workflow.
          approvalMode = "always-ask";
          approval = {
            write = "allow";
            edit = "allow";
            ast_edit = "allow";
            # bash.patterns cannot gate the eval tool's own shell path.
            eval = "prompt";
          };
        };

        bash.patterns = import ./agents/omp/bash-patterns.nix;
        extensions = ["${./agents/omp/mcp-policy.ts}"];

        compaction.keepRecentTokens = 12000;

        theme.dark = "dark-catppuccin";

        # OTLP export only initializes with an endpoint configured; off anyway.
        telemetry.otlpExportEnabled = false;

        skills.customDirectories = [
          "~/.agents/local-skills"
          "~/.agents/team-skills"
        ];

        # Background chat advice is distinct from Jev permission review.
        advisor.enabled = false;
      };
    };

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
