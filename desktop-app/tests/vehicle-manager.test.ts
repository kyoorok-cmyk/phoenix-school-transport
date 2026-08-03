/**
 * Vehicle Manager Unit Tests
 *
 * Tests for the VehicleManager module compliance logic and service layer.
 *
 * Requirements: 3.1, 3.2, 3.3
 */

import { describe, it, expect } from 'vitest';
import { computeComplianceStatus } from '../renderer/services/vehicle-compliance';

describe('VehicleManager - computeComplianceStatus', () => {
  it('should return "expired" when expiry date is in the past', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const result = computeComplianceStatus(yesterday.toISOString().split('T')[0]);

    expect(result.compliance_status).toBe('expired');
    expect(result.days_until_expiry).toBeLessThan(0);
  });

  it('should return "expired" when expiry was 60 days ago', () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 60);
    const result = computeComplianceStatus(pastDate.toISOString().split('T')[0]);

    expect(result.compliance_status).toBe('expired');
    expect(result.days_until_expiry).toBe(-60);
  });

  it('should return "expiring_soon" when expiry is today (0 days)', () => {
    const today = new Date();
    const result = computeComplianceStatus(today.toISOString().split('T')[0]);

    expect(result.compliance_status).toBe('expiring_soon');
    expect(result.days_until_expiry).toBe(0);
  });

  it('should return "expiring_soon" when expiry is in 15 days', () => {
    const future = new Date();
    future.setDate(future.getDate() + 15);
    const result = computeComplianceStatus(future.toISOString().split('T')[0]);

    expect(result.compliance_status).toBe('expiring_soon');
    expect(result.days_until_expiry).toBe(15);
  });

  it('should return "expiring_soon" when expiry is exactly 30 days away', () => {
    const future = new Date();
    future.setDate(future.getDate() + 30);
    const result = computeComplianceStatus(future.toISOString().split('T')[0]);

    expect(result.compliance_status).toBe('expiring_soon');
    expect(result.days_until_expiry).toBe(30);
  });

  it('should return "valid" when expiry is 31 days away', () => {
    const future = new Date();
    future.setDate(future.getDate() + 31);
    const result = computeComplianceStatus(future.toISOString().split('T')[0]);

    expect(result.compliance_status).toBe('valid');
    expect(result.days_until_expiry).toBe(31);
  });

  it('should return "valid" when expiry is 365 days away', () => {
    const future = new Date();
    future.setDate(future.getDate() + 365);
    const result = computeComplianceStatus(future.toISOString().split('T')[0]);

    expect(result.compliance_status).toBe('valid');
    expect(result.days_until_expiry).toBe(365);
  });
});
