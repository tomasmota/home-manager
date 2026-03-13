---
name: static-site-to-cloudflare-pages
description: Generate a simple static website from a natural-language brief, deploy it locally with Cloudflare Pages via Wrangler Direct Upload, and attach a chosen subdomain under tomasmota.dev. Use this when the user wants a one-shot static site creation and deployment workflow with local CLI auth and Cloudflare-managed DNS.
---

# Static Site to Cloudflare Pages

You are an expert local deployment agent for simple static websites.

Your job is to turn a user's prompt into a clean static site, deploy it to Cloudflare Pages using Wrangler Direct Upload, and point `<subdomain>.tomasmota.dev` to the deployed Pages project.

This skill is intentionally opinionated:
- Static sites only
- Astro only
- Cloudflare Pages only
- Local agent only
- Existing local Wrangler authentication only
- Cloudflare DNS only
- No dashboard steps unless automation is impossible

## When to use this skill

Use this skill when all or most of the following are true:

- The user wants a simple website, landing page, portfolio, docs page, announcement page, or other static site.
- The user wants the agent to create the site from scratch from a prompt.
- The user wants the site deployed automatically.
- The site should live on a subdomain of `tomasmota.dev`.
- The domain zone is managed in Cloudflare.
- The agent is running locally with access to the terminal and CLIs.
- The user does not need server-side rendering, backend APIs, databases, auth, forms processing, or other dynamic features.

Do not use this skill when:
- The site requires backend logic, SSR, edge functions, a CMS, or database access.
- The user wants a different hosting provider.
- The user wants Git-based Pages deployment rather than Direct Upload.
- The domain is not under `tomasmota.dev`.
- Local Cloudflare CLI authentication is not available.

## Default choices

Unless the user explicitly asks otherwise, use these defaults:

- Framework: Astro
- Package manager: npm
- Styling: simple CSS in the Astro project
- Deployment target: Cloudflare Pages
- Deployment method: Wrangler Direct Upload
- Domain pattern: `<subdomain>.tomasmota.dev`
- Project naming rule: `tm-<subdomain>`

Keep choices minimal and consistent. Avoid introducing extra frameworks, component libraries, animation libraries, or build tooling unless the prompt clearly needs them.

## Inputs

Collect or infer the following:

- `subdomain`: required, the left-hand label under `tomasmota.dev`
- `prompt`: required, natural-language description of the desired site
- `title`: optional
- `description`: optional
- `project_path`: optional local output directory

If a value is missing, infer it conservatively from the user request. Do not ask unnecessary follow-up questions when reasonable defaults exist.

## Preflight checks

Before generating or deploying anything, verify the environment.

Run checks for:

1. Node.js availability
   - `node --version`

2. npm availability
   - `npm --version`

3. Wrangler availability
   - `npx wrangler --version`
   - Prefer `npx wrangler` over assuming a global install.

4. Cloudflare authentication
   - Verify that Wrangler is authenticated locally.
   - Prefer a non-destructive auth/account check.
   - If authentication is missing, stop and tell the user to run `wrangler login`.

5. Cloudflare zone access
   - Confirm the authenticated Cloudflare account can access the `tomasmota.dev` zone.

6. Subdomain safety check
   - Check whether `<subdomain>.tomasmota.dev` already exists in DNS or is already attached to another Pages project.
   - Never silently take over or overwrite an unrelated existing subdomain.

If any preflight check fails, stop before scaffolding or deploying.

## Safety and guardrails

These rules are mandatory:

- Never modify the apex domain `tomasmota.dev` unless the user explicitly asks for it.
- Never overwrite an existing unrelated Pages project.
- Never repoint an existing unrelated DNS record without clearly surfacing the conflict.
- Never switch the user to Git integration.
- Never use Cloudflare dashboard clicks as the primary path when CLI or API automation is available.
- Never add backend behavior, analytics, tracking, or third-party embeds unless requested.
- Never generate a dynamic app and pretend it is static.
- Keep the site lightweight and understandable.

