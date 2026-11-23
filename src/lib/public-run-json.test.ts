import { expect, test } from "bun:test";
import { publicRunJson } from "./public-run-json";

test("public run serialization strips signed queries from result URLs and snippets", () => {
  const input = {
    url: "https://example.com/file?X-Amz-Signature=example&r=1",
    snippet: "Image (https://example.com/img?dr=1&amp;x-signature=example) and https://example.com/search?q=corpus",
    related: ["https://example.com/book?id=abc&sig=example", "https://example.com/download?token=example"],
    hitRank: 2,
  };
  expect(JSON.parse(publicRunJson(input))).toEqual({
    url: "https://example.com/file",
    snippet: "Image (https://example.com/img) and https://example.com/search?q=corpus",
    related: ["https://example.com/book", "https://example.com/download"],
    hitRank: 2,
  });
});
