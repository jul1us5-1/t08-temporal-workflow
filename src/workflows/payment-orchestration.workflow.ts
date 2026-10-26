/**
 * T-08 · IMP-07 · Workflow de orquestación de pagos.
 *
 *   policy → reserve → execute → wait → (retry) → settle → reconcile
 *                         └──────── compensate (saga) ────────┘
 *
 * Reglas de diseño:
 *  1. El workflow no contiene reglas de negocio: pregunta a Policy (T-06),
 *     reserva en Payment Session Manager (T-07), ejecuta vía Rail (T-13),
 *     registra en Ledger (T-14) y aplica las intenciones que emite
 *     Reconciliation (T-15) por la señal `reconciliationIntent`.
 *  2. Toda llamada lleva una idempotencyKey determinista `${paymentId}:${paso}`,
 *     así un reintento de Temporal nunca duplica un efecto.
 *  3. Cada efecto con reverso registra su compensación ANTES de continuar;
 *     ante un fallo o cancelación se ejecutan en orden inverso, sin poder
 *     ser canceladas y con reintentos ilimitados.
 *  4. Una vez liquidado, el pago no se revierte automáticamente: cualquier
 *     discrepancia queda como excepción de conciliación (NEEDS_REVIEW).
 *  5. Todo motivo de fallo empieza con un código AGP-ORC (src/errors/taxonomy.ts)
 *     o, si viene de T-15, conserva su código AGP-REC.
 */
import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  log,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { Activities } from '../activities';
import {
  ApprovalSignal,
  DEFAULT_OPTIONS,
  ERROR_CODES,
  NON_RETRYABLE_ERRORS,
  OrchestrationOptions,
  PaymentRequest,
  PaymentResult,
  PaymentStage,
  PaymentStatus,
  ReconciliationIntent,
  SettlementSignal,
} from '../shared/types';

// ----- Señales y queries públicas -----

export const approvalSignal = defineSignal<[ApprovalSignal]>('approval');
export const settlementSignal = defineSignal<[SettlementSignal]>('settlement');
/** Intenciones de T-15 (ap-reconciliation-service, WorkflowPort). */
export const reconciliationIntentSignal = defineSignal<[ReconciliationIntent]>('reconciliationIntent');
export const statusQuery = defineQuery<PaymentStatus>('status');

// ----- Activities con sus políticas de reintento -----

/** Llamadas normales: reintento exponencial acotado; errores de negocio no se reintentan. */
const acts = proxyActivities<Activities>({
  startToCloseTimeout: '30s',
  retry: {
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '1m',
    maximumAttempts: 8,
    nonRetryableErrorTypes: [...NON_RETRYABLE_ERRORS],
  },
});

/** Envío al rail: más tiempo, con heartbeat para detectar workers caídos. */
const railActs = proxyActivities<Activities>({
  startToCloseTimeout: '2m',
  heartbeatTimeout: '30s',
  retry: {
    initialInterval: '2s',
    backoffCoefficient: 2,
    maximumInterval: '1m',
    maximumAttempts: 5,
    nonRetryableErrorTypes: [...NON_RETRYABLE_ERRORS],
  },
});

/** Compensaciones y registros finales: deben terminar, así que se reintentan sin límite. */
const mustSucceed = proxyActivities<Activities>({
  startToCloseTimeout: '1m',
  // Sin maximumAttempts = reintentos ilimitados (acotados solo por el workflow).
  retry: { initialInterval: '2s', backoffCoefficient: 2, maximumInterval: '5m' },
});

// ----- Workflow -----

