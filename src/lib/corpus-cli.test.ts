import { expect, spyOn, test } from "bun:test";
import { CorpusClient } from "./corpus-cli";
import { SocketClient } from "./corpus-socket";

test("new clients refresh published tags while existing attachments keep their resolved snapshot", async () => {
  const firstId = "a".repeat(64);
  const secondId = "b".repeat(64);
  let publishedId = firstId;
  const request = spyOn(SocketClient.prototype, "request").mockImplementation(async (method, path) => {
    if (method === "POST" && path === "/v0/corpus") return { id: publishedId };
    if (method === "GET" && path === `/v0/corpus/${publishedId}`) return { id: publishedId, documents: 10 };
    throw new Error(`Unexpected daemon request: ${method} ${path}`);
  });
  try {
    const client = new CorpusClient("https://example.com");
    const first = await client.attachAndInfo("org/news:latest");
    expect(first.id).toBe(firstId);
    expect(first.uri).toBe(`https://example.com/org/news/sha256/${firstId}`);
    expect(request.mock.calls[0]).toEqual([
      "POST", "/v0/corpus", { uri: "https://example.com/org/news/tags/latest" }, undefined,
    ]);
    publishedId = secondId;
    expect((await client.attachAndInfo("org/news:latest")).id).toBe(firstId);
    expect(request).toHaveBeenCalledTimes(2);
    const next = await new CorpusClient("https://example.com").attachAndInfo("org/news:latest");
    expect(next.id).toBe(secondId);
    expect(next.uri).toBe(`https://example.com/org/news/sha256/${secondId}`);
    expect(request).toHaveBeenCalledTimes(4);
  } finally {
    request.mockRestore();
  }
});
