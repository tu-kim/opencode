/**
 * ComposableKV O-META: list the `read` tool results that are still in the
 * conversation so the Dynamo frontend can find their token spans
 * (`nvext.ckv.files = [{tool_call_id, path}]`, SPEC §6.6).
 *
 *   OPENCODE_CKV_META=1
 *
 * Experiment switch (TURN_ANALYSIS §5): OPENCODE_CKV_FIRST_READ_ONLY=1 lists only the
 * first read of each path, so a re-read of the same file (typically after a failed
 * edit) is prefilled normally instead of from the same PI chunk again.
 */
import type { ModelMessage } from "ai"
import { truthy } from "@opencode-ai/core/flag/flag"

export interface CkvFile {
  tool_call_id: string
  path: string
}

export function enabled(): boolean {
  return truthy("OPENCODE_CKV_META")
}

export function firstReadOnly(): boolean {
  return truthy("OPENCODE_CKV_FIRST_READ_ONLY")
}

const HEADER = /^<path>([^\n]*)<\/path>\n<type>file<\/type>\n/

/** Absolute path from a whole-file read result; undefined for directories,
 * images, cleared ("[Old tool result content cleared]") or error outputs. */
export function pathOf(output: string): string | undefined {
  const m = HEADER.exec(output)
  const p = m?.[1]
  return p && p.startsWith("/") ? p : undefined
}

/** Read results in the exact message list that goes to the model (after
 * compaction and pruning), in conversation order. */
export function files(messages: ModelMessage[], firstOnly = firstReadOnly()): CkvFile[] {
  const out: CkvFile[] = []
  const seen = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type !== "tool-result" || part.toolName !== "read") continue
      const o = part.output
      if (!o || o.type !== "text") continue
      const path = pathOf(o.value)
      if (!path) continue
      if (firstOnly && seen.has(path)) continue
      seen.add(path)
      out.push({ tool_call_id: part.toolCallId, path })
    }
  }
  return out
}

/** The `nvext` body field for a request, or undefined when off or empty. */
export function nvext(messages: ModelMessage[]): { ckv: { files: CkvFile[] } } | undefined {
  if (!enabled()) return undefined
  const list = files(messages)
  return list.length ? { ckv: { files: list } } : undefined
}
