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
    const existingDataListener = (): void => undefined;
    input.on('data', existingDataListener);
    const selection = selectWithKeys(input, output, 'Environment', ['sandbox', 'production']);

    input.emit('data', '\u001b[A');
    input.emit('data', '\r');

    await expect(selection).resolves.toBe(1);
    expect(output.value).toContain('\u001b[36m❯ sandbox\u001b[0m');
    expect(output.value).toContain('\u001b[36m❯ production\u001b[0m');
    expect(output.value).toContain('Selected: production');
    expect(input.rawModes).toEqual([true, false]);
    expect(input.listenerCount('keypress')).toBe(0);
    expect(input.listenerCount('data')).toBe(1);
    input.off('data', existingDataListener);
  });

  it('wraps down from the last choice to the first', async () => {
    const input = new InputHarness();
    const output = new OutputHarness();
    const selection = selectWithKeys(input, output, 'Version', ['version one', 'version two'], 1);

    input.emit('data', '\u001b[B');
    input.emit('data', '\r');

    await expect(selection).resolves.toBe(0);
    expect(input.listenerCount('data')).toBe(0);
  });

  it('cancels on Escape and restores terminal state', async () => {
    const input = new InputHarness();
    const output = new OutputHarness();
    const selection = selectWithKeys(input, output, 'Environment', ['sandbox', 'production']);

    input.emit('data', '\u001b');

    await expect(selection).rejects.toThrow('Selection cancelled.');
    expect(input.rawModes).toEqual([true, false]);
    expect(input.resumeCalls).toBe(1);
    expect(input.pauseCalls).toBe(1);
    expect(input.listenerCount('keypress')).toBe(0);
    expect(input.listenerCount('data')).toBe(0);
  });

  it('cancels on Ctrl+C and restores terminal state', async () => {
    const input = new InputHarness();
    const output = new OutputHarness();
    const selection = selectWithKeys(input, output, 'Environment', ['sandbox', 'production']);

    input.emit('data', '\u0003');

    await expect(selection).rejects.toThrow('Selection cancelled.');
    expect(input.rawModes).toEqual([true, false]);
    expect(input.resumeCalls).toBe(1);
    expect(input.pauseCalls).toBe(1);
    expect(input.listenerCount('keypress')).toBe(0);
    expect(input.listenerCount('data')).toBe(0);
  });
});
