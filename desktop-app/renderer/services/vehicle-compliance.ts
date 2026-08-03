/**
 * Vehicle Compliance Utilities
 *
 * Pure functions for computing vehicle compliance status.
 * Separated from the service layer to enable testing without Supabase dependency.
 *
 * Requirements: 3.3
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComplianceStatus = 'valid' | 'expiring_soon' | 'expired';

export interface ComplianceResult {
  compliance_status: ComplianceStatus;
  days_until_expiry: number;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Calculate compliance status and days until expiry for a vehicle.
 *
 * - expired: expiry date is before today
 * - expiring_soon: expiry date is within 30 days (inclusive)
 * - valid: expiry date is more than 30 days away
 *
 * @param expiryDateStr - ISO date string (YYYY-MM-DD) of the compliance certificate expiry
 * @param referenceDate - Optional reference date for testing (defaults to today)
 */
export function computeComplianceStatus(
  expiryDateStr: string,
  referenceDate?: Date
): ComplianceResult {
  const today = referenceDate ? new Date(referenceDate) : new Date();
  today.setHours(0, 0, 0, 0);

  const expiry = new Date(expiryDateStr);
  expiry.setHours(0, 0, 0, 0);

  const diffMs = expiry.getTime() - today.getTime();
  const days_until_expiry = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  let compliance_status: ComplianceStatus;
  if (days_until_expiry < 0) {
    compliance_status = 'expired';
  } else if (days_until_expiry <= 30) {
    compliance_status = 'expiring_soon';
  } else {
    compliance_status = 'valid';
  }

  return { compliance_status, days_until_expiry };
}
