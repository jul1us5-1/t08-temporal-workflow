/**
 * Worker T-08. Variables de entorno:
 *   TEMPORAL_ADDRESS   (default localhost:7233)
 *   TEMPORAL_NAMESPACE (default "default")
 *   TASK_QUEUE         (default "payments-orchestration")
 *   PORTS=fake         usa los puertos en memoria (demo sin otros servicios)
 *   POLICY_URL, PAYMENT_SESSION_URL, RAIL_URL, LEDGER_URL, RECONCILIATION_URL
 */
import { NativeConnection, Worker } from '@temporalio/worker';
import { createActivities } from './activities';
import { createFakePorts } from './activities/fakes';
import { createHttpPorts, serviceUrlsFromEnv } from './activities/http-clients';
import { TASK_QUEUE } from './shared/types';

async function main() {
  const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const ports = process.env.PORTS === 'fake' ? createFakePorts().ports : createHttpPorts(serviceUrlsFromEnv());

  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: process.env.TASK_QUEUE ?? TASK_QUEUE,
    workflowsPath: require.resolve('./workflows'),
    activities: createActivities(ports),
  });

  console.log(`Worker T-08 escuchando en "${worker.options.taskQueue}" (puertos: ${process.env.PORTS ?? 'http'})`);
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
