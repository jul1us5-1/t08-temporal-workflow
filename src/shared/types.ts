/**
 * Tipos compartidos entre el workflow, las activities y los clientes.
 *
 * T-08 solo orquesta: estos tipos describen lo que el workflow necesita saber
 * de cada componente dueño de la regla de negocio (Policy T-06, Payment
 * Session Manager T-07, Protocol/Rail T-09..T-13, Ledger T-14,
 * Reconciliation T-15, Chain Indexer T-16). Ninguna regla vive aquí.
 */

/** Montos siempre en unidades mínimas (string para no perder precisión). */
export interface Money {
  amount: string;
  currency: string; // p.ej. "USDC", "PEN", "USD"
}

export interface PaymentRequest {
  /** Id del pago. También es el workflowId, lo que da idempotencia de extremo a extremo. */
  paymentId: string;
  /** Sesión de pago (T-07) que otorga la autoridad de gasto. */
  sessionId: string;
  /** Mandato AP2 (T-04) ya validado aguas arriba; el workflow solo lo propaga. */
  mandateId?: string;
  buyerAgentId: string;
  merchantId: string;
  amount: Money;
  /** Propuesta de protocolo / rail ya normalizada (T-09..T-12). */
  protocol?: string; // p.ej. "x402", "MPP"
  rail?: string; // p.ej. "base-usdc", "card"
  metadata?: Record<string, string>;
}

export interface OrchestrationOptions {
  /** Cuánto esperar una aprobación humana cuando Policy responde REVIEW. */
  approvalTimeout: string; // formato ms de Temporal: "24h", "30m"...
  /** Cuánto esperar la liquidación (señal del Chain Indexer o sondeo al rail). */
  settlementTimeout: string;
  /** Intervalo de sondeo al rail mientras no llega la señal de liquidación. */
  settlementPollInterval: string;
  /** Cuánto esperar a que Reconciliation confirme el match antes de marcar revisión. */
  reconciliationTimeout: string;
}

export const DEFAULT_OPTIONS: OrchestrationOptions = {
  approvalTimeout: '24h',
  settlementTimeout: '30m',
  settlementPollInterval: '30s',
  reconciliationTimeout: '1h',
};

// ----- Respuestas de los componentes (contratos) -----

export type PolicyDecision =
  | { outcome: 'ALLOW'; decisionId: string }
  | { outcome: 'DENY'; decisionId: string; reason: string }
  | { outcome: 'REVIEW'; decisionId: string; reason: string };

export interface Reservation {
  reservationId: string;
  expiresAt?: string;
}

export type RailSubmission =
  | { status: 'SETTLED'; externalRef: string; txHash?: string }
  | { status: 'PENDING'; externalRef: string; txHash?: string };

export type SettlementStatus =
  | { status: 'PENDING' }
  | { status: 'SETTLED'; txHash?: string; settledAt?: string }
  | { status: 'FAILED'; reason: string };

export type ReconciliationResult =
  | { status: 'MATCHED' }
  | { status: 'PENDING' }
  | { status: 'MISMATCH'; reason: string };

// ----- Señales que recibe el workflow -----

export interface ApprovalSignal {
  approved: boolean;
  approverId: string;
  comment?: string;
}

export interface SettlementSignal {
  /** Enviada por el Chain Indexer (T-16) o un webhook del rail. */
  externalRef: string;
  status: 'SETTLED' | 'FAILED';
  txHash?: string;
  reason?: string;
}

// ----- Estado observable (query) y resultado -----

export type PaymentStage =
  | 'INITIATED'
  | 'POLICY_CHECK'
  | 'AWAITING_APPROVAL'
  | 'RESERVED'
  | 'EXECUTING'
  | 'AWAITING_SETTLEMENT'
  | 'SETTLED'
  | 'RECONCILING'
  | 'COMPLETED'
  | 'COMPENSATING'
  | 'FAILED'
  | 'REJECTED'
  | 'CANCELLED';

export interface PaymentStatus {
  paymentId: string;
  stage: PaymentStage;
  reservationId?: string;
  externalRef?: string;
  txHash?: string;
  policyDecisionId?: string;
  reconciliation?: 'MATCHED' | 'NEEDS_REVIEW';
  failureReason?: string;
  compensations: string[];
  history: { stage: PaymentStage; at: string }[];
}

export type PaymentOutcome = 'COMPLETED' | 'REJECTED' | 'FAILED' | 'CANCELLED';

export interface PaymentResult {
  paymentId: string;
  outcome: PaymentOutcome;
  status: PaymentStatus;
}

/** Tipos de error de aplicación que NO deben reintentarse. */
export const NON_RETRYABLE_ERRORS = [
  'PolicyDenied',
  'InsufficientAuthority',
  'SessionExpired',
  'SessionRevoked',
  'RailRejected',
  'ValidationError',
] as const;
export type NonRetryableErrorType = (typeof NON_RETRYABLE_ERRORS)[number];

export const TASK_QUEUE = 'payments-orchestration';
