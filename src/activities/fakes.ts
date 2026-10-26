/**
 * Implementación en memoria de los puertos, para tests y para correr el
 * worker en local sin los demás microservicios (`PORTS=fake`).
 *
 * Es idempotente como deben serlo los servicios reales: repetir una llamada
 * con la misma idempotencyKey devuelve el mismo resultado sin repetir el efecto.
 */
import { DomainError } from '../shared/errors';
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

export interface FakeBehaviour {
  policy: PolicyDecision['outcome'];
  /** Si true, reserve responde InsufficientAuthority. */
  insufficientAuthority: boolean;
  /** Nº de veces que execute falla con error transitorio antes de funcionar. */
  railTransientFailures: number;
  /** Si true, el rail rechaza el pago (no reintentable). */
  railRejects: boolean;
  /** Estado inicial del envío al rail. */
  railSubmission: 'SETTLED' | 'PENDING';
  /** Qué devuelve getStatus mientras está PENDING; null = nunca cambia. */
  settlesAfterPolls: number | null;
  settlementFails: boolean;
  reconciliation: ReconciliationResult['status'];
}

export const DEFAULT_BEHAVIOUR: FakeBehaviour = {
  policy: 'ALLOW',
  insufficientAuthority: false,
  railTransientFailures: 0,
  railRejects: false,
  railSubmission: 'SETTLED',
  settlesAfterPolls: 0,
  settlementFails: false,
  reconciliation: 'MATCHED',
};

export interface FakeState {
  calls: string[];
  ledger: { paymentId: string; event: LedgerEvent; data: Record<string, string | undefined> }[];
  reservations: Map<string, { sessionId: string; amount: Money; status: 'RESERVED' | 'CONSUMED' | 'RELEASED' }>;
  effects: Map<string, unknown>; // idempotencyKey → resultado
}

export function createFakePorts(overrides: Partial<FakeBehaviour> = {}): { ports: Ports; state: FakeState; behaviour: FakeBehaviour } {
  const behaviour = { ...DEFAULT_BEHAVIOUR, ...overrides };
  const state: FakeState = { calls: [], ledger: [], reservations: new Map(), effects: new Map() };
  let railFailuresLeft = behaviour.railTransientFailures;
  let polls = 0;

  const once = async <T>(k: string, fn: () => T | Promise<T>): Promise<T> => {
    if (state.effects.has(k)) return state.effects.get(k) as T;
    const r = await fn();
    state.effects.set(k, r);
    return r;
  };

  const ports: Ports = {
    policy: {
      async evaluate(req: PaymentRequest): Promise<PolicyDecision> {
        state.calls.push('policy.evaluate');
        const decisionId = `dec_${req.paymentId}`;
        if (behaviour.policy === 'ALLOW') return { outcome: 'ALLOW', decisionId };
        return { outcome: behaviour.policy, decisionId, reason: `fake_${behaviour.policy.toLowerCase()}` };
      },
    },
    session: {
      async reserve(sessionId: string, amount: Money, k: string): Promise<Reservation> {
        state.calls.push('session.reserve');
        if (behaviour.insufficientAuthority) throw new DomainError('InsufficientAuthority', 'saldo de sesión insuficiente');
        return once(k, () => {
          const reservationId = `res_${state.reservations.size + 1}`;
          state.reservations.set(reservationId, { sessionId, amount, status: 'RESERVED' });
          return { reservationId };
        });
      },
      async consume(reservationId: string, k: string) {
        state.calls.push('session.consume');
        await once(k, () => {
          state.reservations.get(reservationId)!.status = 'CONSUMED';
        });
      },
      async release(reservationId: string, _reason: string, k: string) {
        state.calls.push('session.release');
        await once(k, () => {
          state.reservations.get(reservationId)!.status = 'RELEASED';
        });
      },
    },
    rail: {
      async execute(req: PaymentRequest, _reservationId: string, k: string): Promise<RailSubmission> {
        state.calls.push('rail.execute');
        if (behaviour.railRejects) throw new DomainError('RailRejected', 'el rail rechazó el pago');
        if (railFailuresLeft > 0) {
          railFailuresLeft--;
          throw new Error('rail no disponible (transitorio)');
        }
        return once(k, () => ({ status: behaviour.railSubmission, externalRef: `ext_${req.paymentId}`, txHash: '0xabc' }));
      },
      async getStatus(): Promise<SettlementStatus> {
        state.calls.push('rail.getStatus');
        if (behaviour.settlementFails) return { status: 'FAILED', reason: 'reverted_on_chain' };
        if (behaviour.settlesAfterPolls === null) return { status: 'PENDING' };
        polls++;
        return polls > behaviour.settlesAfterPolls ? { status: 'SETTLED', txHash: '0xdef' } : { status: 'PENDING' };
      },
      async reverse(_executionKey: string, _externalRef: string | undefined, _reason: string, k: string) {
        state.calls.push('rail.reverse');
        await once(k, () => undefined);
      },
    },
    ledger: {
      async record(paymentId: string, event: LedgerEvent, data: Record<string, string | undefined>, k: string) {
        await once(k, () => {
          state.ledger.push({ paymentId, event, data });
        });
      },
    },
    reconciliation: {
      async reconcile(): Promise<ReconciliationResult> {
        state.calls.push('reconciliation.reconcile');
        const s = behaviour.reconciliation;
        return s === 'MISMATCH' ? { status: 'MISMATCH', reason: 'amount_differs' } : { status: s };
      },
    },
  };
  return { ports, state, behaviour };
}
