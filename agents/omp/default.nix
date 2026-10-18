# Oh My Pi (omp), Mac only. Native configuration lives here; standard shared
# instructions and public skills are owned in the parent directory.
#
# ~/.omp/agent/config.yml is a writable file because omp locks and rewrites it
# at runtime. merge-config.sh rebuilds it on every switch as
# `preferences * live * policy`: `policy` is reapplied, `preferences` only seed
# keys the live file lacks, so UI changes made in the TUI survive a switch.
# Model roles, fallback chains and agent model overrides are not managed here.
{
  config,
  lib,
  pkgs,
  omp,
  ...
}: let
  ompDir = "${config.xdg.configHome}/home-manager/agents/omp";
  yaml = pkgs.formats.yaml {};

  # Directory interpolation alone does not check that imported modules exist.
  # Fail during evaluation if Git's flake snapshot omits a new runtime file.
  jevDir = assert lib.assertMsg
  (builtins.all (name: builtins.pathExists (./jev + "/${name}")) [
    "jev-client.js"
    "tmux-title.ts"
    "tmux-title-core.js"
    "tmux-status.ts"
    "tmux-status-core.js"
  ])
  "omp: Jev extension modules are missing from the flake source; git add the new modules before rebuilding.";
    ./jev;

  # Inco is not an omp builtin. INCO_API_KEY comes from secrets.env (sourced
  # by zsh). Standard model metadata advertises reasoning_effort support.
  # Keep the existing `:fast` route for callers that select it explicitly.
  models = {
    providers.inco = {
      baseUrl = "https://api.inco.ai/v1";
      api = "openai-completions";
      apiKey = "INCO_API_KEY";
      models = [
        {
          id = "glm-5.3";
          name = "GLM 5.3";
          reasoning = true;
          input = ["text"];
          cost = {
            input = 1.4;
            output = 4.4;
            cacheRead = 0.26;
            cacheWrite = 0;
          };
          contextWindow = 1048576;
          compat.supportsReasoningEffort = true;
        }
        {
          id = "glm-5.3-flash";
          name = "GLM 5.3 Flash";
          reasoning = true;
          input = ["text"];
          cost = {
            input = 0.15;
            output = 0.5;
            cacheRead = 0.03;
            cacheWrite = 0;
          };
          contextWindow = 1048576;
          compat.supportsReasoningEffort = true;
        }
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

  # Reapplied on every switch: wins over anything set at runtime.
  policy = {
    # Native absolute denies plus the session-scoped infrastructure guard.
    tools.approvalMode = "yolo";
    todo.enabled = false;
    bash.patterns =
      map (match: {
        inherit match;
        approval = "deny";
      }) ([
          "glab auth revoke*"
          "glab auth logout*"
          "gh auth logout*"
          "gh auth revoke*"
          "glab repo delete*"
          "glab repo archive*"
          "glab repo transfer*"
          "gh repo delete*"
          "gh repo archive*"
          "gh repo transfer*"
          "gcloud* projects delete *"
          "gcloud auth revoke*"
          "git push*--force* main"
          "git push*--force* master"
          "git push*-f * main"
          "git push*-f * master"
          "git push* +main*"
          "git push* +master*"
        ]
        ++ lib.concatMap (verb: [
          "gcloud* organizations ${verb} *"
          "gcloud* resource-manager folders ${verb} *"
          "gcloud* org-policies ${verb} *"
        ]) [
          "create"
          "delete"
          "update"
          "move"
          "set-iam-policy"
          "add-iam-policy-binding"
          "remove-iam-policy-binding"
          "set-policy"
          "reset"
          "enable-enforce"
          "disable-enforce"
          "undelete"
        ]);
    extensions = [
      "${./guard.ts}"
      "${jevDir}/tmux-title.ts"
      "${jevDir}/tmux-status.ts"
      "${./status-line.ts}"
      "${./brief/brief.ts}"
    ];

    # Public skills use standard ~/.agents discovery; private/team stay private.
    skills = {
      customDirectories = [
        "~/.agents/local-skills"
        "~/.agents/team-skills"
      ];
    };
  };

  # Starting values only: fill keys missing from the live file.
  preferences = {
    defaultThinkingLevel = "auto";
    features.unexpectedStopDetection = "smart";
    hideThinkingBlock = true;
    compaction.keepRecentTokens = 12000;
    theme.dark = "dark-catppuccin";

    statusLine = {
      preset = "custom";
      leftSegments = ["pi" "vim" "model" "mode" "collab" "stream" "path" "git" "pr" "status" "token_rate"];
      rightSegments = ["session_name"];
      separator = "powerline-thin";
      showHookStatus = false;
      segmentOptions = {
        model.showThinkingLevel = true;
        path = {
          abbreviate = true;
          maxLength = 40;
          stripWorkPrefix = true;
        };
        git = {
          showBranch = true;
          showStaged = true;
          showUnstaged = true;
          showUntracked = true;
        };
      };
    };
  };

  mergeConfig = pkgs.writeShellScript "omp-merge-config" ''
    export PATH=${lib.makeBinPath [pkgs.yq-go pkgs.coreutils]}:$PATH
    exec ${pkgs.bash}/bin/bash ${./merge-config.sh} "$@"
  '';

  # Autoload the pinned completion without starting omp in every shell.
  ompZshCompletion = pkgs.runCommand "omp-zsh-completion" {} ''
    mkdir -p "$out/share/zsh/site-functions"
    export HOME="$(mktemp -d)"
    ${config.programs.omp.package}/bin/omp completions zsh > "$out/share/zsh/site-functions/_omp"
  '';
in {
  imports = [omp.homeManagerModules.default ./brief];

  programs.omp = {
    enable = true;
    settings = policy;
  };

  home = {
    packages = [ompZshCompletion];

    # Replaces upstream's whole-file copy of `settings` with the merge above.
    activation.ompConfig = lib.mkForce (lib.hm.dag.entryAfter ["writeBoundary"] ''
      run ${mergeConfig} ${yaml.generate "omp-preferences.yml" preferences} \
        ${yaml.generate "omp-policy.yml" policy} "$HOME/.omp/agent/config.yml"
    '');

    # `/mcp` commands atomically replace this pathname, so install a writable
    # copy; runtime server edits are reset on switch.
    activation.ompMcp = lib.hm.dag.entryAfter ["writeBoundary"] ''
      run mkdir -p "$HOME/.omp/agent"
      run install -m 600 ${./mcp.json} "$HOME/.omp/agent/mcp.json"
    '';

    file = {
      ".omp/agent/models.yml".source = yaml.generate "omp-models.yml" models;
      ".omp/agent/google-developer-knowledge.mjs".source =
        config.lib.file.mkOutOfStoreSymlink "${ompDir}/google-developer-knowledge.mjs";
      # Sticky rules use omp's native standard rules mechanism, not user-context
      # shadowing. Shared instructions come from ~/.agents/AGENTS.md.
      ".omp/agent/RULES.md".source = config.lib.file.mkOutOfStoreSymlink "${ompDir}/RULES.md";
      ".omp/agent/agents".source = config.lib.file.mkOutOfStoreSymlink "${ompDir}/agents";
    };
  };
}
