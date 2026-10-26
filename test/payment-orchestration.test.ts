/**
 * Tests de integración del workflow contra un servidor Temporal real en memoria.
 *
 * Por defecto usa el servidor de test con "time skipping" (lo descarga el SDK).
 * Si defines TEMPORAL_CLI_PATH=/ruta/a/temporal, usa ese binario como dev server
 * local (útil sin internet); los timeouts de los tests son cortos para ello.
 */
import { randomUUID } from 'node:crypto';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, DefaultLogger, Worker } from '@temporalio/worker';
import { createActivities } from '../src/activities';
import { createFakePorts, FakeBehaviour, FakeState } from '../src/activities/fakes';
import { ERROR_CODES, OrchestrationOptions, PaymentRequest, PaymentResult } from '../src/shared/types';
import {
  approvalSignal,
  paymentOrchestrationWorkflow,
  settlementSignal,
  statusQuery,
} from '../src/workflows';

const FAST: Partial<OrchestrationOptions> = {
  approvalTimeout: '3s',
  settlementTimeout: '4s',
  settlementPollInterval: '500ms',
  reconciliationTimeout: '2s',
};

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger('WARN') });
  env = process.env.TEMPORAL_CLI_PATH
    ? await TestWorkflowEnvironment.createLocal({
        server: { executable: { type: 'existing-path', path: process.env.TEMPORAL_CLI_PATH } },
      })
    : await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await env?.teardown();
});

function request(): PaymentRequest {
  const paymentId = `pay_${randomUUID()}`;
  return {
    paymentId,
    sessionId: 'sess_1',
    mandateId: 'mandate_1',
    buyerAgentId: 'agent_1',
    merchantId: 'merchant_1',
    amount: { amount: '1000000', currency: 'USDC' },
    protocol: 'x402',
    rail: 'base-usdc',
  };
}

