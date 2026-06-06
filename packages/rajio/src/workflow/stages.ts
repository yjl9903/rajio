import type { ManualStageName, StageName } from '../types.js';

export function isManualStage(stage: StageName): stage is ManualStageName {
  return stage === 'transcript_work' || stage === 'translation_work';
}

export function nextStage(stage: StageName): StageName {
  const order: StageName[] = [
    'audio',
    'transcript_raw',
    'transcript_work',
    'translation_work',
    'export'
  ];
  return order[Math.min(order.indexOf(stage) + 1, order.length - 1)];
}

export function manualSegmentsPath(stage: ManualStageName): string {
  return stage === 'transcript_work'
    ? 'transcript/work/segments.toml'
    : 'translation/work/segments.toml';
}
