import { readRuntimeConfig } from '../utils/env.js';
import { Session } from '../session/index.js';
import { taggedLogger } from '../utils/logger.js';
import type {
  CliOptions,
  ManualStageName,
  RuntimeConfig,
  StageName,
  StageRunnerDeps
} from '../types.js';
import { MANUAL_STAGES } from '../types.js';
import { isManualStage, manualSegmentsPath, nextStage } from './stages.js';
import { runAudioStage } from './stages/audio.js';
import { runExportStage } from './stages/export.js';
import { commitManualStage, runAgentAndCommit, setupManualStage } from './stages/manual.js';
import { runTranscriptRawStage } from './stages/transcription.js';

const workflowLogger = taggedLogger('workflow');
const EXPORT_OUTPUT_FIELDS = [
  ['ja srt', 'ja_srt'],
  ['zh srt', 'zh_srt'],
  ['bilingual ass', 'bilingual_ass']
] as const;

export interface ExportOutputLogger {
  success(message: string): void;
  info(message: string): void;
}

export interface WorkflowDeps extends StageRunnerDeps {
  outputLogger?: ExportOutputLogger;
}

export async function runRajio(
  session: Session,
  options: CliOptions,
  deps: WorkflowDeps = {}
): Promise<void> {
  const runtime = await readRuntimeConfig({ cwd: process.cwd(), sessionDir: session.dir });
  await session.refreshMediaState();
  await session.refreshDirtyState();
  retargetDirtyManualStage(session);
  await session.save();

  const currentStage = session.currentStage;
  if (isManualStage(currentStage)) {
    if (options.agent === 'codex') {
      await runAgentAndCommit({ session, runtime, stage: currentStage, verbose: options.verbose });
      await advancePastStage(session, currentStage);
    } else if (options.commit) {
      await commitManualStage({ session, stage: currentStage, verbose: options.verbose });
      await advancePastStage(session, currentStage);
    }
  }

  await continueAfterAction(session, runtime, options, deps);
}

async function continueAfterAction(
  session: Session,
  runtime: RuntimeConfig,
  options: CliOptions,
  deps: WorkflowDeps
): Promise<void> {
  const limit = options.continue === 'step' && !options.full ? 1 : Number.POSITIVE_INFINITY;
  let steps = 0;

  while (steps < limit) {
    await session.refreshDirtyState();
    if (retargetDirtyManualStage(session)) {
      await session.save();
    }
    const stage = session.currentStage;

    if (stage === 'export' && session.stage('export').status === 'done' && !options.force) {
      workflowLogger.success('session is already complete.');
      logExportOutputs(session, deps.outputLogger);
      return;
    }

    if (isManualStage(stage)) {
      await handleManualStage(session, runtime, stage, options);
      if (!options.full || (stage === 'translation_work' && options.agent === false)) {
        return;
      }
      steps += 1;
      continue;
    }

    await runAutomaticStage(session, runtime, stage, options.force, deps);
    steps += 1;

    if (stage === 'export') {
      return;
    }

    if (
      !options.full &&
      options.continue === 'until-manual' &&
      isManualStage(session.currentStage)
    ) {
      await setupManualStage({ session, stage: session.currentStage, force: options.force });
      taggedLogger(session.currentStage).info(`waiting for manual stage ${session.currentStage}.`);
      return;
    }
  }
}

function retargetDirtyManualStage(session: Session): boolean {
  const dirtyStage = MANUAL_STAGES.find((stage) => session.stage(stage).status === 'dirty');
  if (!dirtyStage || session.currentStage === dirtyStage) {
    return false;
  }
  session.currentStage = dirtyStage;
  return true;
}

async function handleManualStage(
  session: Session,
  runtime: RuntimeConfig,
  stage: ManualStageName,
  options: CliOptions
): Promise<void> {
  if (session.stage(stage).status === 'pending') {
    await setupManualStage({ session, stage, force: options.force });
  }

  if (options.full) {
    const stageLogger = taggedLogger(stage);
    if (stage === 'translation_work' && options.agent === false) {
      stageLogger.info('waiting for manual stage translation_work.');
      stageLogger.info('fill translation/work/segments.toml in this session, then run --commit.');
      return;
    }
    if (options.agent === false) {
      await commitManualStage({ session, stage, verbose: options.verbose });
    } else {
      await runAgentAndCommit({ session, runtime, stage, verbose: options.verbose });
    }
    await advancePastStage(session, stage);
    return;
  }

  const stageLogger = taggedLogger(stage);
  stageLogger.info(`waiting for manual stage ${stage}.`);
  stageLogger.info(`edit ${manualSegmentsPath(stage)} in this session, then run --commit.`);
}

async function runAutomaticStage(
  session: Session,
  runtime: RuntimeConfig,
  stage: StageName,
  force: boolean,
  deps: WorkflowDeps
): Promise<void> {
  if (session.stage(stage).status === 'done' && !force) {
    await advancePastStage(session, stage);
    return;
  }

  try {
    const resetTranscriptCheckpoints =
      stage === 'transcript_raw' && session.stage(stage).status === 'pending';
    session.markRunning(stage);
    await session.save();

    if (stage === 'audio') {
      await runAudioStage({ session, runtime });
    } else if (stage === 'transcript_raw') {
      await runTranscriptRawStage({
        session,
        runtime,
        deps,
        force,
        resetCheckpoints: resetTranscriptCheckpoints
      });
    } else if (stage === 'export') {
      await runExportStage(session);
      logExportOutputs(session, deps.outputLogger);
    } else {
      throw new Error(`Cannot automatically run manual stage ${stage}.`);
    }

    session.markDone(stage);
    await advancePastStage(session, stage);
  } catch (error) {
    session.markFailed(stage, error);
    await session.save();
    throw error;
  }
}

async function advancePastStage(session: Session, stage: StageName): Promise<void> {
  session.currentStage = nextStage(stage);
  await session.save();
}

export function exportOutputPaths(session: Session): { label: string; path: string }[] {
  const exportStage = session.stage('export');
  return EXPORT_OUTPUT_FIELDS.flatMap(([label, field]) => {
    const value = exportStage[field];
    return typeof value === 'string' ? [{ label, path: value }] : [];
  });
}

export function logExportOutputs(
  session: Session,
  logger: ExportOutputLogger = workflowLogger
): void {
  const outputs = exportOutputPaths(session);
  if (outputs.length === 0) {
    return;
  }
  logger.success('export outputs:');
  for (const output of outputs) {
    logger.info(`${output.label}: ${output.path}`);
  }
}
