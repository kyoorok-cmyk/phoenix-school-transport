export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validateUUID(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
}

export function validateRequired(
  fields: Record<string, unknown>,
  required: string[]
): { valid: boolean; missing: string[] } {
  const missing = required.filter(
    (f) => fields[f] === undefined || fields[f] === null || fields[f] === ''
  );
  return { valid: missing.length === 0, missing };
}

export function sanitizeInput(value: string): string {
  return value.replace(/[<>]/g, '').trim();
}

export function validateAmount(amount: unknown): boolean {
  if (typeof amount !== 'number') return false;
  return amount > 0 && amount <= 999999999.99;
}
