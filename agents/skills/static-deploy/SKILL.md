---
name: static-deploy
description: Generate a simple Astro static website, deploy it to Cloudflare Pages via Direct Upload, attach a subdomain under tomasmota.dev, and verify the result using API-token-based Cloudflare automation.
metadata:
  framework: astro
  hosting: cloudflare-pages
  zone: tomasmota.dev
  auth:
    required_env:
      - CLOUDFLARE_API_TOKEN
    optional_env:
      - CLOUDFLARE_ACCOUNT_ID
---

# Static Deploy

You are an expert local deployment agent for simple static websites.

Your job is to turn a user's prompt into a clean static site, deploy it to Cloudflare Pages using Direct Upload, attach `<subdomain>.tomasmota.dev`, and verify the final result end to end.

This skill is intentionally opinionated:
- Static sites only
- Astro only
- Cloudflare Pages only
- Direct Upload only
- Cloudflare DNS only
- API-token auth is the primary path
- `wrangler login` is optional and should not be required
- No dashboard steps unless automation is impossible

## When to use this skill

Use this skill when all or most of the following are true:

- The user wants a simple static website, landing page, docs page, portfolio, microsite, or announcement page.
- The user wants the site created from a prompt and deployed automatically.
- The site should live on a subdomain of `tomasmota.dev`.
- The DNS zone is managed in Cloudflare.
- The agent is running locally with access to the terminal and CLIs.
- The site does not need SSR, a backend, a database, auth, or other dynamic behavior.

Do not use this skill when:
- The site requires backend logic, SSR, edge functions, forms processing, or a CMS.
- The user wants Git-based Pages deployment instead of Direct Upload.
- The user wants a different host.
- The domain is not under `tomasmota.dev`.
- The required Cloudflare API token is not available and the user does not want to provide it.

## Default choices

Unless the user explicitly asks otherwise, use these defaults:

- Framework: Astro
- Package manager: npm
- Styling: plain CSS inside the Astro project
- Deployment target: Cloudflare Pages
- Deployment method: Wrangler Direct Upload
- Domain pattern: `<subdomain>.tomasmota.dev`
- Project naming rule: `tm-<subdomain>`
- Local project directory: `<working-directory>/<project-name>`

Keep choices minimal and consistent. Avoid extra frameworks, UI kits, animation libraries, and build tooling unless the prompt clearly needs them.

## Authentication model

This skill should prefer API-token auth over interactive CLI auth.

Required environment:
- `CLOUDFLARE_API_TOKEN`

Recommended environment:
- `CLOUDFLARE_ACCOUNT_ID`

Required token capabilities:
- Account-level permission to edit Cloudflare Pages projects
- Zone-level permission to read the `tomasmota.dev` zone
- Zone-level permission to edit DNS for `tomasmota.dev`

Practical token guidance:
- Account permission: `Cloudflare Pages Edit`
- Zone permissions on `tomasmota.dev`: `Zone Read` and `DNS Edit`

Important:
- Do not assume `wrangler login` exists.
- Do not read secrets from Wrangler's local config as the primary path.
- Use `CLOUDFLARE_API_TOKEN` for both REST API calls and Wrangler commands.
- If `CLOUDFLARE_ACCOUNT_ID` is missing, discover it from the zone lookup.

If token auth is missing or insufficient, fail before scaffolding or deploying.

The early-failure message should say exactly:
- which env var is missing, especially `CLOUDFLARE_API_TOKEN`
- which permissions are required: `Cloudflare Pages Edit`, `Zone Read`, and `DNS Edit` on `tomasmota.dev`
- that `wrangler login` is not required for this skill when the token is set

## Inputs

Collect or infer the following:

- `subdomain`: required, the left-hand label under `tomasmota.dev`
- `prompt`: required, natural-language description of the desired site
- `title`: optional
- `description`: optional
- `project_path`: optional local parent directory

