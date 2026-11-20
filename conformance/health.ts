import createOpenApiClient from "openapi-fetch";
import type { paths } from "./generated/tron-api.d.ts";

export function createClient(baseUrl: string): { isReady(): Promise<boolean> } {
  const client = createOpenApiClient<paths>({ baseUrl });
  return {
    async isReady() {
      try {
        const { data } = await client.GET("/api/health");
        return data?.status === "ok" && data.database === "ready";
      } catch {
        return false;
      }
    },
  };
}
