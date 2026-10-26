/**
 * Adapter T-15 → T-08: entrega una intención de ap-reconciliation-service al
 * workflow del pago, como la señal `reconciliationIntent`.
 *
 * Es lo que el `WorkflowPort` real de T-15 debería llamar en lugar de su
 * `FakeWorkflowAdapter` (rama feat/s5-external-workflow-ports, ADR-REC-002 D8).
 * Responde a P-S5-6: ver docs/contrato-t15-intenciones.md.
 */
import { Client, WorkflowNotFoundError } from '@temporalio/client';
import { ReconciliationIntent } from '../shared/types';
import { reconciliationIntentSignal } from '../workflows';

export type DeliveryResult =
  | { delivered: true; intent_id: string }
  | { delivered: false; intent_id: string; reason: 'run_level_intent' | 'payment_not_found' };

export async function deliverReconciliationIntent(
  client: Client,
  intent: ReconciliationIntent,
): Promise<DeliveryResult> {
  // Una run FAILED emite un RETRY global (payment_id null): no hay pago que tocar.
  if (!intent.payment_id) return { delivered: false, intent_id: intent.intent_id, reason: 'run_level_intent' };

  try {
    // workflowId = paymentId. Repetir la entrega es seguro: el workflow
    // descarta un intent_id ya visto.
    await client.workflow.getHandle(intent.payment_id).signal(reconciliationIntentSignal, intent);
    return { delivered: true, intent_id: intent.intent_id };
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) {
      return { delivered: false, intent_id: intent.intent_id, reason: 'payment_not_found' };
    }
    throw err;
  }
}
