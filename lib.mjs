import { createHmac, timingSafeEqual } from 'node:crypto'

export const marker = (issueId) => `<!-- sentry-issue:${issueId} -->`

const LEVELS = ['debug', 'info', 'warning', 'error', 'fatal']

/** Sentry signs the raw request body with the integration's Client Secret. */
export function verifySignature(rawBody, header, secret) {
  if (!header || !secret) return false
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest()
  let got
  try {
    got = Buffer.from(header, 'hex')
  } catch {
    return false
  }
  return got.length === expected.length && timingSafeEqual(got, expected)
}

/** Exact slug match, then the optional catch-all. Unknown slug -> null (ignored). */
export function pickRepo(projectSlug, repoMap, defaultRepo) {
  return repoMap[projectSlug] ?? defaultRepo ?? null
}

export function meetsLevel(level, minLevel) {
  const at = LEVELS.indexOf(level)
  const min = LEVELS.indexOf(minLevel)
  if (min < 0) return true
  // ponytail: an unrecognised level passes — a noisy issue beats a dropped crash
  return at < 0 ? true : at >= min
}

export function parseRepoMap(raw) {
  try {
    const parsed = JSON.parse(raw ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Every repo this instance could ever write to. */
export function targetRepos(env) {
  const map = parseRepoMap(env.REPO_MAP)
  const all = [...Object.values(map ?? {}), env.DEFAULT_REPO].filter(Boolean)
  return [...new Set(all)]
}

/** Config presence only — never values. Not ready -> the route answers 503. */
export function health(env) {
  const map = parseRepoMap(env.REPO_MAP)
  const projects = map === null ? null : Object.keys(map).length
  const routable = projects !== null && (projects > 0 || Boolean(env.DEFAULT_REPO))
  return {
    ok: Boolean(env.SENTRY_CLIENT_SECRET && env.GITHUB_TOKEN) && routable,
    sentryClientSecret: Boolean(env.SENTRY_CLIENT_SECRET),
    githubToken: Boolean(env.GITHUB_TOKEN),
    repoMap: projects === null ? 'invalid json' : `${projects} projects`,
    defaultRepo: env.DEFAULT_REPO ?? null,
    minLevel: env.MIN_LEVEL ?? 'error',
  }
}

/**
 * Presence is not correctness: an expired token, or one whose repository access
 * does not cover a mapped repo, passes `health()` and then fails on the first
 * real event — after you have already lost it. This actually asks GitHub.
 *
 * ponytail: `reachable` is honest about its limit. Proving *write* access would
 * mean creating an issue, so this proves "token is live and can see the repo",
 * which is what every real misconfiguration trips over.
 */
export async function deepHealth(env, fetchImpl = fetch) {
  const base = health(env)
  const repos = targetRepos(env)

  if (!env.GITHUB_TOKEN) {
    return { ...base, ok: false, github: { tokenValid: false, user: null, repos: [] } }
  }

  const call = (path) =>
    fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'sentry-github-relay',
      },
    })

  const [me, ...checks] = await Promise.all([
    call('/user').catch(() => null),
    ...repos.map((repo) =>
      call(`/repos/${repo}`)
        .then((r) => ({ repo, reachable: r.ok, status: r.status }))
        .catch(() => ({ repo, reachable: false, status: 0 })),
    ),
  ])

  const tokenValid = Boolean(me?.ok)
  const user = tokenValid ? ((await me.json().catch(() => ({}))).login ?? null) : null

  return {
    ...base,
    ok: base.ok && tokenValid && checks.every((c) => c.reachable),
    github: { tokenValid, user, repos: checks },
  }
}

export function buildIssue(sentryIssue, orgSlug) {
  const project = sentryIssue.project?.slug ?? 'unknown'
  const link =
    sentryIssue.web_url ||
    sentryIssue.permalink ||
    `https://${orgSlug}.sentry.io/issues/${sentryIssue.id}/`

  // `||`, not `??`: Sentry sends "" for fields it has no value for, and an empty
  // string is present-but-useless — it renders as a blank row.
  const rows = [
    ['Project', project],
    ['Level', sentryIssue.level || '—'],
    ['Type', sentryIssue.metadata?.type || sentryIssue.type || '—'],
    ['Culprit', sentryIssue.culprit || '—'],
    ['Platform', sentryIssue.platform || '—'],
    ['Short ID', sentryIssue.shortId || '—'],
    ['Status', sentryIssue.status || '—'],
    ['Events', sentryIssue.count ?? '—'],
    ['Users affected', sentryIssue.userCount ?? '—'],
    ['First seen', sentryIssue.firstSeen || '—'],
  ]

  return {
    title: `[sentry/${project}] ${sentryIssue.title ?? 'Unknown error'}`.slice(0, 250),
    body: [
      rows.map(([k, v]) => `**${k}:** ${v}`).join('\n'),
      '',
      sentryIssue.metadata?.value ? '```\n' + sentryIssue.metadata.value + '\n```' : '',
      '',
      link,
      '',
      marker(sentryIssue.id),
    ]
      .filter((s) => s !== '')
      .join('\n'),
  }
}

const gh = (token, path, init = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sentry-github-relay',
      ...init.headers,
    },
  })

/**
 * ponytail: dedupe leans on GitHub's search index, which lags a few seconds.
 * Sentry fires issue.created once per issue, so this only guards webhook retries.
 * If duplicates ever show up, move the marker into a KV store.
 */
export async function alreadyReported(repo, issueId, token) {
  const q = encodeURIComponent(`repo:${repo} is:issue in:body "${marker(issueId)}"`)
  const res = await gh(token, `/search/issues?q=${q}&per_page=1`)
  if (!res.ok) return false
  const json = await res.json()
  return (json.total_count ?? 0) > 0
}

export async function createIssue(repo, { title, body }, labels, token) {
  const res = await gh(token, `/repos/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title, body, labels }),
  })
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`)
  return res.json()
}
