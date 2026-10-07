/**
 * ComposableKV O-NOTIFY (T4-9): editing a file notifies the builder at
 * OPENCODE_CKV_NOTIFY_URL; a dead or unset URL never affects the edit.
 */
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { EditTool } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"
import * as CkvNotify from "../../src/ckv/notify"

const ctx = {
  sessionID: SessionID.make("ses_test-ckv-notify"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
  delete process.env.OPENCODE_CKV_NOTIFY_URL
})

const layer = LayerNode.compile(
  LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]),
)
const it = testEffect(layer)

const runEdit = Effect.fn("CkvNotifyTest.edit")(function* (args: Tool.InferParameters<typeof EditTool>) {
  const info = yield* EditTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

const runWrite = Effect.fn("CkvNotifyTest.write")(function* (args: Tool.InferParameters<typeof WriteTool>) {
  const info = yield* WriteTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

/** A tiny builder stand-in that records notified paths. */
function fakeBuilder() {
  const received: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "POST" && url.pathname === "/v1/ckv/files/changed") {
        const body = (await req.json()) as { path: string }
        received.push(body.path)
        return Response.json({ job: "j1" }, { status: 202 })
      }
      return Response.json({ error: "not found" }, { status: 404 })
    },
  })
  return { received, url: `http://localhost:${server.port}`, stop: () => server.stop(true) }
}

async function waitFor(cond: () => boolean, ms = 2000) {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await Bun.sleep(10)
  return cond()
}

describe("ckv.notify", () => {
  it.live("is a no-op without OPENCODE_CKV_NOTIFY_URL", () =>
    Effect.gen(function* () {
      delete process.env.OPENCODE_CKV_NOTIFY_URL
      expect(CkvNotify.notifyUrl()).toBeUndefined()
      expect(yield* Effect.promise(() => CkvNotify.notifyFileChanged("/tmp/x.py"))).toBe(false)
    }),
  )

  it.live("posts the absolute path to /v1/ckv/files/changed", () =>
    Effect.gen(function* () {
      const b = fakeBuilder()
      process.env.OPENCODE_CKV_NOTIFY_URL = b.url + "/"
      try {
        expect(yield* Effect.promise(() => CkvNotify.notifyFileChanged("/tmp/dir/../x.py"))).toBe(true)
        expect(b.received).toEqual(["/tmp/x.py"])
      } finally {
        b.stop()
      }
    }),
  )

  it.live("swallows a dead builder", () =>
    Effect.gen(function* () {
      process.env.OPENCODE_CKV_NOTIFY_URL = "http://127.0.0.1:1"
      expect(yield* Effect.promise(() => CkvNotify.notifyFileChanged("/tmp/x.py"))).toBe(false)
    }),
  )

  it.instance("edit and write tools notify the builder (T4-9)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const b = fakeBuilder()
      process.env.OPENCODE_CKV_NOTIFY_URL = b.url
      try {
        const created = path.join(test.directory, "created.py")
        yield* runWrite({ filePath: created, content: "x = 1\n" })
        yield* runEdit({ filePath: created, oldString: "x = 1", newString: "x = 2" })
        expect(yield* Effect.promise(() => waitFor(() => b.received.length >= 2))).toBe(true)
        expect(b.received).toEqual([created, created])
      } finally {
        b.stop()
      }
    }),
  )

  it.instance("edit succeeds when the builder is down (T4-9)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      process.env.OPENCODE_CKV_NOTIFY_URL = "http://127.0.0.1:1"
      const filepath = path.join(test.directory, "down.py")
      yield* runWrite({ filePath: filepath, content: "a = 1\n" })
      const result = yield* runEdit({ filePath: filepath, oldString: "a = 1", newString: "a = 3" })
      expect(result.metadata.diff).toContain("a = 3")
    }),
  )
})
