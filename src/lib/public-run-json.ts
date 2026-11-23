const credentialParams = new Set([
  "access_token",
  "api_key",
  "refresh_token",
  "sig",
  "signature",
  "token",
  "x-amz-credential",
  "x-amz-security-token",
  "x-amz-signature",
  "x-goog-credential",
  "x-goog-signature",
  "x-signature",
]);

export function publicRunJson(value: unknown, indentation?: number) {
  return JSON.stringify(value, (_, entry: unknown) => {
    if (typeof entry !== "string" || !entry.includes("://")) return entry;
    return entry.replace(/https?:\/\/[^\s<>"'\])]+/g, (url) => {
      const queryStart = url.indexOf("?");
      if (queryStart === -1) return url;
      const query = url.slice(queryStart + 1).split("#", 1)[0].replaceAll("&amp;", "&");
      const params = new URLSearchParams(query);
      return [...params.keys()].some((name) => credentialParams.has(name.toLowerCase()))
        ? url.slice(0, queryStart)
        : url;
    });
  }, indentation);
}
