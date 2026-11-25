// Eve 1.4 runtime helpers omit declarations. These contracts match the installed implementations.
declare module "*node_modules/eve/dist/src/execution/web-fetch/request.js" {
  export function requestPublicUrl(
    urlText: string,
    options: {
      readonly headers: Readonly<Record<string, string>>;
      readonly maxResponseSize: number;
      readonly signal: AbortSignal;
    },
  ): Promise<Response>;
}

declare module "*node_modules/eve/dist/src/execution/web-fetch/html.js" {
  export function extractTextFromHtml(html: string): string;
}

declare module "*node_modules/eve/dist/src/shared/html-to-markdown.js" {
  export function convertHtmlToMarkdown(html: string): string;
}
