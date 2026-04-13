import { describe, it, expect } from 'vitest';
import { serverCliModule } from '../index.js';

describe('serverCliModule', () => {
  it('name が server であること', () => {
    expect(serverCliModule.name).toBe('server');
  });

  it('description が空でないこと', () => {
    expect(serverCliModule.description.length).toBeGreaterThan(0);
  });

  it('run が関数であること', () => {
    expect(typeof serverCliModule.run).toBe('function');
  });
});
