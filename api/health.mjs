import { health, deepHealth } from '../lib.mjs'

export async function GET(request) {
  const deep = new URL(request.url).searchParams.get('deep') === '1'
  const report = deep ? await deepHealth(process.env) : health(process.env)

  return new Response(JSON.stringify(report, null, 2), {
    status: report.ok ? 200 : 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