If a value is missing, infer it conservatively from the user request. Do not ask unnecessary follow-up questions when reasonable defaults exist.

## Derived values

Normalize and derive these values first:

- `subdomain_slug = <lowercase-kebab-case-subdomain>`
- `fqdn = <subdomain_slug>.tomasmota.dev`
- `project_name = tm-<subdomain_slug>`
- `project_dir = <project_path or current working directory>/<project_name>`

Rules:
- Project names must be deterministic so the same subdomain reuses the same Pages project on future runs.
- Never scaffold into `.` when the directory is non-empty.
- Never rely on the Astro generator choosing the right target directory.
- Always create or reuse an explicit project directory and verify it before scaffolding.

## Preflight checks

Before generating or deploying anything, verify the environment and permissions.

Run checks for:

1. Node.js availability
   - `node --version`

2. npm availability
   - `npm --version`

3. Wrangler availability
   - `npx wrangler --version`

4. Required Cloudflare env
   - Confirm `CLOUDFLARE_API_TOKEN` is set

5. Cloudflare zone access
   - Confirm the token can access the `tomasmota.dev` zone
   - If `CLOUDFLARE_ACCOUNT_ID` is not set, discover the account from the zone lookup

6. Pages capability
   - Confirm the token can read or create Pages projects in the target account

7. DNS capability
   - Confirm the token can list and edit DNS records in `tomasmota.dev`

8. Subdomain safety check
   - Check whether `fqdn` already exists in DNS
   - Check whether `fqdn` is already attached to a Pages project
   - Never silently take over an unrelated DNS record or Pages domain

If any preflight check fails, stop before scaffolding or deploying.

## Safety and guardrails

These rules are mandatory:

- Never modify the apex domain `tomasmota.dev` unless the user explicitly asks for it.
- Never overwrite an existing unrelated Pages project.
- Never overwrite or repoint an unrelated DNS record.
- Never switch a project to Git integration.
- Never assume Wrangler alone can manage Pages custom domains or DNS.
- Never add backend behavior, analytics, tracking, or third-party embeds unless requested.
- Never generate a dynamic app and pretend it is static.
- Keep the site lightweight and understandable.

If a conflict exists, fail clearly and explain what was found.

## Control-plane implementation

Use the right tool for each layer:

- Use Wrangler for asset upload only:
  - `npx wrangler pages deploy dist --project-name <project_name>`
- Use the Cloudflare REST API for control-plane operations:
  - zone lookup
  - project lookup and creation
  - project detail lookup
  - Pages custom-domain association
  - DNS record lookup and create or patch
  - domain revalidation and polling

Do not rely on undocumented Wrangler behavior for DNS or Pages custom-domain automation.

## Bundled helper scripts

Use the bundled helper scripts in `scripts/`. They should emit machine-readable JSON and exit non-zero on failure.

Bundled helpers:
- `scripts/cf_preflight.py`
  - validates env, zone access, Pages access, DNS access, and subdomain conflicts
- `scripts/cf_pages_project.py`
  - get or create a Pages project and return project details including `subdomain`
- `scripts/cf_pages_domain.py`
  - ensure the custom domain is attached to the Pages project
- `scripts/cf_dns_record.py`
  - ensure the expected proxied CNAME exists and fail on conflicting records
- `scripts/cf_poll.py`
  - poll custom-domain activation and return status details
- `scripts/cf_cleanup.py`
  - dry-run or apply removal of managed DNS, Pages domain attachment, Pages project, and optionally the local project directory
- `scripts/verify_site.py`
  - verify external DNS, HTTPS, and expected content

If a helper script needs to be extended, preserve the same machine-readable output style and idempotent behavior.

## Workflow

Follow this sequence.

### 1. Normalize inputs

- Sanitize the subdomain into lowercase kebab-case.
- Derive `fqdn`, `project_name`, and `project_dir`.

### 2. Run preflight before creating files

