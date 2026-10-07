/**
 * ComposableKV O-NOTIFY: tell the node's ckv-builder that a file changed so
 * its PI-KV is rebuilt in the background. Fire-and-forget: a missing or dead
 * builder never affects the tool that edited the file (O-CFG).
 *
 *   OPENCODE_CKV_NOTIFY_URL=http://localhost:8200
 */
import * as path from "path"

const TIMEOUT_MS = 2000

export function notifyUrl(): string | undefined {
  const url = process.env.OPENCODE_CKV_NOTIFY_URL
  return url ? url.replace(/\/+$/, "") : undefined
}

/** Resolves once the request was sent (or skipped); never rejects. */
export async function notifyFileChanged(filepath: string): Promise<boolean> {
  const url = notifyUrl()
  if (!url) return false
  try {
    const res = await fetch(`${url}/v1/ckv/files/changed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path.resolve(filepath) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Fire-and-forget from inside tool code. */
export function notifyFileChangedAsync(filepath: string): void {
  if (!notifyUrl()) return
  void notifyFileChanged(filepath)
}
