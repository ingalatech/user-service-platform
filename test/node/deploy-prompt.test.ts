import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  selectWithKeys,
  type PromptInput,
  type PromptOutput,
} from '../../scripts/deploy/prompt.js';

class InputHarness extends EventEmitter implements PromptInput {
  isRaw = false;
  readonly rawModes: boolean[] = [];
  resumeCalls = 0;
  pauseCalls = 0;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModes.push(mode);
    return this;
  }

  resume(): this {
    this.resumeCalls += 1;
    return this;
  }

  pause(): this {
    this.pauseCalls += 1;
    return this;
  }
}

class OutputHarness implements PromptOutput {
  value = '';

  write(value: string): boolean {
    this.value += value;
    return true;
  }
}

describe('arrow-key selector', () => {
  it('highlights the default and selects with arrow-key wraparound', async () => {
    const input = new InputHarness();
    const output = new OutputHarness();
    const selection = selectWithKeys(input, output, 'Environment', ['sandbox', 'production']);

    input.emit('keypress', '', { name: 'up' });
    input.emit('keypress', '', { name: 'return' });

    await expect(selection).resolves.toBe(1);
    expect(output.value).toContain('\u001b[36m❯ sandbox\u001b[0m');
    expect(output.value).toContain('\u001b[36m❯ production\u001b[0m');
    expect(output.value).toContain('Selected: production');
    expect(input.rawModes).toEqual([true, false]);
    expect(input.listenerCount('keypress')).toBe(0);
  });

  it('wraps down from the last choice to the first', async () => {
    const input = new InputHarness();
    const output = new OutputHarness();
    const selection = selectWithKeys(input, output, 'Version', ['version one', 'version two'], 1);

    input.emit('keypress', '', { name: 'down' });
    input.emit('keypress', '', { name: 'enter' });

    await expect(selection).resolves.toBe(0);
  });

  it.each([
    ['Escape', { name: 'escape' }],
    ['Ctrl+C', { ctrl: true, name: 'c' }],
  ])('cancels on %s and restores terminal state', async (_label, key) => {
    const input = new InputHarness();
    const output = new OutputHarness();
    const selection = selectWithKeys(input, output, 'Environment', ['sandbox', 'production']);

    input.emit('keypress', '', key);

    await expect(selection).rejects.toThrow('Selection cancelled.');
    expect(input.rawModes).toEqual([true, false]);
    expect(input.resumeCalls).toBe(1);
    expect(input.pauseCalls).toBe(1);
    expect(input.listenerCount('keypress')).toBe(0);
  });
});