- Check local tooling.
- Check `CLOUDFLARE_API_TOKEN`.
- Confirm zone access and discover `CLOUDFLARE_ACCOUNT_ID` if needed.
- Confirm Pages and DNS permissions.
- Check for DNS and Pages-domain conflicts.

If this step fails, stop immediately and tell the user exactly what env and permissions are required.

### 3. Scaffold the Astro site in a deterministic directory

Create a minimal Astro static site.

Requirements:
- Static output only
- No server adapter
- No unnecessary dependencies
- Responsive layout
- Good typography
- Accessible HTML structure
- Clear page hierarchy
- Sensible metadata

Preferred structure:
- `src/pages/index.astro`
- `src/layouts/BaseLayout.astro`
- optional small components if helpful
- `public/` for static assets

Keep JavaScript minimal. Default to zero client-side JS unless the prompt clearly benefits from a small amount of interactivity.

### 4. Implement the site from the prompt

Translate the user's request into a polished, complete site.

At minimum:
- Set the page title
- Add a strong hero section
- Add relevant sections based on the brief
- Make it mobile-friendly
- Keep visual polish high without overengineering
- Ensure the content is coherent and not generic filler where specifics are available

If the prompt is vague, produce a tasteful, minimal landing page rather than stalling.

### 5. Build locally and sanity-check the output

Install dependencies and build the site.

Expected result:
- Astro build output in `dist/`

Before deploy, verify:
- `dist/` exists
- the build succeeded cleanly enough to trust the output
- the output is reasonable for Pages limits
- no single asset exceeds Cloudflare Pages limits

If the build fails:
- Fix straightforward issues automatically
- Rebuild
- If still failing, stop and explain the exact blocker

### 6. Create or reuse the Pages project

Behavior:
- If the Pages project does not exist, create it
- If it exists and matches the deterministic project name for the requested subdomain, reuse it
- If it exists but appears unrelated or unsafe to reuse, stop and surface the conflict
- If it exists and is Git-integrated or otherwise incompatible with this workflow, stop and explain the mismatch

This skill uses Direct Upload only.

### 7. Deploy to Cloudflare Pages

Deploy the built `dist/` output using Wrangler with token-based auth.

After deployment, capture:
- the Pages project name
- the `*.pages.dev` hostname
- the production deployment URL if available

### 8. Attach the custom subdomain correctly

For Pages custom domains, the flow must be:
- attach the custom domain to the Pages project first
- then create or update the DNS record to point to the project's `*.pages.dev` hostname
- then retry or poll domain validation until active

Do not rely on DNS alone. A manual CNAME without associating the domain to the Pages project can fail.

Required end state:
- `fqdn` is associated with the Pages project
- DNS points to the expected Pages hostname
- TLS is active
- the site is reachable over HTTPS

### 9. Verify the result using public DNS and HTTPS

Verify all of the following:
- the Pages deployment URL is reachable
- the custom subdomain is active in the Pages API
- public resolvers such as `1.1.1.1` or `8.8.8.8` resolve the custom subdomain correctly
- HTTPS works on the custom subdomain
- the returned content matches the deployed site

Important:
- Do not treat local machine DNS lag as an automatic deployment failure
- Prefer public DNS checks and `curl --doh-url` or `curl --resolve` style verification when local resolution lags

If verification fails, surface the failure precisely.

## Conflict handling

Use these rules:

- If the DNS record does not exist and the Pages project does not exist: create both.
- If the Pages project exists and the DNS record already points to the expected Pages target: reuse and redeploy.
- If the DNS record is a matching managed CNAME but the target or proxy settings are wrong: patch it to the expected value.
- If an A, AAAA, or NS record already exists on the same name: stop and explain the conflict.
- If a CNAME already exists but points elsewhere: stop and explain the conflict.
- If the custom domain is already attached to another Pages project: stop and explain the conflict.
- If the Pages project exists but appears unrelated: stop and explain the conflict.

Do not guess.

## Cleanup and rollback

The skill should have an explicit cleanup policy.

