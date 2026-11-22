// CONTRACT tests against a REAL LearnHarness instance (ADR 105): if upstream changes the shape of a
// route the Hub uses, it fails here and nowhere else.
//
// Usage (against a LearnHarness started with a TEMPORARY LH_DATA_DIR: these tests create a session):
//   LH_CONTRACT_URL=http://127.0.0.1:3000 pnpm --filter @graphharness/lh-client test:contract
// Without LH_CONTRACT_URL they are skipped (so a plain `npx vitest run` does not need LearnHarness). With
// LH_CONTRACT=1 (set by the `test:contract` script) a missing LH_CONTRACT_URL is a FAILURE, not a silent skip.
//
// Not covered here because it triggers model calls (cost): POST /api/chat,
// POST /api/graph/import and POST /api/graph/coverage/extract. Their shapes are pinned in
// client.test.ts with synthetic fixtures written from our reading of the API.
import { describe, expect, it } from "vitest";
import { createLhClient, type LhClient } from "./client.ts";
import type { ServerEvent } from "./types.ts";

const URL_ENV = process.env.LH_CONTRACT_URL;
const REQUIRED = process.env.LH_CONTRACT === "1";

describe.runIf(REQUIRED && !URL_ENV)("test:contract without a target", () => {
  it("needs LH_CONTRACT_URL (e.g. http://127.0.0.1:3000) pointing at a LearnHarness with a temporary LH_DATA_DIR", () => {
    expect.fail("Set LH_CONTRACT_URL to run the contract tests against LearnHarness.");
  });
});

describe.skipIf(!URL_ENV)("contract with a real LearnHarness (skipped: set LH_CONTRACT_URL to run it)", () => {
  const baseUrl = URL_ENV ?? "";
  // Lazy: the body of a skipped describe is still walked when collecting the tests.
  let cached: LhClient | undefined;
  const client = (): LhClient => (cached ??= createLhClient({ baseUrl }));

  it("GET /api/graph matches GraphSnapshot (propositions + chains)", async () => {
    const graph = await client().getGraph();
    expect(Array.isArray(graph.propositions)).toBe(true);
    expect(Array.isArray(graph.chains)).toBe(true);
  });

  it("GET /api/chats matches {chats: ChatListItem[]}", async () => {
    const chats = await client().listChats();
    expect(Array.isArray(chats)).toBe(true);
  });

  it("POST /api/chats → GET /api/chats/:id (+ /markdown) match ChatDetail", async () => {
    const created = await client().createChat({ title: "lh-client contract", kind: "practice" });
    expect(created.id).toMatch(/^chat_/);
    const chat = await client().getChat(created.id);
    expect(chat.id).toBe(created.id);
    expect(chat.kind).toBe("practice");
    expect(Array.isArray(chat.messages)).toBe(true);
    expect(typeof chat.turnInFlight).toBe("boolean");
    const listed = await client().listChats();
    expect(listed.some((c) => c.id === created.id)).toBe(true);
    const md = await client().getChatMarkdown(created.id);
    expect(md.startsWith("# lh-client contract")).toBe(true);
  });

  it("GET /api/graph/status matches {runs}", async () => {
    const runs = await client().graphStatus();
    expect(Array.isArray(runs)).toBe(true);
  });

  it(
    "GET /api/events: the first frame after creating a session is chats-changed",
    async () => {
      // LearnHarness sends nothing on connect: wait until the response arrives (the listener is
      // already attached on its side) and trigger an event by creating a session.
      let connected!: () => void;
      const isConnected = new Promise<void>((resolve) => (connected = resolve));
      const watched = createLhClient({
        baseUrl,
        fetch: async (input, init) => {
          const res = await fetch(input, init);
          if (String(input instanceof Request ? input.url : input).endsWith("/api/events")) {
            expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
            connected();
          }
          return res;
        },
      });
      const ac = new AbortController();
      const first = new Promise<ServerEvent>((resolve, reject) => {
        watched
          .subscribeEvents(
            (e) => {
              resolve(e);
              ac.abort();
            },
            { signal: ac.signal },
          )
          .then(() => reject(new Error("LearnHarness closed /api/events without sending any event")), reject);
      });
      await isConnected;
      await client().createChat({ title: "lh-client contract events", kind: "teach" });
      expect(await first).toEqual({ type: "chats-changed" });
    },
    15_000,
  );
});
