/**
 * Cliente de ejemplo: inicia un pago y espera el resultado.
 *   npm run start:payment -- pay_123
 *
 * El workflowId es el paymentId: si se llama dos veces con el mismo id,
 * Temporal rechaza el duplicado (idempotencia de inicio).
 */
import { Client, Connection, WorkflowIdReusePolicy } from '@temporalio/client';
import { paymentOrchestrationWorkflow, statusQuery } from '../workflows';
import { PaymentRequest, TASK_QUEUE } from '../shared/types';

async function main() {
  const paymentId = process.argv[2] ?? `pay_${Date.now()}`;
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });

  const req: PaymentRequest = {
    paymentId,
    sessionId: 'sess_demo',
    mandateId: 'mandate_demo',
    buyerAgentId: 'agent_buyer_1',
    merchantId: 'merchant_1',
    amount: { amount: '1500000', currency: 'USDC' },
    protocol: 'x402',
    rail: 'base-usdc',
  };

  const handle = await client.workflow.start(paymentOrchestrationWorkflow, {
    taskQueue: process.env.TASK_QUEUE ?? TASK_QUEUE,
    workflowId: paymentId,
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    args: [req, { settlementPollInterval: '2s', settlementTimeout: '2m' }],
  });
  console.log(`Iniciado ${handle.workflowId}`);
  console.log('Estado actual:', (await handle.query(statusQuery)).stage);
  const result = await handle.result();
  console.log(JSON.stringify(result, null, 2));
  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
