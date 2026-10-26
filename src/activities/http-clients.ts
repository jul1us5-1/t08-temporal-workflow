/**
 * Implementación HTTP de los puertos. Las rutas son una PROPUESTA de contrato
 * para acordar con cada equipo (ver docs/contratos.md); cámbialas aquí cuando
 * los otros módulos publiquen sus APIs definitivas.
 *
 * Convención de errores esperada de los otros servicios:
 *   4xx con cuerpo { "error": "<TipoNoReintentable>", "message": "..." } → DomainError
 *   5xx / red / timeout → se reintenta (lo decide Temporal)
 */
import { DomainError, isNonRetryableType } from '../shared/errors';
import {
  Money,
  PaymentRequest,
  PolicyDecision,
  RailSubmission,
  ReconciliationResult,
  Reservation,
  SettlementStatus,
} from '../shared/types';
import { LedgerEvent, Ports } from './ports';

export interface ServiceUrls {
  policy: string; // T-06
  session: string; // T-07
  rail: string; // T-13 (o el gateway de IMP-08)
  ledger: string; // T-14
  reconciliation: string; // T-15
}

export function serviceUrlsFromEnv(env = process.env): ServiceUrls {
  const get = (name: string, fallback: string) => env[name] ?? fallback;
  return {
    policy: get('POLICY_URL', 'http://localhost:8106'),
    session: get('PAYMENT_SESSION_URL', 'http://localhost:8107'),
    rail: get('RAIL_URL', 'http://localhost:8113'),
    ledger: get('LEDGER_URL', 'http://localhost:8114'),
    reconciliation: get('RECONCILIATION_URL', 'http://localhost:8115'),
  };
}

async function request<T>(
  base: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const res = await fetch(new URL(path, base), {
    method,
    headers: {
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (res.ok) return json as T;
  if (res.status >= 400 && res.status < 500 && isNonRetryableType(json?.error)) {
    throw new DomainError(json.error, json.message ?? `${method} ${path} → ${res.status}`);
  }
  throw new Error(`${method} ${base}${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
}

export function createHttpPorts(urls: ServiceUrls): Ports {
  return {
    policy: {
      evaluate: (req: PaymentRequest) =>
        request<PolicyDecision>(urls.policy, 'POST', '/v1/decisions', req),
    },
    session: {
      reserve: (sessionId: string, amount: Money, k: string) =>
        request<Reservation>(urls.session, 'POST', `/v1/sessions/${encodeURIComponent(sessionId)}/reservations`, { amount }, k),
      consume: (reservationId: string, k: string) =>
        request<void>(urls.session, 'POST', `/v1/reservations/${encodeURIComponent(reservationId)}/consume`, {}, k),
      release: (reservationId: string, reason: string, k: string) =>
        request<void>(urls.session, 'POST', `/v1/reservations/${encodeURIComponent(reservationId)}/release`, { reason }, k),
    },
    rail: {
      execute: (req: PaymentRequest, reservationId: string, k: string) =>
        request<RailSubmission>(urls.rail, 'POST', '/v1/payments', { ...req, reservationId }, k),
      getStatus: (externalRef: string) =>
        request<SettlementStatus>(urls.rail, 'GET', `/v1/payments/${encodeURIComponent(externalRef)}`),
      reverse: (executionKey: string, externalRef: string | undefined, reason: string, k: string) =>
        request<void>(urls.rail, 'POST', '/v1/payments/reverse', { executionKey, externalRef, reason }, k),
    },
    ledger: {
      record: (paymentId: string, event: LedgerEvent, data: Record<string, string | undefined>, k: string) =>
        request<void>(urls.ledger, 'POST', `/v1/payments/${encodeURIComponent(paymentId)}/events`, { event, data }, k),
    },
    reconciliation: {
      reconcile: (paymentId: string, externalRef: string, k: string) =>
        request<ReconciliationResult>(urls.reconciliation, 'POST', '/v1/matches', { paymentId, externalRef }, k),
    },
  };
}
