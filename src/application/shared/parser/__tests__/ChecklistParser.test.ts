import { describe, it, expect } from 'vitest';
import { ChecklistParser } from '../ChecklistParser.js';

describe('ChecklistParser', () => {
  it('CSV文字列からChecklistを生成できる', () => {
    const csv = 'コードの可読性\nテストの網羅性\nセキュリティの考慮';
    const checklist = ChecklistParser.parse(csv);
    expect(checklist.size).toBe(3);
    expect(checklist.items[0].content).toBe('コードの可読性');
    expect(checklist.items[1].content).toBe('テストの網羅性');
    expect(checklist.items[2].content).toBe('セキュリティの考慮');
  });

  it('空行は無視される', () => {
    const csv = 'コードの可読性\n\n\nテストの網羅性\n\n';
    const checklist = ChecklistParser.parse(csv);
    expect(checklist.size).toBe(2);
    expect(checklist.items[0].content).toBe('コードの可読性');
    expect(checklist.items[1].content).toBe('テストの網羅性');
  });

  it('空のCSVではエラーになる', () => {
    expect(() => ChecklistParser.parse('')).toThrow();
    expect(() => ChecklistParser.parse('\n\n')).toThrow();
  });
});
