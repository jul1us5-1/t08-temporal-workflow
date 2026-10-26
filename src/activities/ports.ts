/**
 * Puertos (interfaces) hacia los componentes que son dueños de las reglas.
 *
 * El workflow T-08 nunca decide si un pago es válido, cuánto se puede gastar
 * ni cómo se liquida: delega en estos puertos. Cada puerto tiene una
 * implementación HTTP (http-clients.ts) y una en memoria (fakes.ts).
 *
 * Todas las operaciones que mutan estado reciben `idempotencyKey`, porque
 * Temporal puede ejecutar una activity más de una vez (at-least-once).
 */
import {
  Money,
  PaymentRequest,
  PolicyDecision,
  RailSubmission,
  Reservation,
  SettlementStatus,
} from '../shared/types';

/** T-06 Policy, Compliance & Risk (IMP-05). */
export interface PolicyPort {
  evaluate(req: PaymentRequest): Promise<PolicyDecision>;
}

/** T-07 Payment Session Manager (IMP-06). */
export interface PaymentSessionPort {
  reserve(sessionId: string, amount: Money, idempotencyKey: string): Promise<Reservation>;
  consume(reservationId: string, idempotencyKey: string): Promise<void>;
  release(reservationId: string, reason: string, idempotencyKey: string): Promise<void>;
}

/** T-09..T-13 Protocol Selector / Payment Protocol Adapter / Rail Adapter (IMP-08). */
export interface RailPort {
  execute(req: PaymentRequest, reservationId: string, idempotencyKey: string): Promise<RailSubmission>;
  getStatus(externalRef: string): Promise<SettlementStatus>;
  /**
   * Anula un envío que no llegó a liquidarse. Se identifica por la
   * `executionKey` (la idempotencyKey usada en `execute`) porque si `execute`
   * falló de forma ambigua el workflow no conoce el `externalRef`.
   * Debe ser idempotente y responder OK si no había nada que anular.
   */
  reverse(executionKey: string, externalRef: string | undefined, reason: string, idempotencyKey: string): Promise<void>;
}

/** Eventos que el workflow reporta al Ledger. El Ledger decide los asientos. */
export type LedgerEvent =
  | 'PAYMENT_INITIATED'
  | 'PAYMENT_REJECTED'
  | 'FUNDS_RESERVED'
  | 'PAYMENT_SUBMITTED'
  | 'PAYMENT_SETTLED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_REVERSED'
  | 'RESERVATION_RELEASED'
  | 'PAYMENT_REOPENED'
  | 'PAYMENT_RECONCILED'
  | 'RECONCILIATION_EXCEPTION';

/** T-14 Ledger (IMP-09): fuente de verdad financiera interna. */
export interface LedgerPort {
  record(
    paymentId: string,
    event: LedgerEvent,
    data: Record<string, string | undefined>,
    idempotencyKey: string,
  ): Promise<void>;
}

/*
 * T-15 Reconciliation (IMP-10) no es un puerto de salida: T-15 se activa con el
 * outbox del Ledger y EMITE intenciones hacia T-08, que llegan al workflow como
 * la señal `reconciliationIntent` (ver src/client/deliver-reconciliation-intent.ts).
 */

export interface Ports {
  policy: PolicyPort;
  session: PaymentSessionPort;
  rail: RailPort;
  ledger: LedgerPort;
}
