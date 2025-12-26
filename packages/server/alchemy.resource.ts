/**
 * Durable Streams Server Resource
 * 
 * Alchemy resource definition for deploying the Durable Object
 * implementation of the Durable Streams protocol.
 */

import { Worker, DurableObjectNamespace } from "alchemy/cloudflare";
import * as path from "node:path";

const cwd = path.join(import.meta.dirname);

export type DurableStreamsServerOptions = {
  version?: string;
};

export function DurableStreamsServerResource(
  opts: DurableStreamsServerOptions = {}
) {
  // Create the Durable Object namespace with SQLite support
  const streamDO = DurableObjectNamespace("stream-do", {
    className: "StreamDO",
    sqlite: true,
  });

  // Create the worker that handles HTTP requests
  const worker = Worker("durable-streams-server", {
    cwd,
    entrypoint: "./src/index.ts",
    compatibility: "node",
    version: opts.version,
    bindings: {
      STREAM_DO: streamDO,
    },
  });

  return { worker, streamDO };
}

export type DurableStreamsServer = Awaited<
  ReturnType<typeof DurableStreamsServerResource>
>;
export type DurableStreamsServerEnv = DurableStreamsServer["worker"]["Env"];