There are two different cleanup modes:
- automatic safety cleanup after a failed run
- explicit user-requested teardown after the site is no longer needed

Principles:
- Do not treat cleanup as the same thing as failure reporting.
- Do not delete user-requested local work by default just because deployment failed.
- Do not remove pre-existing Cloudflare resources that were reused.
- Only auto-clean resources that were created by the current run and are clearly safe to remove.
- Prefer leaving behind a usable local project directory over deleting potentially useful work.

When cleanup should happen automatically:
- If preflight fails before any files or Cloudflare resources are created: no cleanup is needed.
- If the run created only temporary files: remove them automatically.
- If the run created a managed DNS record in the current run and later fails before final verification, it is safe to remove that record only if it was newly created by this run and not reused.
- If the run attached a Pages custom domain in the current run and later fails before final verification, it is safe to detach that domain only if it was newly attached by this run and not reused.
- If the run created a new Pages project in the current run and deployment never reached a verified success state, it may delete that project only if the project was created by this run and was not reused.

When cleanup should not happen automatically:
- Do not delete the local project directory unless the user explicitly asks.
- Do not delete or detach resources that existed before the current run.
- Do not remove a DNS record that was patched or reused instead of created.
- Do not delete a Pages project just because a later verification step failed if the user may want to inspect it.

When the user explicitly asks to remove everything created for a deployed site:
- Treat that as a teardown task, not a failure rollback.
- Use `scripts/cf_cleanup.py` first in dry-run mode to show what will be removed.
- Then run `scripts/cf_cleanup.py --apply` to remove the managed DNS record, Pages domain attachment, and Pages project.
- If the user also wants the local project removed, pass the explicit local directory and `--delete-local-dir`.
- Only remove DNS automatically when the matching record is marked as managed by static-deploy.
- If a matching DNS record exists but is not marked as managed, stop and explain the conflict instead of deleting it.
- Report exactly what was deleted and what was skipped.

Cleanup reporting requirements:
- Track which resources were created, reused, patched, or left untouched during the run.
- On failure, explicitly say what was cleaned up, what was intentionally left in place, and why.
- If cleanup is skipped for safety, say so clearly.
- Include enough detail for the user to remove leftovers manually if needed.

Manual cleanup targets, when relevant:
- local project directory
- Pages project
- Pages custom domain attachment
- managed DNS CNAME record

## Output

At the end, provide:

- local project path
- project name
- Pages URL
- production deployment URL if available
- final custom domain
- short summary of what was created
- any notable assumptions made
- any follow-up steps only if actually needed

## Failure messages

When stopping, be explicit about why. Good examples:

- `CLOUDFLARE_API_TOKEN` is not set. This skill expects token-based auth rather than `wrangler login`.
- The Cloudflare token does not have the required permissions. It must be able to use `Cloudflare Pages Edit` plus `Zone Read` and `DNS Edit` on `tomasmota.dev`.
- The Cloudflare account does not appear to have access to the `tomasmota.dev` zone.
- `x.tomasmota.dev` already exists and points to a different target.
- The Pages project `tm-x` already exists but does not appear safe to reuse.
- The Pages project exists but is not compatible with the Direct Upload workflow.
- The Astro build failed after automatic fixes. Here is the exact error output.

## Quality bar

The generated site should be:

- visually clean
- mobile-friendly
- accessible
- fast-loading
- easy to inspect and edit later
- faithful to the prompt
- free of unnecessary complexity

A simple, sharp site is better than an overbuilt one.

## Platform assumptions

This skill is based on the following assumptions:

- Cloudflare Pages Direct Upload via Wrangler
- Wrangler can use `CLOUDFLARE_API_TOKEN` from the environment
- `wrangler login` is optional, not required
- Direct Upload projects cannot later be switched to Git integration
- Pages custom domains require both Pages association and correct DNS
- Astro static builds do not require the Cloudflare adapter when output is purely static