export async function paymentOrchestrationWorkflow(
  req: PaymentRequest,
  opts: Partial<OrchestrationOptions> = {},
): Promise<PaymentResult> {
  const options: OrchestrationOptions = { ...DEFAULT_OPTIONS, ...opts };
  const { paymentId } = req;
  const key = (step: string) => `${paymentId}:${step}`;

  const status: PaymentStatus = {
    paymentId,
    stage: 'INITIATED',
    compensations: [],
    history: [],
    appliedIntents: [],
  };
  const setStage = (stage: PaymentStage) => {
    status.stage = stage;
    status.history.push({ stage, at: new Date().toISOString() }); // Date es determinista dentro de workflows
  };
  setStage('INITIATED');

  let approval: ApprovalSignal | undefined;
  const settlements = new Map<string, SettlementSignal>();
  const intents: ReconciliationIntent[] = [];
  const seenIntents = new Set<string>();

  setHandler(statusQuery, () => status);
  setHandler(approvalSignal, (s) => {
    approval ??= s; // la primera decisión gana
  });
  setHandler(settlementSignal, (s) => {
    settlements.set(s.externalRef, s);
  });
  setHandler(reconciliationIntentSignal, (i) => {
    // T-15 entrega at-least-once: se descartan duplicados por intent_id.
    if (i.payment_id !== paymentId || seenIntents.has(i.intent_id)) return;
    seenIntents.add(i.intent_id);
    intents.push(i);
  });

  const finish = (outcome: PaymentResult['outcome']): PaymentResult => ({ paymentId, outcome, status });

  // ---------- 1. Policy (T-06) ----------
  // Cancelar aquí es seguro: aún no hay efectos que compensar.
  try {
    await acts.recordLedgerEvent(paymentId, 'PAYMENT_INITIATED', ledgerData(req), key('ledger:initiated'));
    setStage('POLICY_CHECK');
    const decision = await acts.evaluatePolicy(req);
    status.policyDecisionId = decision.decisionId;

    if (decision.outcome === 'REVIEW') {
      setStage('AWAITING_APPROVAL');
      const gotAnswer = await condition(() => approval !== undefined, ms(options.approvalTimeout));
      if (!gotAnswer || !approval?.approved) {
        const reason = !gotAnswer
          ? `${ERROR_CODES.APPROVAL_TIMEOUT}: sin respuesta tras ${options.approvalTimeout}`
          : `${ERROR_CODES.APPROVAL_REJECTED}: rechazado por ${approval?.approverId}`;
        return await reject(reason);
      }
    } else if (decision.outcome === 'DENY') {
      return await reject(`${ERROR_CODES.POLICY_DENIED}: ${decision.reason}`);
    }
  } catch (err) {
    if (!isCancellation(err)) throw err;
    return await CancellationScope.nonCancellable(async () => {
      await reject('cancelled');
      setStage('CANCELLED');
      return finish('CANCELLED');
    });
  }

  // ---------- 2..5. Saga: reserve → execute → wait → settle ----------
  const compensations: { name: string; run: () => Promise<void> }[] = [];
  const executionKey = key('execute');

  try {
    // 2. Reserve (T-07)
    const reservation = await acts.reserveFunds(req.sessionId, req.amount, key('reserve'));
    status.reservationId = reservation.reservationId;
    compensations.push({
      name: 'release_reservation',
      run: async () => {
        await mustSucceed.releaseReservation(reservation.reservationId, 'payment_not_completed', key('release'));
        await mustSucceed.recordLedgerEvent(
          paymentId,
          'RESERVATION_RELEASED',
          { reservationId: reservation.reservationId },
          key('ledger:released'),
        );
      },
    });
    setStage('RESERVED');
    await acts.recordLedgerEvent(
      paymentId,
      'FUNDS_RESERVED',
      { reservationId: reservation.reservationId },
      key('ledger:reserved'),
    );

    // 3. Execute (T-09..T-13). La compensación se registra antes de llamar,
    //    porque un fallo ambiguo puede haber dejado el envío en curso.
    compensations.push({
      name: 'reverse_payment',
      run: async () => {
        await mustSucceed.reversePayment(executionKey, status.externalRef, 'payment_not_completed', key('reverse'));
        await mustSucceed.recordLedgerEvent(
          paymentId,
          'PAYMENT_REVERSED',
          { externalRef: status.externalRef },
          key('ledger:reversed'),
        );
      },
    });
    setStage('EXECUTING');
    const submission = await railActs.executePayment(req, reservation.reservationId, executionKey);
    status.externalRef = submission.externalRef;
    status.txHash = submission.txHash;
    await acts.recordLedgerEvent(
      paymentId,
      'PAYMENT_SUBMITTED',
      { externalRef: submission.externalRef, txHash: submission.txHash },
      key('ledger:submitted'),
    );

    // 4. Wait: señal del Chain Indexer (T-16) o sondeo periódico al rail.
    if (submission.status !== 'SETTLED') {
      setStage('AWAITING_SETTLEMENT');
      await waitForSettlement(submission.externalRef);
    }

    // 5. Settle: el dinero ya se movió, no hay vuelta atrás automática.
    //    Por eso estos pasos usan reintentos ilimitados y no compensan.
    compensations.length = 0;
    await mustSucceed.consumeReservation(reservation.reservationId, key('consume'));
    setStage('SETTLED');
    await mustSucceed.recordLedgerEvent(
      paymentId,
      'PAYMENT_SETTLED',
      { externalRef: status.externalRef, txHash: status.txHash },
      key('ledger:settled'),
    );
  } catch (err) {
    const cancelled = isCancellation(err);
    status.failureReason = cancelled ? 'cancelled' : describe(err);
    log.warn('Pago fallido, compensando', { paymentId, reason: status.failureReason });

    setStage('COMPENSATING');
    // No cancelable: aunque el workflow se cancele, las compensaciones deben terminar.
    await CancellationScope.nonCancellable(async () => {
      for (const c of [...compensations].reverse()) {
        await c.run();
        status.compensations.push(c.name);
      }
      await mustSucceed.recordLedgerEvent(
        paymentId,
        'PAYMENT_FAILED',
        { reason: status.failureReason },
        key('ledger:failed'),
      );
    });
    setStage(cancelled ? 'CANCELLED' : 'FAILED');
    return finish(cancelled ? 'CANCELLED' : 'FAILED');
  }

  // ---------- 6. Reconcile (T-15) ----------
  setStage('RECONCILING');
  status.reconciliation = await reconcile(status.externalRef!);
  await mustSucceed.recordLedgerEvent(
    paymentId,
    status.reconciliation === 'MATCHED' ? 'PAYMENT_RECONCILED' : 'RECONCILIATION_EXCEPTION',
    { externalRef: status.externalRef, code: status.reconciliationCode, reason: status.failureReason },
    key('ledger:reconciled'),
  );
  setStage('COMPLETED');
  return finish('COMPLETED');

  // ----- helpers (cierran sobre el estado del workflow) -----

  async function reject(reason: string): Promise<PaymentResult> {
    status.failureReason = reason;
    await mustSucceed.recordLedgerEvent(paymentId, 'PAYMENT_REJECTED', { reason }, key('ledger:rejected'));
    setStage('REJECTED');
    return finish('REJECTED');
  }

  async function waitForSettlement(externalRef: string): Promise<void> {
    const deadline = Date.now() + ms(options.settlementTimeout);
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw ApplicationFailure.create({ type: ERROR_CODES.SETTLEMENT_TIMEOUT, message: `sin liquidación tras ${options.settlementTimeout}` });
      }
      // Espera la señal o el próximo sondeo, lo que ocurra primero.
      await condition(() => settlements.has(externalRef), Math.min(remaining, ms(options.settlementPollInterval)));

      const signalled = settlements.get(externalRef);
      const observed = signalled
        ? signalled.status === 'SETTLED'
          ? ({ status: 'SETTLED', txHash: signalled.txHash } as const)
          : ({ status: 'FAILED', reason: signalled.reason ?? 'failed_on_chain' } as const)
        : await acts.getSettlementStatus(externalRef);

      if (observed.status === 'SETTLED') {
        status.txHash = observed.txHash ?? status.txHash;
        return;
      }
      if (observed.status === 'FAILED') {
        throw ApplicationFailure.create({ type: ERROR_CODES.SETTLEMENT_FAILED, message: observed.reason, nonRetryable: true });
      }
    }
  }

  /**
   * Aplica las intenciones de T-15 hasta llegar a una final.
   * T-15 decide (compara ledger vs fuente externa); T-08 solo actúa.
   */
  async function reconcile(externalRef: string): Promise<'MATCHED' | 'NEEDS_REVIEW'> {
    let deadline = Date.now() + ms(options.reconciliationTimeout);
    for (;;) {
      const remaining = deadline - Date.now();
      const got = remaining > 0 && (await condition(() => intents.length > 0, remaining));
      if (!got) {
        status.reconciliationCode = ERROR_CODES.RECONCILIATION_TIMEOUT;
        status.failureReason = `${ERROR_CODES.RECONCILIATION_TIMEOUT}: sin intención final de T-15 tras ${options.reconciliationTimeout}`;
        return 'NEEDS_REVIEW';
      }
      const intent = intents.shift()!;
      status.appliedIntents.push(intent.intent_id);

      switch (intent.kind) {
        case 'RECONCILED':
          return 'MATCHED';
        case 'REQUIRES_REVIEW':
          status.reconciliationCode = intent.code ?? ERROR_CODES.RECONCILIATION_REVIEW_REQUIRED;
          status.failureReason = `${ERROR_CODES.RECONCILIATION_REVIEW_REQUIRED}: ${intent.code ?? ''} ${intent.reason}`.trim();
          return 'NEEDS_REVIEW';
        case 'RETRY':
          // T-15 reprograma la observación (2001/4001/4002/9001); seguimos esperando.
          continue;
        case 'REOPEN_COMPENSATE':
          // Reorg o finality: el pago se reabre y se vuelve a esperar la liquidación.
          // Nunca se marca RECONCILED sin una nueva intención de T-15.
          setStage('REOPENED');
          await mustSucceed.recordLedgerEvent(
            paymentId,
            'PAYMENT_REOPENED',
            { externalRef, code: intent.code ?? undefined, evidence: intent.evidence },
            key(`ledger:reopened:${intent.intent_id}`),
          );
          settlements.delete(externalRef);
          try {
            await waitForSettlement(externalRef);
          } catch (err) {
            status.reconciliationCode = ERROR_CODES.REORG_UNRESOLVED;
            status.failureReason = `${ERROR_CODES.REORG_UNRESOLVED}: ${describe(err)}`;
            return 'NEEDS_REVIEW';
          }
          setStage('RECONCILING');
          deadline = Date.now() + ms(options.reconciliationTimeout);
          continue;
      }
    }
  }
}

// ----- utilidades puras -----

function ledgerData(req: PaymentRequest): Record<string, string | undefined> {
  return {
    sessionId: req.sessionId,
    mandateId: req.mandateId,
    buyerAgentId: req.buyerAgentId,
    merchantId: req.merchantId,
    amount: req.amount.amount,
    currency: req.amount.currency,
    protocol: req.protocol,
    rail: req.rail,
    workflowRunId: workflowInfo().runId,
  };
}

function describe(err: unknown): string {
  const cause = err instanceof ActivityFailure ? err.cause : err;
  if (cause instanceof ApplicationFailure) return `${cause.type ?? 'Error'}: ${cause.message}`;
  return cause instanceof Error ? cause.message : String(cause);
}

/** Convierte "30s" / "5m" / "24h" / "500ms" / número (ms) en milisegundos. */
export function ms(d: string | number): number {
  if (typeof d === 'number') return d;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(d.trim());
  if (!m) throw ApplicationFailure.create({ type: ERROR_CODES.INVALID_REQUEST, message: `duración inválida: ${d}`, nonRetryable: true });
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'ms' | 's' | 'm' | 'h' | 'd'];
  return n * unit;
}
