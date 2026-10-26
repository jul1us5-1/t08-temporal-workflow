# Contrato T-15 → T-08: intenciones de conciliación

Respuesta de T-08 a la pregunta **P-S5-6** del ADR-REC-002 de `ap-reconciliation-service` (Linder López, T-15): *"Contrato de intenciones de T-08; semántica de `RECONCILED`; idempotencia de la intención; compensación"*.

Estado: **propuesta de T-08** para congelar con T-15. Está implementada y probada en este repo.

## Cómo llega una intención

T-15 no expone una API que T-08 consulte. Se activa con el outbox del Ledger (T-14) y **emite** intenciones por su `WorkflowPort` (`src/harness/workflow.ts`, rama `feat/s5-external-workflow-ports`). El adapter real de ese puerto debe llamar a:

```ts
import { deliverReconciliationIntent } from 't08-temporal-workflow/src/client/deliver-reconciliation-intent';

await deliverReconciliationIntent(temporalClient, { intent_id, kind, payment_id, code, reason, evidence });
```

Esto envía la señal `reconciliationIntent` al workflow cuyo id es `payment_id` (en T-08, `workflowId = paymentId`).

## Shape

El mismo `WorkflowIntent` de T-15, en snake_case, más el `intent_id` que ya devuelve su `WorkflowReceipt`:

```ts
interface ReconciliationIntent {
  intent_id: string;            // obligatorio: clave de idempotencia
  kind: 'RECONCILED' | 'RETRY' | 'REQUIRES_REVIEW' | 'REOPEN_COMPENSATE';
  payment_id: string | null;    // null = intención de toda la run
  code: string | null;          // código AGP-REC; null cuando es un match
  reason: string;
  evidence: string;
}
```

## Semántica en T-08

| `kind` | Qué hace T-08 | Resultado |
|---|---|---|
| `RECONCILED` | Registra `PAYMENT_RECONCILED` en el Ledger y cierra el pago | `COMPLETED`, `reconciliation: MATCHED` |
| `RETRY` | Nada: sigue esperando la siguiente intención (T-15 reprograma) | Sigue en `RECONCILING` |
| `REQUIRES_REVIEW` | Registra `RECONCILIATION_EXCEPTION` con el código AGP-REC | `COMPLETED`, `NEEDS_REVIEW`, `reconciliationCode = code` |
| `REOPEN_COMPENSATE` | Pasa a `REOPENED`, registra `PAYMENT_REOPENED` y vuelve a esperar la liquidación (señal del Chain Indexer o sondeo al rail). Si vuelve a liquidarse, espera una nueva intención; si no, `NEEDS_REVIEW` con `AGP-ORC-4003` | Nunca `RECONCILED` sin una intención nueva |

- **`RECONCILED` es la única forma de cerrar como MATCHED.** T-08 no compara montos ni estados: esa regla es de T-15.
- **Un pago liquidado no se revierte automáticamente.** Ni `REQUIRES_REVIEW` ni un reorg disparan reverse/release: quedan para revisión humana. La compensación (reverse + release) solo ocurre antes de liquidar.
- **Timeout.** Si no llega una intención final en `reconciliationTimeout` (por defecto 1 h), el pago termina con `NEEDS_REVIEW` y `AGP-ORC-4002`.

## Idempotencia y orden

- Entrega at-least-once: T-08 descarta un `intent_id` ya visto, así que T-15 puede reenviar sin miedo.
- Una intención cuyo `payment_id` no coincide con el workflow se ignora.
- Una intención que llega antes de que el pago esté en `RECONCILING` (por ejemplo, mientras espera la liquidación) se encola y se aplica después.
- Intenciones con `payment_id: null` (run `FAILED` → `RETRY` global) no se entregan: el adapter responde `{ delivered: false, reason: 'run_level_intent' }`.
- Si el pago no existe o ya terminó, responde `{ delivered: false, reason: 'payment_not_found' }`.

## Preguntas abiertas para T-15

1. ¿`intent_id` puede ser estable entre reintentos de la misma run (p.ej. `run_id:payment_id:kind`) en lugar de un contador? T-08 lo necesita para deduplicar.
2. ¿El `WorkflowPort` real será asíncrono? `deliverReconciliationIntent` devuelve una promesa.
3. Tras `REOPEN_COMPENSATE`, ¿T-15 vuelve a conciliar el pago por su cuenta o espera un evento nuevo del outbox (`PAYMENT_REOPENED` que registra T-08)?
