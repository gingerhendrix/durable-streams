/**
 * Durable Streams Server
 *
 * Worker entry point and composition root.
 * Wires together the HTTP handler, protocol, and storage layers.
 */

import type { StreamStorageInterface } from "cf-durable-streams";
import { HttpHandler, StreamProtocol, StreamStorage } from "cf-durable-streams";

// Re-export the Durable Object for the runtime
export { StreamStorage };

/**
 * Environment type for the worker.
 * Uses the StreamStorage class for proper DO typing.
 */
interface Env {
  STREAM_DO: DurableObjectNamespace<StreamStorage>;
}

/**
 * Worker entry point
 *
 * Creates the storage factory, protocol, and HTTP handler.
 * This is the composition root where all DI happens.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Create storage factory from env binding
    const storageFactory = (streamId: string): StreamStorageInterface => {
      const id = env.STREAM_DO.idFromName(streamId);
      // The Durable Object stub has all the methods of StreamStorage
      return env.STREAM_DO.get(id) as unknown as StreamStorageInterface;
    };

    // Create protocol with factory
    const protocol = new StreamProtocol(storageFactory);

    // Create handler with protocol
    const handler = new HttpHandler({ protocol });

    // Execute request
    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
