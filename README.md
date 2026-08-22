# sentry-github-relay

Opens a GitHub issue when Sentry opens a new one.

Sentry can already do this natively — it's called a **ticket rule**, and it requires the
**Business plan**. On the Developer and Team plans the GitHub integration gives you suspect
commits and stack trace links, but no automatic issue creation. This is that feature, as a
single serverless function with no dependencies.

One deployment serves any number of Sentry projects pointing at any number of repos.

```
Sentry issue.created ──POST──▶ /api/sentry
                                   │ 1. verify HMAC (Sentry-Hook-Signature)
                                   │ 2. drop anything below MIN_LEVEL
                                   │ 3. map project.slug ──▶ repo
                                   │ 4. search for the dedupe marker
                                   └─▶ POST /repos/{repo}/issues
```

A Sentry project that isn't in the map is ignored with a `200`. Adding a new product means
editing one environment variable — no code change.

---

## Setup

Four steps, about ten minutes.

### 1. Deploy

```sh
git clone https://github.com/<you>/sentry-github-relay
cd sentry-github-relay
vercel --prod
```

Note the URL it prints. Nothing works yet — that's expected.

> **Turn off Vercel Authentication** for this project (*Settings → Deployment Protection*).
> It is on by default and answers `302` to every request, so Sentry's webhook never arrives.
> The endpoint has its own authentication: it verifies Sentry's HMAC signature and rejects
> anything unsigned with a `401`.

Any host that runs a standard `Request → Response` handler works — Vercel is just the path
of least resistance. The whole thing is two route files and `lib.mjs`.

### 2. Create a GitHub token

A [fine-grained PAT](https://github.com/settings/personal-access-tokens/new):

- **Repository access** → *Only select repositories* → pick every repo you'll target
- **Permissions** → **Issues: Read and write**
- *Metadata: Read-only* is added automatically and is required

Nothing else. Not Contents, not Actions, not Administration.

> Mind the expiry date. When the token expires the relay stops creating issues and
> `/api/health` still answers `200`, because the variable is still set. Step 4 shows how to
> catch that.

### 3. Create the Sentry integration

*Settings → Custom Integrations → Create New Integration → **Internal Integration***

| Field | Value |
| --- | --- |
| Name | anything, e.g. `GitHub Issue Relay` |
| Webhook URL | `https://<your-deployment>/api/sentry` |
| Alert Rule Action | off — not used |
| Permissions | **Issue & Event: Read** |
| Webhooks | check **Issues → Created** |

Save, then scroll to **Credentials** and copy the **Client Secret**.

> The secret is shown once, right after creation. If the page reloads first it turns into
> `hidden` — click **Rotate client secret** to get a fresh one. Rotating is harmless as long
> as nothing is using the old one yet.

### 4. Configure and verify

Set the variables from [`.env.example`](.env.example) on your deployment, then redeploy —
on Vercel, environment variables are bound at deploy time, so a variable added after the
last deploy is invisible until the next one.

```sh
curl https://<your-deployment>/api/health?deep=1
```

```json
{
  "ok": true,
  "sentryClientSecret": true,
  "githubToken": true,
  "repoMap": "2 projects",
  "defaultRepo": null,
  "minLevel": "error",
  "github": {
    "tokenValid": true,
    "user": "octocat",
    "repos": [
      { "repo": "acme/backend",  "reachable": true, "status": 200 },
      { "repo": "acme/frontend", "reachable": true, "status": 200 }
    ]
  }
}
```

`200` and you're done. Anything else, see [Health](#health) below.

---

## Configuration

All variables live in [`.env.example`](.env.example). The one that matters:

```json
REPO_MAP={"acme-api":"acme/backend","acme-web":"acme/frontend"}
```

Keys are **Sentry project slugs** (the URL segment, not the display name). Values are
`owner/repo` on GitHub. Several projects can point at the same repo — a monorepo with four
Sentry projects is four keys and one value.

Set `DEFAULT_REPO` if you'd rather catch everything and filter later. Without it, an
unmapped project is dropped silently and deliberately.

`ISSUE_LABELS` must name labels that already exist in the target repo, or GitHub answers
`422`:

```sh
gh label create sentry --color 584774 -R acme/backend
```

---

## Health

`GET /api/health` — no network calls, safe to poll. Reports whether each variable is set,
never its value. `200` when configured, `503` when not, so an uptime monitor catches it.

`GET /api/health?deep=1` — the same, plus GitHub is actually asked. This exists because
presence is not correctness: a token that has expired, or whose repository access doesn't
cover a repo in your map, passes the shallow check and then fails on the first real event,
after you've already lost it.

| Symptom | Cause |
| --- | --- |
| `githubToken: false` | variable not set, or set after the last deploy — redeploy |
| `repoMap: "invalid json"` | malformed JSON; would have thrown on the first webhook |
| `github.tokenValid: false` | token expired or revoked |
| a repo with `status: 404` | that repo isn't in the PAT's *Repository access* list |
| `ok: true` but no issues appear | the level filter, or the project isn't in `REPO_MAP` |

`?deep=1` costs one GitHub API call per distinct repo plus one. Point your monitor at the
shallow endpoint and use the deep one by hand.

**What it can't tell you:** whether the token may *write* issues. Proving that means
creating one. `reachable` means "the token is live and can see this repo", which is what
every real misconfiguration trips over.

---

## Testing

```sh
node test.mjs
```

No framework, no fixtures. Covers signature verification (valid, wrong secret, tampered
body, missing and non-hex headers), routing, the level filter, issue rendering, and both
health checks against a stubbed GitHub.

End to end, send a synthetic event to one of your projects:

```sh
curl -X POST "https://o<ORG_ID>.ingest.us.sentry.io/api/<PROJECT_ID>/store/" \
  -H "Content-Type: application/json" \
  -H "X-Sentry-Auth: Sentry sentry_version=7, sentry_key=<PUBLIC_KEY>" \
  -d '{"event_id":"'"$(openssl rand -hex 16)"'","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%S)"'",
       "platform":"other","level":"error","exception":{"values":[{"type":"RelayTest",
       "value":"testing the relay, safe to close"}]}}'
```

All three values come from your DSN, which reads
`https://<PUBLIC_KEY>@o<ORG_ID>.ingest.us.sentry.io/<PROJECT_ID>`. The issue shows up in
about thirty seconds. Close it and resolve the Sentry issue afterwards.

---

## Known limits

**No environment filter.** The `issue.created` payload doesn't carry an environment, so
there is no way to keep staging errors out without a second API call and a second secret.
As long as your DSN only exists in production this makes no difference. If you need it, the
hook is `GET /api/0/issues/{id}/tags/environment/` with a Sentry auth token.

**Dedupe relies on GitHub's search index**, which lags a few seconds. Sentry fires
`issue.created` exactly once per issue, so this only guards against webhook retries. If
duplicates ever appear, move the marker into a KV store.

**One issue per Sentry issue, never updated.** A Sentry issue that regresses does not
reopen the GitHub issue. Subscribing to `issue.unresolved` and reopening by marker would be
a small addition.

## License

MIT