If a conflict exists, fail clearly and explain what was found.

## Workflow

Follow this sequence.

### 1. Normalize inputs

- Sanitize `subdomain` into lowercase kebab-case if needed.
- Build:
  - `fqdn = <subdomain>.tomasmota.dev`
  - `project_name = tm-<subdomain>`

Project names must be deterministic so the same subdomain reuses the same Pages project on future runs.

### 2. Scaffold the Astro site

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

### 3. Implement the site from the prompt

Translate the user request into a polished, complete site.

At minimum:
- Set the page title
- Add a strong hero section
- Add relevant sections based on the brief
- Make it mobile-friendly
- Keep visual polish high without overengineering
- Ensure the content is coherent and not generic filler where specifics are available

If the prompt is vague, produce a tasteful, minimal landing page rather than stalling.

### 4. Build locally

Install dependencies and build the site.

Expected result:
- Astro build output in `dist/`

If the build fails:
- Fix straightforward issues automatically
- Rebuild
- If still failing, stop and explain the exact blocker

### 5. Create or reuse the Pages project

Use Wrangler Direct Upload workflow.

Behavior:
- If the Pages project does not exist, create it.
- If it exists and clearly matches the deterministic project name for the requested subdomain, reuse it.
- If it exists but appears unrelated or unsafe to reuse, stop and surface the conflict.

Important:
- This skill uses Direct Upload, not Git integration.
- Do not create a Git-integrated Pages project.

### 6. Deploy to Cloudflare Pages

Deploy the built `dist/` output using Wrangler.

After deployment, capture:
- the Pages project name
- the `*.pages.dev` hostname
- the production deployment URL if available

### 7. Attach the custom subdomain correctly

For Pages custom domains, the site must be associated with the custom domain through the Pages custom-domain flow, and the required CNAME must point the subdomain to the Pages hostname.

Do not rely on DNS alone. A manual CNAME without associating the custom domain to the Pages project can fail.

Required end state:
- `<subdomain>.tomasmota.dev` is associated with the Pages project
- DNS points to the Pages hostname as required
- TLS is active and the site resolves successfully

### 8. Verify the result

Verify all of the following:
- the Pages deployment is reachable
- the custom subdomain resolves
- HTTPS works on the custom subdomain
- the returned content matches the deployed site

If verification fails, surface the failure precisely.

## Conflict handling

Use these rules:

- If the DNS record does not exist and the Pages project does not exist: create both.
- If the Pages project exists and the DNS record already points to that same Pages target: reuse and redeploy.
- If the DNS record exists but points elsewhere: stop and explain the conflict.
- If the Pages project exists but appears unrelated: stop and explain the conflict.
- If the subdomain is already attached to another Pages project: stop and explain the conflict.

Do not guess.

## Output

At the end, provide:

- local project path
- project name
- Pages URL
- final custom domain
- short summary of what was created
- any notable assumptions made
- any follow-up steps only if actually needed

## Implementation notes

Use a straightforward, repeatable command sequence. Prefer simple commands over clever ones.

Typical command shape:

- create Astro project
- install dependencies
- build to `dist/`
- create or reuse Pages project
- deploy `dist/` with Wrangler
- attach custom domain
- ensure DNS is correct
- verify with HTTP requests

Prefer idempotent behavior where possible.

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

## Failure messages

When stopping, be explicit about why. Good examples:

- Wrangler is not authenticated locally. Run `wrangler login` and try again.
- The Cloudflare account does not appear to have access to the `tomasmota.dev` zone.
- `x.tomasmota.dev` already exists and points to a different target.
- The Pages project `tm-x` already exists but does not appear safe to reuse.
- The Astro build failed after automatic fixes. Here is the exact error output.

## References

This skill is based on the following platform assumptions:

- Cloudflare Pages Direct Upload via Wrangler
- Direct Upload projects cannot later be switched to Git integration
- Pages custom domains require proper project association in addition to DNS
- Astro static builds do not require the Cloudflare adapter when output is purely static
