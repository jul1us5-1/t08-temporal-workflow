# error-taxonomy — T-08 / IMP-07 (AGP-ORC v1.0.0)

Fuente de verdad ejecutable: `src/errors/taxonomy.ts` (constante `AGP_ORC`, `TAXONOMY_VERSION = "1.0.0"`). Sigue el mismo formato que la taxonomía AGP-REC de T-15 (`ap-reconciliation-service`): código `AGP-ORC-NNNN`, nombre en snake_case, familia, severidad, estado HTTP y resolución. Los errores se serializan como RFC 9457 con `toProblemDetails()`:

```json
{
  "type": "https://agentpay.local/errors/AGP-ORC-3001",
  "title": "AGP-ORC-3001 rail_rejected",
  "status": 422,
  "detail": "El rail rechazó el pago.",
  "severity": "WARN",
  "resolution": "COMPENSATE (reverse + release)",
  "owner": "T-08",
  "taxonomy_version": "1.0.0"
}
```

En el workflow, todo `failureReason` empieza con su código (`"AGP-ORC-3003: sin liquidación tras 30m"`). Si la causa viene de T-15 se conserva su código AGP-REC en `reconciliationCode`.

## Familias

| Código | Nombre | Sev. | HTTP | ¿Se reintenta? | Resolución |
|---|---|---|---|---|---|
| **1xxx** · policy y aprobación (T-06) | | | | | |
| AGP-ORC-1001 | `policy_denied` | WARN | 403 | No | Ninguna: decisión de T-06 |
| AGP-ORC-1002 | `approval_rejected` | WARN | 403 | No | Ninguna: decisión humana |
| AGP-ORC-1003 | `approval_timeout` | WARN | 408 | No | Reiniciar el pago si sigue vigente |
| **2xxx** · autoridad de gasto (T-07) | | | | | |
| AGP-ORC-2001 | `insufficient_authority` | WARN | 409 | No | Recargar o ampliar la sesión |
| AGP-ORC-2002 | `session_expired` | WARN | 409 | No | Crear una nueva sesión |
| AGP-ORC-2003 | `session_revoked` | WARN | 409 | No | Ninguna |
| **3xxx** · ejecución y liquidación (T-09..T-13, T-16) | | | | | |
| AGP-ORC-3001 | `rail_rejected` | WARN | 422 | No | Compensar (reverse + release) |
| AGP-ORC-3002 | `settlement_failed` | CRIT | 409 | No | Compensar (reverse + release) |
| AGP-ORC-3003 | `settlement_timeout` | CRIT | 504 | No | Compensar (reverse + release) |
| **4xxx** · conciliación (intenciones de T-15) | | | | | |
| AGP-ORC-4001 | `reconciliation_review_required` | CRIT | 409 | No | Revisión humana (T-15 `REQUIRES_REVIEW`) |
| AGP-ORC-4002 | `reconciliation_timeout` | WARN | 504 | No | Revisión humana |
| AGP-ORC-4003 | `reorg_unresolved` | CRIT | 409 | No | Revisión humana; nunca RECONCILED |
| **9xxx** · ops/infra | | | | | |
| AGP-ORC-9001 | `dependency_unavailable` | CRIT | 503 | Sí | Reintento con backoff (Temporal) |
| AGP-ORC-9002 | `internal_error` | CRIT | 500 | Sí | Revisión on-call |
| AGP-ORC-9003 | `invalid_request` | WARN | 400 | No | Corregir request |

Total: **15 códigos**.

## Errores de otros módulos

Los servicios del club responden RFC 9457. `errorCode()` (`src/activities/http-clients.ts`) extrae el código AGP del `title` o del `type`. Si es uno de `NON_RETRYABLE_ERRORS`, la activity falla sin reintentar; cualquier otro 5xx, timeout o error de red se reintenta. Cuando T-06, T-07 y T-13 publiquen sus taxonomías, hay que mapear sus códigos de negocio a la familia AGP-ORC correspondiente.
