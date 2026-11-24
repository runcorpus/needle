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
      const fragmentStart = url.indexOf("#");
      if (queryStart === -1 || (fragmentStart !== -1 && fragmentStart < queryStart)) return url;

      const queryEnd = fragmentStart === -1 ? url.length : fragmentStart;
      const query = url.slice(queryStart + 1, queryEnd);
      const params = new URLSearchParams(query.replaceAll("&amp;", "&"));
      const names = [...params.keys()].map((name) => name.toLowerCase());
      if (names.some((name) => credentialParams.has(name))) return url.slice(0, queryStart);
      if (!names.includes("inf_contact_key")) return url;

      // Keep the original encoding and separators of the document parameters.
      const remainingQuery = query.split(/(?=&)/).filter((part) => {
        const field = part.replace(/^&(?:amp;)?/, "");
        const [name] = new URLSearchParams(field).keys();
        return name?.toLowerCase() !== "inf_contact_key";
      }).join("").replace(/^&(?:amp;)?/, "");
      return `${url.slice(0, queryStart)}${remainingQuery ? `?${remainingQuery}` : ""}${url.slice(queryEnd)}`;
    });
  }, indentation);
}
