/**
 * Durable Streams Deployment
 * 
 * Alchemy deployment configuration for the Durable Streams server.
 */

import alchemy from "alchemy";
import { DurableStreamsServerResource } from "@durable-streams/server/alchemy";

const app = await alchemy("durable-streams");

// Deploy the Durable Streams server
export const server = await DurableStreamsServerResource({
  version: "0.0.1",
});

console.log({
  worker: server.worker.url,
  durableObject: server.streamDO.name,
});

await app.finalize();