/** Arranca un worker con puertos falsos y ejecuta `fn` mientras corre. */
async function withWorker<T>(
  behaviour: Partial<FakeBehaviour>,
  fn: (ctx: { taskQueue: string; state: FakeState }) => Promise<T>,
): Promise<T> {
  const { ports, state } = createFakePorts(behaviour);
  const taskQueue = `tq-${randomUUID()}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: require.resolve('../src/workflows'),
    activities: createActivities(ports),
  });
  return worker.runUntil(fn({ taskQueue, state }));
}

async function run(
  behaviour: Partial<FakeBehaviour>,
  opts: Partial<OrchestrationOptions> = FAST,
): Promise<{ result: PaymentResult; state: FakeState }> {
  return withWorker(behaviour, async ({ taskQueue, state }) => {
    const req = request();
    const result = await env.client.workflow.execute(paymentOrchestrationWorkflow, {
      taskQueue,
      workflowId: req.paymentId,
      args: [req, opts],
    });
    return { result, state };
  });
}

const events = (s: FakeState) => s.ledger.map((e) => e.event);
const reservationStatus = (s: FakeState) => [...s.reservations.values()].map((r) => r.status);

describe('T-08 paymentOrchestrationWorkflow', () => {
  test('camino feliz: reserve → execute → settle → reconcile', async () => {
    const { result, state } = await run({});
    expect(result.outcome).toBe('COMPLETED');
    expect(result.status.reconciliation).toBe('MATCHED');
    expect(events(state)).toEqual([
      'PAYMENT_INITIATED',
      'FUNDS_RESERVED',
      'PAYMENT_SUBMITTED',
      'PAYMENT_SETTLED',
      'PAYMENT_RECONCILED',
    ]);
    expect(reservationStatus(state)).toEqual(['CONSUMED']);
    expect(result.status.history.map((h) => h.stage)).toEqual([
      'INITIATED',
      'POLICY_CHECK',
      'RESERVED',
      'EXECUTING',
      'SETTLED',
      'RECONCILING',
      'COMPLETED',
    ]);
  });

  test('Policy DENY: rechaza sin reservar ni ejecutar', async () => {
    const { result, state } = await run({ policy: 'DENY' });
    expect(result.outcome).toBe('REJECTED');
    expect(state.calls).not.toContain('session.reserve');
    expect(events(state)).toEqual(['PAYMENT_INITIATED', 'PAYMENT_REJECTED']);
  });

  test('Policy REVIEW + aprobación humana por señal: continúa', async () => {
    await withWorker({ policy: 'REVIEW' }, async ({ taskQueue, state }) => {
      const req = request();
      const handle = await env.client.workflow.start(paymentOrchestrationWorkflow, {
        taskQueue,
        workflowId: req.paymentId,
        args: [req, { ...FAST, approvalTimeout: '1m' }],
      });
      await waitForStage(handle, 'AWAITING_APPROVAL');
      await handle.signal(approvalSignal, { approved: true, approverId: 'ops_1' });
      const result = await handle.result();
      expect(result.outcome).toBe('COMPLETED');
      expect(reservationStatus(state)).toEqual(['CONSUMED']);
    });
  });

  test('cancelación esperando aprobación: no reserva y registra el rechazo', async () => {
    await withWorker({ policy: 'REVIEW' }, async ({ taskQueue, state }) => {
      const req = request();
      const handle = await env.client.workflow.start(paymentOrchestrationWorkflow, {
        taskQueue,
        workflowId: req.paymentId,
        args: [req, { ...FAST, approvalTimeout: '1m' }],
      });
      await waitForStage(handle, 'AWAITING_APPROVAL');
      await handle.cancel();
      const result = await handle.result();
      expect(result.outcome).toBe('CANCELLED');
      expect(state.calls).not.toContain('session.reserve');
      expect(events(state)).toEqual(['PAYMENT_INITIATED', 'PAYMENT_REJECTED']);
    });
  });

  test('Policy REVIEW sin respuesta: rechaza por timeout', async () => {
    const { result, state } = await run({ policy: 'REVIEW' });
    expect(result.outcome).toBe('REJECTED');
    expect(result.status.failureReason).toBe('approval_timeout');
    expect(state.calls).not.toContain('session.reserve');
  });

  test('sin autoridad de gasto (T-07): falla sin reintentar y sin ejecutar', async () => {
    const { result, state } = await run({ insufficientAuthority: true });
    expect(result.outcome).toBe('FAILED');
    expect(result.status.failureReason).toContain(ERROR_CODES.INSUFFICIENT_AUTHORITY);
    expect(state.calls.filter((c) => c === 'session.reserve')).toHaveLength(1);
    expect(state.calls).not.toContain('rail.execute');
    expect(result.status.compensations).toEqual([]);
  });

  test('fallos transitorios del rail: reintenta y completa', async () => {
    const { result, state } = await run({ railTransientFailures: 2 });
    expect(result.outcome).toBe('COMPLETED');
    expect(state.calls.filter((c) => c === 'rail.execute')).toHaveLength(3);
    expect(events(state).filter((e) => e === 'PAYMENT_SUBMITTED')).toHaveLength(1);
  });

  test('rail rechaza: compensa (reverse + release) en orden inverso', async () => {
    const { result, state } = await run({ railRejects: true });
    expect(result.outcome).toBe('FAILED');
    expect(result.status.compensations).toEqual(['reverse_payment', 'release_reservation']);
    expect(reservationStatus(state)).toEqual(['RELEASED']);
    expect(events(state).slice(-3)).toEqual(['PAYMENT_REVERSED', 'RESERVATION_RELEASED', 'PAYMENT_FAILED']);
  });

  test('pendiente → liquidación confirmada por señal del Chain Indexer', async () => {
    await withWorker({ railSubmission: 'PENDING', settlesAfterPolls: null }, async ({ taskQueue, state }) => {
      const req = request();
      const handle = await env.client.workflow.start(paymentOrchestrationWorkflow, {
        taskQueue,
        workflowId: req.paymentId,
        args: [req, { ...FAST, settlementTimeout: '1m' }],
      });
      await waitForStage(handle, 'AWAITING_SETTLEMENT');
      await handle.signal(settlementSignal, { externalRef: `ext_${req.paymentId}`, status: 'SETTLED', txHash: '0x999' });
      const result = await handle.result();
      expect(result.outcome).toBe('COMPLETED');
      expect(result.status.txHash).toBe('0x999');
      expect(reservationStatus(state)).toEqual(['CONSUMED']);
    });
  });

  test('pendiente → liquidación detectada por sondeo al rail', async () => {
    const { result, state } = await run({ railSubmission: 'PENDING', settlesAfterPolls: 2 });
    expect(result.outcome).toBe('COMPLETED');
    expect(state.calls.filter((c) => c === 'rail.getStatus').length).toBeGreaterThanOrEqual(3);
  });

  test('sin liquidación antes del timeout: compensa', async () => {
    const { result, state } = await run({ railSubmission: 'PENDING', settlesAfterPolls: null });
    expect(result.outcome).toBe('FAILED');
    expect(result.status.failureReason).toContain(ERROR_CODES.SETTLEMENT_TIMEOUT);
    expect(result.status.compensations).toEqual(['reverse_payment', 'release_reservation']);
    expect(reservationStatus(state)).toEqual(['RELEASED']);
  });

  test('liquidación fallida on-chain: compensa', async () => {
    const { result } = await run({ railSubmission: 'PENDING', settlementFails: true });
    expect(result.outcome).toBe('FAILED');
    expect(result.status.failureReason).toContain(ERROR_CODES.SETTLEMENT_FAILED);
    expect(result.status.compensations).toEqual(['reverse_payment', 'release_reservation']);
  });

  test('cancelación durante la espera: compensa aunque el workflow esté cancelado', async () => {
    await withWorker({ railSubmission: 'PENDING', settlesAfterPolls: null }, async ({ taskQueue, state }) => {
      const req = request();
      const handle = await env.client.workflow.start(paymentOrchestrationWorkflow, {
        taskQueue,
        workflowId: req.paymentId,
        args: [req, { ...FAST, settlementTimeout: '1m' }],
      });
      await waitForStage(handle, 'AWAITING_SETTLEMENT');
      await handle.cancel();
      const result = await handle.result();
      expect(result.outcome).toBe('CANCELLED');
      expect(result.status.compensations).toEqual(['reverse_payment', 'release_reservation']);
      expect(reservationStatus(state)).toEqual(['RELEASED']);
    });
  });

  test('conciliación con discrepancia: completa pero marca NEEDS_REVIEW', async () => {
    const { result, state } = await run({ reconciliation: 'MISMATCH' });
    expect(result.outcome).toBe('COMPLETED');
    expect(result.status.reconciliation).toBe('NEEDS_REVIEW');
    expect(events(state).at(-1)).toBe('RECONCILIATION_EXCEPTION');
    expect(reservationStatus(state)).toEqual(['CONSUMED']); // no se revierte un pago liquidado
  });

  test('conciliación que nunca llega: NEEDS_REVIEW por timeout', async () => {
    const { result } = await run({ reconciliation: 'PENDING' });
    expect(result.status.reconciliation).toBe('NEEDS_REVIEW');
    expect(result.status.failureReason).toBe('reconciliation_timeout');
  });

  test('idempotencia: el mismo paymentId no inicia dos pagos', async () => {
    await withWorker({ railSubmission: 'PENDING', settlesAfterPolls: null }, async ({ taskQueue }) => {
      const req = request();
      const opts = { taskQueue, workflowId: req.paymentId, args: [req, { ...FAST, settlementTimeout: '1m' }] as const };
      const handle = await env.client.workflow.start(paymentOrchestrationWorkflow, { ...opts, args: [...opts.args] });
      await waitForStage(handle, 'AWAITING_SETTLEMENT');
      await expect(
        env.client.workflow.start(paymentOrchestrationWorkflow, { ...opts, args: [...opts.args] }),
      ).rejects.toBeInstanceOf(WorkflowExecutionAlreadyStartedError);
      await handle.cancel();
      await handle.result();
    });
  });
});

async function waitForStage(
  handle: { query: (q: typeof statusQuery) => Promise<{ stage: string }> },
  stage: string,
  timeoutMs = 15_000,
) {
  const start = Date.now();
  for (;;) {
    try {
      if ((await handle.query(statusQuery)).stage === stage) return;
    } catch {
      // el workflow aún no procesó su primera tarea
    }
    if (Date.now() - start > timeoutMs) throw new Error(`no llegó a ${stage}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
