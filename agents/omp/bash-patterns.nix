[
  {
    match = "tofu apply*";
    approval = "deny";
  }
  {
    match = "tofu destroy*";
    approval = "deny";
  }
  {
    match = "tofu state rm*";
    approval = "deny";
  }
  {
    match = "glab auth revoke*";
    approval = "deny";
  }
  {
    match = "glab auth logout*";
    approval = "deny";
  }
  {
    match = "glab* delete*";
    approval = "deny";
  }
  {
    match = "glab* archive*";
    approval = "deny";
  }
  {
    match = "glab* revoke*";
    approval = "deny";
  }
  {
    match = "gcloud projects delete*";
    approval = "deny";
  }
  {
    match = "gcloud auth revoke*";
    approval = "deny";
  }
  {
    match = "~/.agents/local-skills/show-me/show-mermaid*";
    approval = "allow";
  }
  {
    match = "/Users/tomas/.agents/local-skills/show-me/show-mermaid*";
    approval = "allow";
  }
  {
    match = "ls*";
    approval = "allow";
  }
  {
    match = "dig*";
    approval = "allow";
  }
  {
    match = "delv*";
    approval = "allow";
  }
  {
    match = "wt*";
    approval = "allow";
  }
  {
    match = "cat*";
    approval = "allow";
  }
  {
    match = "head*";
    approval = "allow";
  }
  {
    match = "tail*";
    approval = "allow";
  }
  {
    match = "wc*";
    approval = "allow";
  }
  {
    match = "file*";
    approval = "allow";
  }
  {
    match = "stat*";
    approval = "allow";
  }
  {
    match = "du*";
    approval = "allow";
  }
  {
    match = "df*";
    approval = "allow";
  }
  {
    match = "pwd*";
    approval = "allow";
  }
  {
    match = "which*";
    approval = "allow";
  }
  {
    match = "whoami*";
    approval = "allow";
  }
  {
    match = "hostname*";
    approval = "allow";
  }
  {
    match = "date*";
    approval = "allow";
  }
  {
    match = "rg*";
    approval = "allow";
  }
  {
    match = "grep*";
    approval = "allow";
  }
  {
    match = "find*";
    approval = "allow";
  }
  {
    match = "fd*";
    approval = "allow";
  }
  {
    match = "jq*";
    approval = "allow";
  }
  {
    match = "yq*";
    approval = "allow";
  }
  {
    match = "diff*";
    approval = "allow";
  }
  {
    match = "echo*";
    approval = "allow";
  }
  {
    match = "printf*";
    approval = "allow";
  }
  {
    match = "test*";
    approval = "allow";
  }
  {
    match = "true*";
    approval = "allow";
  }
  {
    match = "false*";
    approval = "allow";
  }
  {
    match = "uname*";
    approval = "allow";
  }
  {
    match = "dirname*";
    approval = "allow";
  }
  {
    match = "basename*";
    approval = "allow";
  }
  {
    match = "realpath*";
    approval = "allow";
  }
  {
    match = "readlink*";
    approval = "allow";
  }
  {
    match = "less*";
    approval = "allow";
  }
  {
    match = "tree*";
    approval = "allow";
  }
  {
    match = "cut*";
    approval = "allow";
  }
  {
    match = "sort*";
    approval = "allow";
  }
  {
    match = "uniq*";
    approval = "allow";
  }
  {
    match = "tr*";
    approval = "allow";
  }
  {
    match = "npm*";
    approval = "allow";
  }
  {
    match = "pnpm*";
    approval = "allow";
  }
  {
    match = "nix*";
    approval = "allow";
  }
  {
    match = "cargo*";
    approval = "allow";
  }
  {
    match = "go*";
    approval = "allow";
  }
  {
    match = "make*";
    approval = "allow";
  }
  {
    match = "pytest*";
    approval = "allow";
  }
  {
    match = "uv*";
    approval = "allow";
  }
  {
    match = "uvx*";
    approval = "allow";
  }
  {
    match = "python3 -m py_compile*";
    approval = "allow";
  }
  {
    match = "python3 --version*";
    approval = "allow";
  }
  {
    match = "bash -n*";
    approval = "allow";
  }
  {
    match = "bash -o noexec*";
    approval = "allow";
  }
  {
    match = "bash --version*";
    approval = "allow";
  }
  {
    match = "zsh -n*";
    approval = "allow";
  }
  {
    match = "node -c*";
    approval = "allow";
  }
  {
    match = "node --check*";
    approval = "allow";
  }
  {
    match = "node --version*";
    approval = "allow";
  }
  {
    match = "tofu -help*";
    approval = "allow";
  }
  {
    match = "tofu --help*";
    approval = "allow";
  }
  {
    match = "tofu -version*";
    approval = "allow";
  }
  {
    match = "tofu --version*";
    approval = "allow";
  }
  {
    match = "tofu version*";
    approval = "allow";
  }
  {
    match = "tofu plan*";
    approval = "allow";
  }
  {
    match = "tofu init*";
    approval = "allow";
  }
  {
    match = "tofu fmt*";
    approval = "allow";
  }
  {
    match = "tofu validate*";
    approval = "allow";
  }
  {
    match = "tofu graph*";
    approval = "allow";
  }
  {
    match = "tofu metadata functions*";
    approval = "allow";
  }
  {
    match = "tofu show*";
    approval = "allow";
  }
  {
    match = "tofu output*";
    approval = "allow";
  }
  {
    match = "tofu providers";
    approval = "allow";
  }
  {
    match = "tofu providers -*";
    approval = "allow";
  }
  {
    match = "tofu state list*";
    approval = "allow";
  }
  {
    match = "tofu state show*";
    approval = "allow";
  }
  {
    match = "tofu state pull*";
    approval = "allow";
  }
  {
    match = "tofu workspace list*";
    approval = "allow";
  }
  {
    match = "tofu workspace show*";
    approval = "allow";
  }
  {
    match = "tofu providers schema*";
    approval = "allow";
  }
  {
    match = "git *";
    approval = "allow";
  }
  {
    match = "glab help*";
    approval = "allow";
  }
  {
    match = "glab --version*";
    approval = "allow";
  }
  {
    match = "glab version*";
    approval = "allow";
  }
  {
    match = "glab auth status*";
    approval = "allow";
  }
  {
    match = "glab config get*";
    approval = "allow";
  }
  {
    match = "glab config list*";
    approval = "allow";
  }
  {
    match = "glab alias list*";
    approval = "allow";
  }
  {
    match = "glab* list*";
    approval = "allow";
  }
  {
    match = "glab* view*";
    approval = "allow";
  }
  {
    match = "glab* status*";
    approval = "allow";
  }
  {
    match = "glab* search*";
    approval = "allow";
  }
  {
    match = "glab* diff*";
    approval = "allow";
  }
  {
    match = "glab* lint*";
    approval = "allow";
  }
  {
    match = "glab api --method GET*";
    approval = "allow";
  }
  {
    match = "glab api -X GET*";
    approval = "allow";
  }
  {
    match = "glab api --help*";
    approval = "allow";
  }
  {
    match = "glab mr*";
    approval = "allow";
  }
  {
    match = "gh* list*";
    approval = "allow";
  }
  {
    match = "gh* view*";
    approval = "allow";
  }
  {
    match = "gh* status*";
    approval = "allow";
  }
  {
    match = "gh* search*";
    approval = "allow";
  }
  {
    match = "gcloud version*";
    approval = "allow";
  }
  {
    match = "gcloud config list*";
    approval = "allow";
  }
  {
    match = "gcloud config get-value*";
    approval = "allow";
  }
  {
    match = "gcloud auth list*";
    approval = "allow";
  }
  {
    match = "gcloud services list*";
    approval = "allow";
  }
  {
    match = "gcloud asset search-all-resources*";
    approval = "allow";
  }
  {
    match = "gcloud* list*";
    approval = "allow";
  }
  {
    match = "gcloud* describe*";
    approval = "allow";
  }
  {
    match = "gcloud storage ls*";
    approval = "allow";
  }
  {
    match = "gcloud logging read*";
    approval = "allow";
  }
  {
    match = "gcloud* get-iam-policy*";
    approval = "allow";
  }
  {
    match = "gcloud identity groups memberships check-transitive-membership*";
    approval = "allow";
  }
  {
    match = "gcloud policy-troubleshoot iam *";
    approval = "allow";
  }
  {
    match = "kubectl --version*";
    approval = "allow";
  }
  {
    match = "kubectl* get*";
    approval = "allow";
  }
  {
    match = "kubectl* describe*";
    approval = "allow";
  }
  {
    match = "kubectl* explain*";
    approval = "allow";
  }
  {
    match = "kubectl* diff*";
    approval = "allow";
  }
  {
    match = "kubectl* logs*";
    approval = "allow";
  }
  {
    match = "kubectl* top*";
    approval = "allow";
  }
  {
    match = "kubectl* events*";
    approval = "allow";
  }
  {
    match = "kubectl* version*";
    approval = "allow";
  }
  {
    match = "kubectl* cluster-info*";
    approval = "allow";
  }
  {
    match = "kubectl* api-resources*";
    approval = "allow";
  }
  {
    match = "kubectl* api-versions*";
    approval = "allow";
  }
  {
    match = "kubectl* config view*";
    approval = "allow";
  }
  {
    match = "kubectl* config current-context*";
    approval = "allow";
  }
  {
    match = "kubectl* config get-contexts*";
    approval = "allow";
  }
  {
    match = "helm --version*";
    approval = "allow";
  }
  {
    match = "helm list*";
    approval = "allow";
  }
  {
    match = "helm ls*";
    approval = "allow";
  }
  {
    match = "helm search*";
    approval = "allow";
  }
  {
    match = "helm show*";
    approval = "allow";
  }
  {
    match = "helm status*";
    approval = "allow";
  }
  {
    match = "helm get*";
    approval = "allow";
  }
  {
    match = "helm version*";
    approval = "allow";
  }
  {
    match = "helm history*";
    approval = "allow";
  }
  {
    match = "helm template*";
    approval = "allow";
  }
  {
    match = "helm lint*";
    approval = "allow";
  }
  {
    match = "helm env*";
    approval = "allow";
  }
  {
    match = "cmctl version*";
    approval = "allow";
  }
  {
    match = "cmctl --version*";
    approval = "allow";
  }
  {
    match = "istioctl version*";
    approval = "allow";
  }
  {
    match = "istioctl --version*";
    approval = "allow";
  }
  {
    match = "argocd version*";
    approval = "allow";
  }
  {
    match = "argocd --version*";
    approval = "allow";
  }
  {
    match = "tmux*";
    approval = "allow";
  }
  {
    match = "minions-tools*";
    approval = "allow";
  }
]
