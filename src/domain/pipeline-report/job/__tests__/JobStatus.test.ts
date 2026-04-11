import { describe, it, expect } from 'vitest';
import { isSuccessfulJobStatus, isTerminatedJobStatus, type JobStatus } from '../JobStatus.js';

describe('JobStatus', () => {
  describe('isTerminatedJobStatus', () => {
    it.each(['success', 'failed', 'canceled', 'skipped'] as const)(
      '%s はterminatedと判定される',
      (status) => {
        expect(isTerminatedJobStatus(status)).toBe(true);
      },
    );

    it.each([
      'created',
      'pending',
      'running',
      'waiting_for_resource',
      'manual',
      'preparing',
      'scheduled',
    ] as const)('%s はterminatedと判定されない', (status) => {
      expect(isTerminatedJobStatus(status)).toBe(false);
    });
  });

  describe('isSuccessfulJobStatus', () => {
    it('successのみsuccessfulと判定される', () => {
      expect(isSuccessfulJobStatus('success')).toBe(true);
    });

    it.each([
      'created',
      'pending',
      'running',
      'failed',
      'canceled',
      'skipped',
      'waiting_for_resource',
      'manual',
      'preparing',
      'scheduled',
    ] as const satisfies readonly JobStatus[])('%s はsuccessfulと判定されない', (status) => {
      expect(isSuccessfulJobStatus(status)).toBe(false);
    });
  });
});
