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
  /** Cuánto esperar una intención final de T-15 (RECONCILED / REQUIRES_REVIEW) antes de marcar revisión. */
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

/**
 * Intención que T-15 (ap-reconciliation-service) emite hacia T-08.
 * Mismo shape que `WorkflowIntent` de `src/harness/workflow.ts` en la rama
 * `feat/s5-external-workflow-ports` de T-15 (snake_case), más el `intent_id`
 * que devuelve su `WorkflowReceipt`, que T-08 usa para descartar duplicados.
 *
 *   RECONCILED         match con evidencia externa → el pago se cierra
 *   RETRY              falta evidencia o dependencia caída → T-15 volverá a intentar
 *   REQUIRES_REVIEW    diferencia material → revisión humana
 *   REOPEN_COMPENSATE  reorg / finality → reabrir y volver a esperar liquidación
 */
export type ReconciliationIntentKind = 'RECONCILED' | 'RETRY' | 'REQUIRES_REVIEW' | 'REOPEN_COMPENSATE';

export interface ReconciliationIntent {
  intent_id: string;
  kind: ReconciliationIntentKind;
  payment_id: string | null;
  /** Código AGP-REC que motiva la intención; null cuando es un match. */
  code: string | null;
  reason: string;
  evidence: string;
}

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
  | 'REOPENED'
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
  /** Código que explica el resultado: AGP-REC de T-15 o AGP-ORC propio. */
  reconciliationCode?: string;
  /** Intenciones de T-15 ya aplicadas (por intent_id), para auditoría e idempotencia. */
  appliedIntents: string[];
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

/**
 * Códigos de error del orquestador. El detalle de cada uno (nombre, familia,
 * severidad, resolución) está en `src/errors/taxonomy.ts` (AGP-ORC v1.0.0).
 */
export const ERROR_CODES = {
  POLICY_DENIED: 'AGP-ORC-1001',
  APPROVAL_REJECTED: 'AGP-ORC-1002',
  APPROVAL_TIMEOUT: 'AGP-ORC-1003',
  INSUFFICIENT_AUTHORITY: 'AGP-ORC-2001',
  SESSION_EXPIRED: 'AGP-ORC-2002',
  SESSION_REVOKED: 'AGP-ORC-2003',
  RAIL_REJECTED: 'AGP-ORC-3001',
  SETTLEMENT_FAILED: 'AGP-ORC-3002',
  SETTLEMENT_TIMEOUT: 'AGP-ORC-3003',
  RECONCILIATION_REVIEW_REQUIRED: 'AGP-ORC-4001',
  RECONCILIATION_TIMEOUT: 'AGP-ORC-4002',
  REORG_UNRESOLVED: 'AGP-ORC-4003',
  DEPENDENCY_UNAVAILABLE: 'AGP-ORC-9001',
  INTERNAL_ERROR: 'AGP-ORC-9002',
  INVALID_REQUEST: 'AGP-ORC-9003',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Códigos de error de negocio que devuelven otros módulos y que NO deben reintentarse. */
export const NON_RETRYABLE_ERRORS = [
  ERROR_CODES.POLICY_DENIED,
  ERROR_CODES.INSUFFICIENT_AUTHORITY,
  ERROR_CODES.SESSION_EXPIRED,
  ERROR_CODES.SESSION_REVOKED,
  ERROR_CODES.RAIL_REJECTED,
  ERROR_CODES.INVALID_REQUEST,
] as const;
export type NonRetryableErrorType = (typeof NON_RETRYABLE_ERRORS)[number];

export const TASK_QUEUE = 'payments-orchestration';
