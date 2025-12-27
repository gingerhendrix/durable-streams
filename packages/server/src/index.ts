/**
 * Durable Streams Server
 *
 * Worker entry point and composition root.
 * Wires together the HTTP handler, protocol, and storage layers.
 */

import type { StreamStorage as StreamStorageInterface } from "cf-durable-streams-types/storage";
import { HttpHandler } from "./http.ts";
import { StreamStorage } from "./storage.ts";

// Re-export the Durable Object for the runtime
export { StreamStorage };

// Environment type for the worker
interface DurableStreamsServerEnv {
  STREAM_DO: DurableObjectNamespace<StreamStorage>;
}

/**
 * Worker entry point
 *
 * Creates the storage factory and HTTP handler, then routes requests.
 * This is the composition root where all DI happens.
 */
export default {
  async fetch(
    request: Request,
    env: DurableStreamsServerEnv
  ): Promise<Response> {
    // Create storage factory from env binding
    const storageFactory = (
      streamId: string
    ): DurableObjectStub<StreamStorageInterface> => {
      const id = env.STREAM_DO.idFromName(streamId);
      return env.STREAM_DO.get(id) as DurableObjectStub<StreamStorageInterface>;
    };

    // Create handler with factory
    const handler = new HttpHandler(storageFactory);

    // Execute request
    return handler.fetch(request);
  },
} satisfies ExportedHandler<DurableStreamsServerEnv>;
