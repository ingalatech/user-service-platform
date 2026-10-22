import { emitKeypressEvents } from 'node:readline';

interface PromptKey {
  readonly ctrl?: boolean;
  readonly name?: string;
}

type KeypressListener = (character: string, key?: PromptKey) => void;

export interface PromptInput {
  readonly isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'keypress', listener: KeypressListener): unknown;
  off(event: 'keypress', listener: KeypressListener): unknown;
}

export interface PromptOutput {
  write(value: string): unknown;
}

export async function selectWithKeys(
  input: PromptInput,
  output: PromptOutput,
  question: string,
  choices: readonly string[],
  defaultIndex = 0,
): Promise<number> {
  if (choices.length === 0 || defaultIndex < 0 || defaultIndex >= choices.length) {
    throw new Error('Selection requires a valid default choice.');
  }

  let selectedIndex = defaultIndex;
  const wasRaw = input.isRaw === true;
  const renderChoices = (redraw = false): void => {
    if (redraw) output.write(`\u001b[${String(choices.length)}A`);
    choices.forEach((choice, index) => {
      const selected = index === selectedIndex;
      output.write(
        `\u001b[2K\r${selected ? '\u001b[36m❯' : ' '} ${choice}${selected ? '\u001b[0m' : ''}\n`,
      );
    });
  };

  output.write(`\n? ${question}\n`);
  // Node's runtime only needs the event methods above, despite its broader stream type declaration.
  emitKeypressEvents(input as unknown as NodeJS.ReadableStream);
  input.setRawMode(true);
  input.resume();
  renderChoices();

  return new Promise<number>((resolve, reject) => {
    const cleanup = (): void => {
      input.off('keypress', onKeypress);
      input.setRawMode(wasRaw);
      input.pause();
    };
    const onKeypress: KeypressListener = (_character, key = {}) => {
      if ((key.ctrl === true && key.name === 'c') || key.name === 'escape') {
        cleanup();
        reject(new Error('Selection cancelled.'));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const selected = choices[selectedIndex] ?? '';
        cleanup();
        output.write(`\u001b[32m✔\u001b[0m Selected: ${selected}\n`);
        resolve(selectedIndex);
        return;
      }

      const previousIndex = selectedIndex;
      if (key.name === 'up') {
        selectedIndex = (selectedIndex - 1 + choices.length) % choices.length;
      } else if (key.name === 'down') {
        selectedIndex = (selectedIndex + 1) % choices.length;
      }
      if (selectedIndex !== previousIndex) renderChoices(true);
    };

    input.on('keypress', onKeypress);
  });
}
