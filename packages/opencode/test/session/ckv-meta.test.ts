/**
 * ComposableKV O-META (T6-0): a request built from a conversation with two
 * whole-file read results carries `nvext.ckv.files` with both tool_call_ids
 * and absolute paths; with OPENCODE_CKV_META unset the field is absent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "path"
import type { ModelMessage } from "ai"
import { Effect, Stream } from "effect"
import { LLM } from "../../src/session/llm"
import { Provider } from "@/provider/provider"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { testEffect } from "../lib/effect"
import type { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as CkvMeta from "../../src/ckv/meta"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node])))
const drain = (input: LLM.StreamInput) => LLM.Service.use((svc) => svc.stream(input).pipe(Stream.runDrain))

type Capture = { body: Record<string, unknown> }
const state = { server: null as ReturnType<typeof Bun.serve> | null, pending: [] as Array<(c: Capture) => void> }

function waitRequest() {
  return new Promise<Capture>((resolve) => state.pending.push(resolve))
}

function chatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] })}`,
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ delta: { content: text } }] })}`,
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"
  return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>
      state.pending.shift()?.({ body })
      return chatStream("ok")
    },
  })
})
afterAll(() => void state.server?.stop())
afterEach(() => {
  delete process.env.OPENCODE_CKV_META
})

const MODELS_FIXTURE = JSON.parse(
  await Bun.file(path.join(import.meta.dir, "../tool/fixtures/models-api.json")).text(),
) as Record<string, ModelsDev.Provider>
const FIX = { providerID: "vivgrid", modelID: "gemini-3.1-pro-preview" }

function readResult(id: string, filePath: string, body: string) {
  return `<path>${filePath}</path>\n<type>file</type>\n<content>\n${body}\n\n(End of file - total 1 lines)\n</content>`
}

/** Two read results, one cleared result and one directory read in context. */
function conversation(): ModelMessage[] {
  return [
    { role: "user", content: "look at these" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "call_a", toolName: "read", input: { filePath: "/repo/a.py" } },
        { type: "tool-call", toolCallId: "call_dir", toolName: "read", input: { filePath: "/repo" } },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_a", toolName: "read", output: { type: "text", value: readResult("call_a", "/repo/a.py", "1: x = 1") } },
        { type: "tool-result", toolCallId: "call_dir", toolName: "read", output: { type: "text", value: "<path>/repo</path>\n<type>directory</type>\n<entries>\na.py\n</entries>" } },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "call_old", toolName: "read", input: { filePath: "/repo/old.py" } },
        { type: "tool-call", toolCallId: "call_b", toolName: "read", input: { filePath: "/repo/b.py" } },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_old", toolName: "read", output: { type: "text", value: "[Old tool result content cleared]" } },
        { type: "tool-result", toolCallId: "call_b", toolName: "read", output: { type: "text", value: readResult("call_b", "/repo/b.py", "1: y = 2") } },
      ],
    },
    { role: "user", content: "now what?" },
  ]
}

describe("ckv.meta", () => {
  test("files() keeps whole-file reads only", () => {
    expect(CkvMeta.files(conversation())).toEqual([
      { tool_call_id: "call_a", path: "/repo/a.py" },
      { tool_call_id: "call_b", path: "/repo/b.py" },
    ])
    expect(CkvMeta.pathOf("<path>rel.py</path>\n<type>file</type>\n")).toBeUndefined()
  })

  for (const on of [true, false]) {
    it.instance(
      `request body ${on ? "carries" : "omits"} nvext.ckv.files (T6-0, OPENCODE_CKV_META=${on ? 1 : 0})`,
      () =>
        Effect.gen(function* () {
          if (on) process.env.OPENCODE_CKV_META = "1"
          const request = waitRequest()
          const resolved = yield* Provider.use.getModel(ProviderV2.ID.make(FIX.providerID), ModelV2.ID.make(FIX.modelID))
          const sessionID = SessionID.make("session-ckv-meta")
          const agent = {
            name: "test",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info
          const user = {
            id: MessageID.make("msg_user-1"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderV2.ID.make(FIX.providerID), modelID: resolved.id },
          } satisfies SessionV1.User
          yield* drain({ user, sessionID, model: resolved, agent, system: ["sys"], messages: conversation(), tools: {} })
          const body = (yield* Effect.promise(() => request)).body
          if (on) {
            expect(body.nvext).toEqual({
              ckv: { files: [{ tool_call_id: "call_a", path: "/repo/a.py" }, { tool_call_id: "call_b", path: "/repo/b.py" }] },
            })
          } else {
            expect(body.nvext).toBeUndefined()
          }
        }),
      {
        config: () => ({
          enabled_providers: [FIX.providerID],
          provider: { [FIX.providerID]: { options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` } } },
        }),
      },
    )
  }
})
