import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent } from "../src/promise"

// The server projection (packages/core/src/session/message-updater.ts) persists
// the provider-native block of a text part, and the timeline reads
// `native.phase` (commentary / final_answer) to decide how a block is laid out.
// The solid reducer must carry the same field, otherwise the live transcript
// differs from the one a reload projects from storage.
test("keeps the provider-native block on session.text.ended like the server projection", () => {
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
  try {
    let seq = 0
    const publish = (type: string, data: object) => {
      seq += 1
      listeners.forEach((listener) =>
        listener({
          name: type,
          details: {
            id: `evt_${seq}`,
            created: seq,
            type,
            durable: { aggregateID: "ses_text", seq, version: 1 },
            data,
          } as OpenCodeEvent,
        }),
      )
    }

    const base = { sessionID: "ses_text", assistantMessageID: "msg_assistant" }
    publish("session.step.started", { ...base, agent: "build", model: { providerID: "p", id: "m" }, started: 1 })
    publish("session.text.started", base)
    publish("session.text.ended", { ...base, text: "done", native: { phase: "final_answer" } })

    const parts = setup.data.session.message.get("ses_text", "msg_assistant")?.content ?? []
    const text = parts.find((part) => part.type === "text")
    expect(text).toMatchObject({ type: "text", text: "done", native: { phase: "final_answer" } })
  } finally {
    setup.dispose()
  }
})
