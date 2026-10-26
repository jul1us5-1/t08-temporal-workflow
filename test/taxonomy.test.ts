import { errorCode } from '../src/activities/http-clients';
import { AGP_ORC, byCode, toProblemDetails } from '../src/errors/taxonomy';
import { ERROR_CODES, NON_RETRYABLE_ERRORS } from '../src/shared/types';

describe('taxonomía AGP-ORC', () => {
  test('todos los códigos siguen AGP-ORC-NNNN, son únicos y tienen nombre snake_case', () => {
    const codes = AGP_ORC.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const e of AGP_ORC) {
      expect(e.code).toMatch(/^AGP-ORC-\d{4}$/);
      expect(e.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(e.family).toBe(`${e.code.slice(8, 9)}xxx`);
    }
  });

  test('ERROR_CODES y NON_RETRYABLE_ERRORS apuntan a entradas del registro', () => {
    for (const code of Object.values(ERROR_CODES)) expect(() => byCode(code)).not.toThrow();
    for (const code of NON_RETRYABLE_ERRORS) expect(byCode(code).retryable).toBe(false);
  });

  test('toProblemDetails sigue RFC 9457 como T-15', () => {
    expect(toProblemDetails(byCode(ERROR_CODES.RAIL_REJECTED))).toMatchObject({
      type: 'https://agentpay.local/errors/AGP-ORC-3001',
      title: 'AGP-ORC-3001 rail_rejected',
      status: 422,
      owner: 'T-08',
    });
  });

  test('errorCode lee el código de respuestas RFC 9457 de otros módulos', () => {
    expect(errorCode({ title: 'AGP-REC-9005 route_not_found', type: 'x' })).toBe('AGP-REC-9005');
    expect(errorCode({ type: 'https://agentpay.local/errors/AGP-ORC-2001' })).toBe('AGP-ORC-2001');
    expect(errorCode({ error: 'AGP-ORC-1001' })).toBe('AGP-ORC-1001');
    expect(errorCode(undefined)).toBeUndefined();
  });
});
