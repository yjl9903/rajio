import type { CurrentStageName, ManualStageName, StageName } from '../types.js';
import { STAGES } from '../types.js';

export function isManualStage(stage: CurrentStageName): stage is ManualStageName {
  return stage === 'transcript_work' || stage === 'translation_work';
}

export function nextStage(stage: StageName): CurrentStageName {
  return STAGES[STAGES.indexOf(stage) + 1] ?? 'done';
}

export function manualSegmentsPath(stage: ManualStageName): string {
  return stage === 'transcript_work'
    ? 'transcript/work/segments.toml'
    : 'translation/work/segments.toml';
}
