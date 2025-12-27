/**
 * Durable Streams Server Resource
 *
 * Alchemy resource definition for deploying the Durable Object
 * implementation of the Durable Streams protocol.
 */
import alchemy from "alchemy";
import { Worker, DurableObjectNamespace } from "alchemy/cloudflare";

const app = await alchemy("durable-streams");

const streamDO = DurableObjectNamespace("stream-do", {
  className: "StreamDO",
  sqlite: true,
});

// Create the worker that handles HTTP requests
const worker = await Worker("durable-streams-server", {
  entrypoint: "./src/index.ts",
  compatibility: "node",
  bindings: {
    STREAM_DO: streamDO,
  },
});

export type DurableStreamsServerEnv = typeof worker.Env;

await app.finalize();
