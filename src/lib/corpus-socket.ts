// HTTP-over-UDS transport used by Surf's @corpusd/api SocketClient.
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RequestOptions {
  signal?: AbortSignal;
  traceContext?: { traceparent: string; tracestate?: string };
}

export class SocketClient {
  constructor(readonly socket = join(process.env.CORPUS_HOME ?? join(homedir(), ".corpus"), "daemon.sock")) {}

  async request(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<unknown> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {
      "content-type": "application/json",
      ...options.traceContext,
      ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }),
    };
    return new Promise((resolve, reject) => {
      const request = httpRequest({ socketPath: this.socket, method, path, headers, signal: options.signal }, (response) => {
        let source = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { source += chunk; });
        response.on("error", reject);
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`corpusd returned ${status}${source.trim() ? `: ${source.trim()}` : ""}`));
          } else if (status === 204) {
            resolve(undefined);
          } else {
            try { resolve(JSON.parse(source)); } catch (error) { reject(error); }
          }
        });
      });
      request.on("error", reject);
      request.end(payload);
    });
  }
}
