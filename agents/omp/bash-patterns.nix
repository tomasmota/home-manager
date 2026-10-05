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
]
