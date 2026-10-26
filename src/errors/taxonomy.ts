/**
 * Taxonomía AGP-ORC (T-08 · IMP-07), con el mismo formato que AGP-REC de T-15:
 * `AGP-ORC-NNNN` + nombre en snake_case, familia, severidad, estado HTTP y
 * resolución. Es la fuente única de verdad de los códigos del orquestador.
 *
 * Familias:
 *   1xxx  policy y aprobación humana (T-06)
 *   2xxx  autoridad de gasto / sesión (T-07)
 *   3xxx  ejecución y liquidación en el rail (T-09..T-13, T-16)
 *   4xxx  conciliación (intenciones de T-15)
 *   9xxx  ops/infra del orquestador
 */
export const TAXONOMY_VERSION = '1.0.0';

export type Severity = 'INFO' | 'WARN' | 'CRIT';

export interface OrcEntry {
  code: string;
  name: string;
  family: string;
  severity: Severity;
  httpStatus: number;
  /** El workflow no reintenta estos errores: son decisiones de negocio. */
  retryable: boolean;
  resolution: string;
  detail: string;
}

export const AGP_ORC: OrcEntry[] = [
  { code: 'AGP-ORC-1001', name: 'policy_denied', family: '1xxx', severity: 'WARN', httpStatus: 403, retryable: false, resolution: 'Ninguna: decisión de T-06', detail: 'Policy rechazó el pago.' },
  { code: 'AGP-ORC-1002', name: 'approval_rejected', family: '1xxx', severity: 'WARN', httpStatus: 403, retryable: false, resolution: 'Ninguna: decisión humana', detail: 'Un aprobador rechazó el pago en revisión.' },
  { code: 'AGP-ORC-1003', name: 'approval_timeout', family: '1xxx', severity: 'WARN', httpStatus: 408, retryable: false, resolution: 'Reiniciar el pago si sigue vigente', detail: 'No llegó la aprobación humana dentro del plazo.' },
  { code: 'AGP-ORC-2001', name: 'insufficient_authority', family: '2xxx', severity: 'WARN', httpStatus: 409, retryable: false, resolution: 'Recargar o ampliar la sesión en T-07', detail: 'La sesión de pago no tiene autoridad suficiente.' },
  { code: 'AGP-ORC-2002', name: 'session_expired', family: '2xxx', severity: 'WARN', httpStatus: 409, retryable: false, resolution: 'Crear una nueva sesión en T-07', detail: 'La sesión de pago expiró.' },
  { code: 'AGP-ORC-2003', name: 'session_revoked', family: '2xxx', severity: 'WARN', httpStatus: 409, retryable: false, resolution: 'Ninguna: sesión revocada', detail: 'La sesión de pago fue revocada.' },
  { code: 'AGP-ORC-3001', name: 'rail_rejected', family: '3xxx', severity: 'WARN', httpStatus: 422, retryable: false, resolution: 'COMPENSATE (reverse + release)', detail: 'El rail rechazó el pago.' },
  { code: 'AGP-ORC-3002', name: 'settlement_failed', family: '3xxx', severity: 'CRIT', httpStatus: 409, retryable: false, resolution: 'COMPENSATE (reverse + release)', detail: 'La liquidación falló (on-chain o en el rail).' },
  { code: 'AGP-ORC-3003', name: 'settlement_timeout', family: '3xxx', severity: 'CRIT', httpStatus: 504, retryable: false, resolution: 'COMPENSATE (reverse + release)', detail: 'No hubo liquidación dentro del plazo.' },
  { code: 'AGP-ORC-4001', name: 'reconciliation_review_required', family: '4xxx', severity: 'CRIT', httpStatus: 409, retryable: false, resolution: 'HUMAN_REVIEW (T-15 REQUIRES_REVIEW)', detail: 'T-15 encontró una diferencia que requiere revisión.' },
  { code: 'AGP-ORC-4002', name: 'reconciliation_timeout', family: '4xxx', severity: 'WARN', httpStatus: 504, retryable: false, resolution: 'HUMAN_REVIEW', detail: 'T-15 no emitió una intención final dentro del plazo.' },
  { code: 'AGP-ORC-4003', name: 'reorg_unresolved', family: '4xxx', severity: 'CRIT', httpStatus: 409, retryable: false, resolution: 'HUMAN_REVIEW: nunca RECONCILED', detail: 'Tras un reorg (T-15 REOPEN_COMPENSATE) el pago no volvió a liquidarse.' },
  { code: 'AGP-ORC-9001', name: 'dependency_unavailable', family: '9xxx', severity: 'CRIT', httpStatus: 503, retryable: true, resolution: 'RETRY con backoff (Temporal)', detail: 'Un servicio del que depende el workflow no está disponible.' },
  { code: 'AGP-ORC-9002', name: 'internal_error', family: '9xxx', severity: 'CRIT', httpStatus: 500, retryable: true, resolution: 'HUMAN_REVIEW (on-call)', detail: 'Error interno no esperado.' },
  { code: 'AGP-ORC-9003', name: 'invalid_request', family: '9xxx', severity: 'WARN', httpStatus: 400, retryable: false, resolution: 'Corregir request', detail: 'Request o configuración inválidos.' },
];

export const byCode = (code: string): OrcEntry => {
  const entry = AGP_ORC.find((e) => e.code === code);
  if (!entry) throw new Error(`TAXONOMY_UNKNOWN_CODE: ${code}`);
  return entry;
};

/** Serialización RFC 9457, igual que `toProblemDetails` de T-15. */
export function toProblemDetails(e: OrcEntry, detail?: string) {
  return {
    type: `https://agentpay.local/errors/${e.code}`,
    title: `${e.code} ${e.name}`,
    status: e.httpStatus,
    detail: detail ?? e.detail,
    severity: e.severity,
    resolution: e.resolution,
    owner: 'T-08',
    taxonomy_version: TAXONOMY_VERSION,
  };
}
