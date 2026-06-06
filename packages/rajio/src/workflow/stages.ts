import type { ManualStageName, StageName } from '../types.js';
import { STAGES } from '../types.js';

export function isManualStage(stage: StageName): stage is ManualStageName {
  return stage === 'transcript_work' || stage === 'translation_work';
}

export function nextStage(stage: StageName): StageName {
  return STAGES[Math.min(STAGES.indexOf(stage) + 1, STAGES.length - 1)]!;
}

export function manualSegmentsPath(stage: ManualStageName): string {
  return stage === 'transcript_work'
    ? 'transcript/work/segments.toml'
    : 'translation/work/segments.toml';
}
