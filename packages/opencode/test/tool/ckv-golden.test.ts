// Writes the whole-file read output of every file in $CKV_GOLDEN_IN to
// $CKV_GOLDEN_OUT (JSON: basename -> output). The ComposableKV PI-KV builder
// must reproduce these bytes exactly (ckv/tests/test_render.py).
//
//   CKV_GOLDEN_IN=../../../ckv/tests/fixtures/render \
//   CKV_GOLDEN_OUT=../../../ckv/tests/fixtures/render_golden.json \
//   bun test test/tool/ckv-golden.test.ts
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import fs from "fs"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_ckv"),
  messageID: MessageID.make("msg_ckv"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const layer = LayerNode.compile(
  LayerNode.group([Agent.node, FSUtil.node, CrossSpawnSpawner.node, Instruction.node, LSP.node, Ripgrep.node, Truncate.node]),
)
const it = testEffect(Layer.mergeAll(layer, testInstanceStoreLayer))

describe("ckv golden render", () => {
  const input = process.env.CKV_GOLDEN_IN
  const output = process.env.CKV_GOLDEN_OUT
  if (!input || !output) {
    it.live("skipped: set CKV_GOLDEN_IN and CKV_GOLDEN_OUT", () => Effect.void)
    return
  }
  it.live("renders every fixture with OPENCODE_CKV_FULL_READ=1", () =>
    Effect.gen(function* () {
      process.env.OPENCODE_CKV_FULL_READ = "1"
      const dir = path.resolve(input)
      const tool = yield* provideInstance(dir)(Effect.flatMap(ReadTool, (t) => t.init()))
      const golden: Record<string, string> = {}
      for (const name of fs.readdirSync(dir).sort()) {
        const result = yield* provideInstance(dir)(tool.execute({ filePath: path.join(dir, name) }, ctx))
        golden[name] = result.output
      }
      fs.writeFileSync(path.resolve(output), JSON.stringify(golden, null, 1) + "\n")
      expect(Object.keys(golden).length).toBeGreaterThan(0)
    }),
  )
})
