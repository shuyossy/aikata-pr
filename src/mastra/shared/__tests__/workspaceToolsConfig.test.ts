import { describe, it, expect } from 'vitest';
import { WORKSPACE_TOOLS_CONFIG } from '../workspaceToolsConfig.js';

describe('WORKSPACE_TOOLS_CONFIG', () => {
  it('read_file のトークン上限が4000に設定されている', () => {
    expect(WORKSPACE_TOOLS_CONFIG.mastra_workspace_read_file?.maxOutputTokens).toBe(4000);
  });

  it('grep のトークン上限が3000に設定されている', () => {
    expect(WORKSPACE_TOOLS_CONFIG.mastra_workspace_grep?.maxOutputTokens).toBe(3000);
  });

  it('list_files のトークン上限が2000に設定されている', () => {
    expect(WORKSPACE_TOOLS_CONFIG.mastra_workspace_list_files?.maxOutputTokens).toBe(2000);
  });

  it('execute_command のトークン上限が4000に設定されている', () => {
    expect(WORKSPACE_TOOLS_CONFIG.mastra_workspace_execute_command?.maxOutputTokens).toBe(4000);
  });

  it('全てのトークン上限値が正の数である', () => {
    const configs = [
      WORKSPACE_TOOLS_CONFIG.mastra_workspace_read_file,
      WORKSPACE_TOOLS_CONFIG.mastra_workspace_grep,
      WORKSPACE_TOOLS_CONFIG.mastra_workspace_list_files,
      WORKSPACE_TOOLS_CONFIG.mastra_workspace_execute_command,
    ];
    for (const config of configs) {
      expect(config?.maxOutputTokens).toBeGreaterThan(0);
    }
  });
});
