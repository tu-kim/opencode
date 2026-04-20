import path from "path"
import { createWriteStream, mkdirSync, type WriteStream } from "fs"
import { Global } from "../global"
import { Flag } from "../flag/flag"

export namespace Profiler {
  interface RequestData {
    timestamp: string
    sessionID: string
    messageID: string
    agent: string
    provider: string
    modelID: string
    apiModelID: string
    endpoint: string
    messageRoles: string[]
    availableTools: string[]
    startTime: number
    text: string
    reasoning: string
    toolCalls: { tool: string; input: unknown }[]
    inputMessages: unknown[]
    system: string[]
    userQuery: string
  }

  const pending = new Map<string, RequestData>()
  let summaryStream: WriteStream | undefined
  let rawStream: WriteStream | undefined
  let sessionTag = ""

  function enabled() {
    return Flag.OPENCODE_PROFILING
  }

  function ensureStreams() {
    if (summaryStream && rawStream) return { summary: summaryStream, raw: rawStream }
    const dir = path.join(Global.Path.data, "profiling")
    mkdirSync(dir, { recursive: true })
    if (!sessionTag) sessionTag = new Date().toISOString().split(".")[0].replace(/:/g, "")
    summaryStream = createWriteStream(path.join(dir, `profile-${sessionTag}.jsonl`), { flags: "a" })
    rawStream = createWriteStream(path.join(dir, `profile-raw-${sessionTag}.jsonl`), { flags: "a" })
    return { summary: summaryStream, raw: rawStream }
  }

  export function startRequest(input: {
    sessionID: string
    messageID: string
    agent: string
    provider: string
    modelID: string
    apiModelID: string
    endpoint: string
    system: string[]
    userQuery: string
    messages: { role: string; content: unknown }[]
    availableTools: string[]
  }) {
    if (!enabled()) return
    pending.set(input.sessionID, {
      ...input,
      messageRoles: input.messages.map((m) => m.role),
      inputMessages: input.messages,
      availableTools: input.availableTools,
      timestamp: new Date().toISOString(),
      startTime: Date.now(),
      text: "",
      reasoning: "",
      toolCalls: [],
    })
  }

  export function appendText(sessionID: string, delta: string) {
    if (!enabled()) return
    const req = pending.get(sessionID)
    if (req) req.text += delta
  }

  export function appendReasoning(sessionID: string, delta: string) {
    if (!enabled()) return
    const req = pending.get(sessionID)
    if (req) req.reasoning += delta
  }

  export function appendToolCall(sessionID: string, tool: string, input: unknown) {
    if (!enabled()) return
    const req = pending.get(sessionID)
    if (req) req.toolCalls.push({ tool, input })
  }

  export function endRequest(input: {
    sessionID: string
    messageID: string
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
    finishReason: string
  }) {
    if (!enabled()) return
    const req = pending.get(input.sessionID)
    if (!req) return
    pending.delete(input.sessionID)

    const streams = ensureStreams()
    const requestID = `${req.timestamp}-${req.messageID}`

    const summary = {
      timestamp: req.timestamp,
      requestID,
      sessionID: req.sessionID,
      agent: req.agent,
      provider: req.provider,
      modelID: req.modelID,
      apiModelID: req.apiModelID,
      endpoint: req.endpoint,
      messageRoles: req.messageRoles,
      availableTools: req.availableTools,
      calledTools: req.toolCalls.map((t) => t.tool),
      tokens: {
        input: input.tokens.input,
        output: input.tokens.output,
      },
      finishReason: input.finishReason,
      durationMs: Date.now() - req.startTime,
    }

    const raw = {
      requestID,
      input: req.inputMessages,
      output: {
        text: req.text,
        reasoning: req.reasoning,
        toolCalls: req.toolCalls,
      },
    }

    streams.summary.write(JSON.stringify(summary) + "\n")
    streams.raw.write(JSON.stringify(raw, null, 2) + "\n---\n")
  }
}
