import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent } from "../src/promise"

// SSE delivery is at-least-once (#61401): the client reducer must be idempotent
// for a re-delivered event, otherwise the same server-side state renders twice.
// These three cases are the settlement/appended rows that were not idempotent:
//   #61425 a re-delivered step.started regressed a settled assistant message
//   #61426 a re-delivered compaction.ended appended a duplicate compaction row
//   #61427 a re-delivered tool.input.started appended a duplicate tool part
function harness(aggregateID: string) {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async () => Response.json({ data: [], cursor: {} }),
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))
  let seq = 0
  const publish = (type: string, data: object, id?: string) => {
    const eventID = id ?? `evt_${seq + 1}`
    if (!id) seq += 1
    listeners.forEach((listener) =>
      listener({
        name: type,
        details: {
          id: eventID,
          created: seq,
          type,
          durable: { aggregateID, seq, version: 1 },
          data,
        } as OpenCodeEvent,
      }),
    )
  }
  return { data: setup.data, publish, dispose: setup.dispose }
}

const model = { providerID: "provider", id: "model" }
const tokens = { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }

test("never regresses a settled assistant message on a re-delivered session.step.started", () => {
  const h = harness("ses_step")
  try {
    const base = { sessionID: "ses_step", assistantMessageID: "msg_assistant" }
    const settled = () => h.data.session.message.get("ses_step", "msg_assistant")

    h.publish("session.step.started", { ...base, agent: "build", model, started: 1 })
    h.publish("session.step.ended", { ...base, finish: "stop", cost: 1, tokens })
    expect(settled()?.time.completed).toBe(2)

    // A re-delivered step.started (same event id) must not regress the
    // settled message back to running.
    h.publish("session.step.started", { ...base, agent: "build", model, started: 3 }, "evt_1")
    expect(settled()?.finish).toBe("stop")
    expect(settled()?.time.completed).not.toBeUndefined()
  } finally {
    h.dispose()
  }
})

test("never appends a duplicate compaction row on a re-delivered session.compaction.ended", () => {
  const h = harness("ses_compact")
  try {
    const rows = () => h.data.session.message.list("ses_compact").filter((part) => part.type === "compaction")
    const ended = (text: string, cost: number) => ({
      sessionID: "ses_compact",
      text,
      cost,
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    })

    h.publish("session.compaction.started", { sessionID: "ses_compact", inputID: "msg_x" })
    h.publish("session.compaction.ended", ended("Summary", 1))

    // A re-delivered ended (same event id) must hit the append guard.
    h.publish("session.compaction.ended", ended("Summary", 1), "evt_2")
    expect(rows()?.length).toBe(1)

    // ...and must not mark a newer running row with its own stale summary.
    h.publish("session.compaction.started", { sessionID: "ses_compact", inputID: "msg_y" })
    h.publish("session.compaction.ended", ended("Stale summary", 2), "evt_2")
    expect(rows()?.at(-1)).toMatchObject({ id: "msg_y", status: "running", summary: "" })

    // The failed path (no inputID) gets the same re-delivery guard.
    h.publish("session.compaction.started", { sessionID: "ses_compact" })
    h.publish("session.compaction.failed", { sessionID: "ses_compact", reason: "oops", error: { message: "boom" } })
    h.publish(
      "session.compaction.failed",
      { sessionID: "ses_compact", reason: "oops", error: { message: "boom" } },
      "evt_5",
    )
    expect(rows()?.filter((row) => row.status === "failed").length).toBe(1)
  } finally {
    h.dispose()
  }
})

test("never appends a duplicate tool part on a re-delivered session.tool.input.started", () => {
  const h = harness("ses_tool")
  try {
    const base = { sessionID: "ses_tool", assistantMessageID: "msg_assistant" }
    const toolParts = () =>
      (h.data.session.message.get("ses_tool", "msg_assistant")?.content ?? []).filter((part) => part.type === "tool")

    h.publish("session.step.started", { ...base, agent: "build", model, started: 1 })
    h.publish("session.tool.input.started", { ...base, id: "call_read", name: "read" })
    h.publish("session.tool.input.delta", { ...base, id: "call_read", delta: "abc" })

    // Re-delivered started (same event id) must not add a second tool part.
    h.publish("session.tool.input.started", { ...base, id: "call_read", name: "read" }, "evt_2")
    const parts = toolParts()
    expect(parts.length).toBe(1)
    expect(parts[0]).toMatchObject({ type: "tool", id: "call_read" })
  } finally {
    h.dispose()
  }
})
