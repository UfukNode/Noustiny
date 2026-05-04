import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
// Polled at 1s by the bottom-right RenderJobs widget.  Keep the timeout
// generous in case the render service is briefly slow under heavy load.
export const maxDuration = 30

const SERVICE_URL = process.env.STORYBOOK_SERVICE_URL ?? 'http://127.0.0.1:8643'

/**
 * Read-through proxy to the storybook FastAPI service's `/jobs/{id}`
 * endpoint.  The service publishes one progress entry per stage
 * (translate / tts / page / intro / concat / done) and the widget
 * polls this route to surface them in the UI.
 *
 * Unknown ids return a `queued` placeholder so the widget can render
 * the moment the modal closes — even before the AI has dispatched the
 * tool to the service.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const jobId = req.nextUrl.searchParams.get('jobId') ?? ''
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(jobId)) {
    return Response.json({ error: 'invalid jobId' }, { status: 400 })
  }

  try {
    const upstream = await fetch(`${SERVICE_URL}/jobs/${jobId}`, {
      cache: 'no-store',
      // 5s soft cap — if the service is wedged we still want the widget
      // to keep ticking instead of holding the polling loop hostage.
      signal: AbortSignal.timeout(5000),
    })
    if (!upstream.ok) {
      return Response.json(
        { error: `service ${upstream.status}` },
        { status: 502 },
      )
    }
    const body = await upstream.json()
    return Response.json(body, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return Response.json(
      { error: `service unreachable: ${msg}` },
      { status: 502 },
    )
  }
}
