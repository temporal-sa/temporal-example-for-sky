import { ApplicationFailure } from '@temporalio/common';
import { DefaultLogger, type LogEntry, NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { createActivities } from './activities.js';
import { requiredEnv, temporalConfig } from './config.js';

const NOISY_FIELDS = new Set(['sdkComponent', 'taskQueue', 'namespace', 'workflowType', 'runId', 'workflowRunId', 'taskToken', 'isLocal', 'activityId']);

// logfmt, one line per step, so `docker compose logs worker` reads as each line's story.
// Activity failures from a simulated outage are expected: say what Temporal does next instead of
// printing them as errors.
function logfmt(entry: LogEntry): void {
  let message = entry.message;
  let level = entry.level;
  const meta: Record<string, unknown> = { ...entry.meta };
  if (message === 'Activity failed') {
    const error = meta.error as ApplicationFailure | Error | undefined;
    const permanent = error instanceof ApplicationFailure && error.nonRetryable;
    message = permanent ? 'activity failed permanently; the Workflow handles it' : 'activity attempt failed; Temporal will retry it';
    level = 'WARN';
    meta.error = error?.message;
  }
  const fields = Object.entries(meta)
    .filter(([key, value]) => value !== undefined && !NOISY_FIELDS.has(key))
    .map(([key, value]) => `${key}=${JSON.stringify(typeof value === 'object' ? JSON.stringify(value) : value)}`);
  console.log([`level=${level}`, `msg=${JSON.stringify(message)}`, ...fields].join(' '));
}

Runtime.install({ logger: new DefaultLogger('INFO', logfmt) });

const taskQueue = requiredEnv('TEMPORAL_TASK_QUEUE');
const downstreamUrl = requiredEnv('DOWNSTREAM_URL');
const { connectionOptions, namespace } = temporalConfig();

const connection = await NativeConnection.connect(connectionOptions);

const worker = await Worker.create({
  connection,
  namespace,
  taskQueue,
  workflowsPath: new URL('./workflows.ts', import.meta.url).pathname,
  activities: createActivities(downstreamUrl),
});

await worker.run();
