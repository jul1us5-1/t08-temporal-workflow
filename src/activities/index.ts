/**
 * Activities del worker T-08: adaptadores finos sobre los puertos.
 *
 * Responsabilidad de esta capa:
 *  - traducir errores de negocio (DomainError) a ApplicationFailure no reintentable;
 *  - dejar que el resto de errores (red, 5xx, timeouts) se reintenten según la
 *    RetryPolicy declarada en el workflow;
 *  - emitir heartbeat en llamadas que pueden tardar.
 *
 * No contiene reglas de negocio.
 */
import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import { DomainError } from '../shared/errors';
import {
  Money,
  PaymentRequest,
  PolicyDecision,
  RailSubmission,
  Reservation,
  SettlementStatus,
} from '../shared/types';
import { LedgerEvent, Ports } from './ports';

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DomainError) {
      throw ApplicationFailure.create({ type: err.type, message: err.message, nonRetryable: true });
    }
    throw err;
  }
}

export function createActivities(ports: Ports) {
  return {
    async evaluatePolicy(req: PaymentRequest): Promise<PolicyDecision> {
      return call(() => ports.policy.evaluate(req));
    },

    async reserveFunds(sessionId: string, amount: Money, idempotencyKey: string): Promise<Reservation> {
      return call(() => ports.session.reserve(sessionId, amount, idempotencyKey));
    },

    async consumeReservation(reservationId: string, idempotencyKey: string): Promise<void> {
      return call(() => ports.session.consume(reservationId, idempotencyKey));
    },

    async releaseReservation(reservationId: string, reason: string, idempotencyKey: string): Promise<void> {
      return call(() => ports.session.release(reservationId, reason, idempotencyKey));
    },

    async executePayment(req: PaymentRequest, reservationId: string, idempotencyKey: string): Promise<RailSubmission> {
      heartbeat('submitting');
      return call(() => ports.rail.execute(req, reservationId, idempotencyKey));
    },

    async getSettlementStatus(externalRef: string): Promise<SettlementStatus> {
      return call(() => ports.rail.getStatus(externalRef));
    },

    async reversePayment(
      executionKey: string,
      externalRef: string | undefined,
      reason: string,
      idempotencyKey: string,
    ): Promise<void> {
      heartbeat('reversing');
      return call(() => ports.rail.reverse(executionKey, externalRef, reason, idempotencyKey));
    },

    async recordLedgerEvent(
      paymentId: string,
      event: LedgerEvent,
      data: Record<string, string | undefined>,
      idempotencyKey: string,
    ): Promise<void> {
      return call(() => ports.ledger.record(paymentId, event, data, idempotencyKey));
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
