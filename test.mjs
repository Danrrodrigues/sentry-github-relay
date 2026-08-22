import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  verifySignature,
  pickRepo,
  meetsLevel,
  buildIssue,
  marker,
  health,
  deepHealth,
  targetRepos,
} from './lib.mjs'

const SECRET = 's3cr3t'
const sign = (body) => createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')

// --- signature ---
const body = '{"action":"created"}'
assert.equal(verifySignature(body, sign(body), SECRET), true, 'valid signature passes')
assert.equal(verifySignature(body, sign(body), 'wrong'), false, 'wrong secret fails')
assert.equal(verifySignature(body + ' ', sign(body), SECRET), false, 'tampered body fails')
assert.equal(verifySignature(body, null, SECRET), false, 'missing header fails')
assert.equal(verifySignature(body, 'zzzz', SECRET), false, 'non-hex header fails')
assert.equal(verifySignature(body, sign(body), ''), false, 'empty secret fails')

// --- routing ---
const map = { 'acme-api': 'acme/backend', 'acme-web': 'acme/frontend' }
assert.equal(pickRepo('acme-api', map), 'acme/backend')
assert.equal(pickRepo('acme-web', map), 'acme/frontend')
assert.equal(pickRepo('other', map), null, 'unmapped project without a default is ignored')
assert.equal(pickRepo('other', map, 'acme/catch-all'), 'acme/catch-all', 'default catches the rest')

// --- level filter ---
assert.equal(meetsLevel('error', 'error'), true)
assert.equal(meetsLevel('fatal', 'error'), true)
assert.equal(meetsLevel('warning', 'error'), false)
assert.equal(meetsLevel('info', 'error'), false)
assert.equal(meetsLevel('warning', 'warning'), true)
assert.equal(meetsLevel('weird', 'error'), true, 'unknown level is not silently dropped')
assert.equal(meetsLevel('info', ''), true, 'no minimum configured lets everything through')

// --- issue body ---
const built = buildIssue(
  {
    id: '999',
    title: 'DbUpdateException: boom',
    level: 'error',
    culprit: 'Repo.Save',
    shortId: 'ACME-API-1A',
    project: { slug: 'acme-api' },
    metadata: { value: 'inner detail' },
  },
  'acme',
)
assert.equal(built.title, '[sentry/acme-api] DbUpdateException: boom')
assert.ok(built.body.includes(marker('999')), 'marker present for dedupe')
assert.ok(built.body.includes('https://acme.sentry.io/issues/999/'), 'link falls back to the org url')
assert.ok(built.body.includes('inner detail'))

assert.ok(
  buildIssue({ id: '1', title: 'x'.repeat(400), project: { slug: 'p' } }, 'o').title.length <= 250,
  'title stays under the GitHub limit',
)

// Sentry sends "" for fields it has nothing for — that must render as — , not blank.
const sparse = buildIssue({ id: '2', title: 't', culprit: '', level: '', project: { slug: 'p' } }, 'o')
assert.ok(sparse.body.includes('**Culprit:** —'), 'empty culprit falls back')
assert.ok(sparse.body.includes('**Level:** —'), 'empty level falls back')
assert.ok(!/\*\*[A-Za-z ]+:\*\* *\n/.test(sparse.body), 'no blank rows in the body')

// --- shallow health ---
const FULL = {
  SENTRY_CLIENT_SECRET: 's',
  GITHUB_TOKEN: 't',
  REPO_MAP: '{"acme-api":"acme/backend"}',
}
assert.equal(health(FULL).ok, true, 'fully configured is ok')
assert.equal(health({ ...FULL, SENTRY_CLIENT_SECRET: '' }).ok, false, 'no secret -> not ok')
assert.equal(health({ ...FULL, GITHUB_TOKEN: undefined }).ok, false, 'no token -> not ok')
assert.equal(health({ ...FULL, REPO_MAP: '{}' }).ok, false, 'empty map with no default routes nothing')
assert.equal(
  health({ ...FULL, REPO_MAP: '{}', DEFAULT_REPO: 'acme/catch-all' }).ok,
  true,
  'empty map is fine when a default catches everything',
)

const broken = health({ ...FULL, REPO_MAP: '{nope' })
assert.equal(broken.ok, false, 'malformed REPO_MAP -> not ok')
assert.equal(broken.repoMap, 'invalid json', 'and says so instead of crashing')
assert.equal(health({ ...FULL, REPO_MAP: '["a"]' }).repoMap, 'invalid json', 'an array is not a map')

assert.equal(health(FULL).repoMap, '1 projects')
assert.equal(health({}).minLevel, 'error', 'defaults are reported, not left blank')

const leak = JSON.stringify(health(FULL))
assert.ok(!leak.includes('"s"') && !leak.includes('"t"'), 'health never echoes secret values')

// --- target repos ---
assert.deepEqual(
  targetRepos({ REPO_MAP: '{"a":"acme/x","b":"acme/x","c":"acme/y"}', DEFAULT_REPO: 'acme/z' }),
  ['acme/x', 'acme/y', 'acme/z'],
  'deduped, default included',
)

// --- deep health ---
const fakeFetch = (routes) => async (url) => {
  const path = url.replace('https://api.github.com', '')
  const hit = routes[path]
  if (hit === undefined) throw new Error(`unexpected call: ${path}`)
  return { ok: hit.ok, status: hit.status, json: async () => hit.body ?? {} }
}

const DEEP_ENV = { ...FULL, REPO_MAP: '{"acme-api":"acme/backend","acme-web":"acme/frontend"}' }

const happy = await deepHealth(
  DEEP_ENV,
  fakeFetch({
    '/user': { ok: true, status: 200, body: { login: 'octocat' } },
    '/repos/acme/backend': { ok: true, status: 200 },
    '/repos/acme/frontend': { ok: true, status: 200 },
  }),
)
assert.equal(happy.ok, true, 'live token reaching every repo is ok')
assert.equal(happy.github.user, 'octocat')
assert.equal(happy.github.repos.length, 2)

const expired = await deepHealth(
  DEEP_ENV,
  fakeFetch({
    '/user': { ok: false, status: 401 },
    '/repos/acme/backend': { ok: false, status: 401 },
    '/repos/acme/frontend': { ok: false, status: 401 },
  }),
)
assert.equal(expired.ok, false, 'expired token is caught even though it is present')
assert.equal(expired.githubToken, true, 'presence still true — that is exactly the trap')
assert.equal(expired.github.tokenValid, false)

const halfScoped = await deepHealth(
  DEEP_ENV,
  fakeFetch({
    '/user': { ok: true, status: 200, body: { login: 'octocat' } },
    '/repos/acme/backend': { ok: true, status: 200 },
    '/repos/acme/frontend': { ok: false, status: 404 },
  }),
)
assert.equal(halfScoped.ok, false, 'one unreachable repo fails the whole check')
assert.equal(
  halfScoped.github.repos.find((r) => r.repo === 'acme/frontend').status,
  404,
  'and names which repo, so you know what to add to the PAT',
)

const offline = await deepHealth(
  DEEP_ENV,
  async () => {
    throw new Error('network down')
  },
)
assert.equal(offline.ok, false, 'network failure degrades instead of throwing')

const noToken = await deepHealth({ ...DEEP_ENV, GITHUB_TOKEN: '' }, () => {
  throw new Error('must not call GitHub without a token')
})
assert.equal(noToken.ok, false)
assert.equal(noToken.github.tokenValid, false)

console.log('ok — all checks passed')
