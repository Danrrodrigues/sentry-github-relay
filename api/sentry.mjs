import {
  verifySignature,
  pickRepo,
  meetsLevel,
  buildIssue,
  alreadyReported,
  createIssue,
} from '../lib.mjs'

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  })

// Named method export = Vercel's Web Handler signature, which is what gives us
// request.text(). A default export would be treated as a Node (req, res) handler
// and there is no raw body there to verify the HMAC against.
export async function POST(request) {
  const {
    SENTRY_CLIENT_SECRET,
    GITHUB_TOKEN,
    REPO_MAP = '{}',
    DEFAULT_REPO,
    SENTRY_ORG = 'sentry',
    MIN_LEVEL = 'error',
    ISSUE_LABELS = 'sentry',
  } = process.env

  if (!SENTRY_CLIENT_SECRET || !GITHUB_TOKEN) return json(500, { error: 'missing env' })

  const raw = await request.text()
  if (!verifySignature(raw, request.headers.get('sentry-hook-signature'), SENTRY_CLIENT_SECRET)) {
    return json(401, { error: 'bad signature' })
  }

  const payload = JSON.parse(raw)
  if (payload.action !== 'created') return json(200, { skipped: 'not a created event' })

  const issue = payload.data?.issue
  if (!issue) return json(200, { skipped: 'no issue in payload' })

  if (!meetsLevel(issue.level, MIN_LEVEL)) {
    return json(200, { skipped: `level ${issue.level} below ${MIN_LEVEL}` })
  }

  const repo = pickRepo(issue.project?.slug, JSON.parse(REPO_MAP), DEFAULT_REPO)
  if (!repo) return json(200, { skipped: `unmapped project ${issue.project?.slug}` })

  if (await alreadyReported(repo, issue.id, GITHUB_TOKEN)) {
    return json(200, { skipped: 'already reported' })
  }

  const created = await createIssue(
    repo,
    buildIssue(issue, SENTRY_ORG),
    ISSUE_LABELS.split(',').map((s) => s.trim()).filter(Boolean),
    GITHUB_TOKEN,
  )

  return json(201, { created: created.html_url })
}
