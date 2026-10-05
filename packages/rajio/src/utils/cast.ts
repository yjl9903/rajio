import { z } from 'zod';

export const numberInput = z.string().transform(Number).pipe(z.number());
export const countInput = numberInput.pipe(z.number().int());
export const manualStageInput = z.enum(['transcript', 'translation']);
export const issueLevelInput = z.enum(['fatal', 'error', 'warning']);
