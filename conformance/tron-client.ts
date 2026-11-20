// Drives Tron's REST API as one dev-mode user, through the client types generated from
// Tron's own OpenAPI contract (conformance/generated/tron-api.d.ts).
import createClient from "openapi-fetch";
import type { components, paths } from "./generated/tron-api.d.ts";

export type JobRun = components["schemas"]["JobRunResponse"];
export type RunStatus = components["schemas"]["RunStatus"];
export type DeliveryState = components["schemas"]["DeliveryState"];

export interface RunnerJobOptions {
  name: string;
  handlerKey: string;
  deliveryTimeoutSeconds?: number;
}

const DEFAULT_DELIVERY_TIMEOUT_SECONDS = 30;
const LATENESS_THRESHOLD_SECONDS = 600;
// Long enough that only manual triggers ever create runs during a conformance run.
const NEVER_SOON_INTERVAL_SECONDS = 86_400;
const POLL_INTERVAL_MS = 200;

export class TronUser {
  readonly subject: string;
  private readonly client: ReturnType<typeof createClient<paths>>;

  constructor(baseUrl: string, subject: string) {
    this.subject = subject;
    // `AUTH_MODE=dev` accepts `Bearer dev.<subject>` and needs no sign-in round trip.
    this.client = createClient<paths>({ baseUrl, headers: { Authorization: `Bearer dev.${subject}` } });
  }

  /** Creates a worker API key and returns the token it is shown with, once. */
  async createWorkerKey(name: string): Promise<string> {
    const { data, error } = await this.client.POST("/api/worker-api-keys", { body: { name } });
    if (!data) throw new Error(`creating worker key failed: ${JSON.stringify(error)}`);
    return data.token;
  }

  async createRunnerJob(options: RunnerJobOptions): Promise<string> {
    const { data, error } = await this.client.POST("/api/jobs", {
      body: {
        name: options.name,
        target: { kind: "runner", handler_key: options.handlerKey },
        schedule: { kind: "interval", seconds: NEVER_SOON_INTERVAL_SECONDS },
        missed_run: { policy: "skip" },
        delivery_mode: { mode: "one_runner" },
        delivery_timeout_seconds: options.deliveryTimeoutSeconds ?? DEFAULT_DELIVERY_TIMEOUT_SECONDS,
        lateness_threshold_seconds: LATENESS_THRESHOLD_SECONDS,
      },
    });
    if (!data) throw new Error(`creating job failed: ${JSON.stringify(error)}`);
    return data.id;
  }

  async triggerRun(jobId: string): Promise<JobRun> {
    const { data, error } = await this.client.POST("/api/jobs/{job_id}/runs", { params: { path: { job_id: jobId } } });
    if (!data) throw new Error(`triggering run failed: ${JSON.stringify(error)}`);
    return data;
  }

  async listRuns(jobId: string): Promise<JobRun[]> {
    const { data, error } = await this.client.GET("/api/jobs/{job_id}/runs", { params: { path: { job_id: jobId } } });
    if (!data) throw new Error(`listing runs failed: ${JSON.stringify(error)}`);
    return data.runs;
  }

  async getRun(jobId: string, runId: string): Promise<JobRun> {
    const run = (await this.listRuns(jobId)).find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`run ${runId} is not listed for job ${jobId}`);
    return run;
  }

  /** Polls until the run is in one of `statuses`; fails with the last state on timeout. */
  async waitForRun(jobId: string, runId: string, statuses: readonly RunStatus[], timeoutMs: number): Promise<JobRun> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await this.getRun(jobId, runId);
      if (statuses.includes(run.status)) return run;
      if (Date.now() > deadline) {
        throw new Error(`run ${runId} is ${run.status}, expected ${statuses.join("|")} within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}
