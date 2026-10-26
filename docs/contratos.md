# Contratos propuestos entre T-08 y los otros módulos

Esto es una **propuesta** para acordar con cada equipo. El código que la implementa está en `src/activities/http-clients.ts`; si un equipo publica otra API, solo hay que cambiar ese archivo.

## Convenciones comunes

- Todas las operaciones que cambian estado reciben la cabecera `idempotency-key`. Repetir una llamada con la misma clave **debe** devolver el mismo resultado sin repetir el efecto, porque Temporal ejecuta las activities *al menos una vez*.
- Errores de negocio: HTTP 4xx con cuerpo `{ "error": "<Tipo>", "message": "..." }`, donde `<Tipo>` es uno de `AGP-ORC-POLICY_DENIED`, `AGP-ORC-INSUFFICIENT_AUTHORITY`, `AGP-ORC-SESSION_EXPIRED`, `AGP-ORC-SESSION_REVOKED`, `AGP-ORC-RAIL_REJECTED`, `AGP-ORC-VALIDATION_ERROR`. El workflow **no** los reintenta.
- Cualquier otro error (5xx, timeout, red) se reintenta con backoff exponencial.
- Montos como string en unidades mínimas: `{ "amount": "1500000", "currency": "USDC" }`.

## T-06 · Policy, Compliance & Risk (`POLICY_URL`)

`POST /v1/decisions` con el `PaymentRequest` completo devuelve una de estas respuestas:

```json
{ "outcome": "ALLOW",  "decisionId": "dec_1" }
{ "outcome": "DENY",   "decisionId": "dec_1", "reason": "merchant_blocked" }
{ "outcome": "REVIEW", "decisionId": "dec_1", "reason": "amount_over_threshold" }
```

Con `REVIEW`, el workflow espera la señal `approval` (por defecto hasta 24 h).

## T-07 · Payment Session Manager (`PAYMENT_SESSION_URL`)

| Método y ruta | Cuerpo | Respuesta |
|---|---|---|
| `POST /v1/sessions/{sessionId}/reservations` | `{ amount }` | `{ reservationId, expiresAt? }` o 4xx `AGP-ORC-INSUFFICIENT_AUTHORITY` / `AGP-ORC-SESSION_EXPIRED` / `AGP-ORC-SESSION_REVOKED` |
| `POST /v1/reservations/{reservationId}/consume` | `{}` | 2xx |
| `POST /v1/reservations/{reservationId}/release` | `{ reason }` | 2xx (también si ya estaba liberada) |

## T-09 … T-13 · Protocolo y rail (`RAIL_URL`)

| Método y ruta | Cuerpo | Respuesta |
|---|---|---|
| `POST /v1/payments` | `PaymentRequest` + `reservationId` | `{ status: "SETTLED" \| "PENDING", externalRef, txHash? }` o 4xx `AGP-ORC-RAIL_REJECTED` |
| `GET /v1/payments/{externalRef}` | | `{ status: "PENDING" }`, `{ status: "SETTLED", txHash? }` o `{ status: "FAILED", reason }` |
| `POST /v1/payments/reverse` | `{ executionKey, externalRef?, reason }` | 2xx (idempotente, también si no había nada que anular) |

`executionKey` es la `idempotency-key` usada en `POST /v1/payments`. Permite anular un envío aunque la respuesta se haya perdido y el workflow no conozca el `externalRef`.

## T-14 · Ledger (`LEDGER_URL`)

`POST /v1/payments/{paymentId}/events` con `{ event, data }`.

Eventos que emite el workflow, en orden típico: `PAYMENT_INITIATED`, `FUNDS_RESERVED`, `PAYMENT_SUBMITTED`, `PAYMENT_SETTLED`, `PAYMENT_RECONCILED` | `RECONCILIATION_EXCEPTION`. En los caminos de fallo: `PAYMENT_REJECTED`, `PAYMENT_REVERSED`, `RESERVATION_RELEASED`, `PAYMENT_FAILED`.

El Ledger decide qué asientos contables genera cada evento: el workflow no hace contabilidad.

## T-15 · Reconciliation Engine (`RECONCILIATION_URL`)

`POST /v1/matches` con `{ paymentId, externalRef }` devuelve `{ status: "MATCHED" }`, `{ status: "PENDING" }` o `{ status: "MISMATCH", reason }`.

Con `PENDING`, el workflow vuelve a preguntar hasta `reconciliationTimeout` (por defecto 1 h). Si no hay match, el pago termina `COMPLETED` con `reconciliation: "NEEDS_REVIEW"`.

## T-16 · Chain Indexer → señal al workflow

Cuando el indexer vea la transacción, debe enviar la señal `settlement` al workflow cuyo id es el `paymentId`:

```ts
await client.workflow.getHandle(paymentId).signal('settlement', {
  externalRef, status: 'SETTLED', txHash,   // o status: 'FAILED', reason
});
```

Si la señal no llega, el workflow igual sondea `GET /v1/payments/{externalRef}` cada `settlementPollInterval` (por defecto 30 s) hasta `settlementTimeout` (por defecto 30 min).
