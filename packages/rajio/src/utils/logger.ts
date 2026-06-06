import { createConsola, type ConsolaInstance } from 'consola';

export const logger = createConsola();

let consoleWrapped = false;

export function wrapConsoleLogger(): void {
  if (consoleWrapped) {
    return;
  }
  logger.wrapConsole();
  consoleWrapped = true;
}

export function taggedLogger(tag: string): ConsolaInstance {
  return logger.withTag(tag);
}
