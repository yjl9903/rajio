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
import { MANUAL_STAGES, STAGES } from '../types.js';
import { isManualStage, manualSegmentsPath, nextStage } from './stages.js';
import { runAudioStage } from './stages/audio.js';
import { runExportStage } from './stages/export.js';
import { commitManualStage, setupManualStage } from './stages/manual.js';
import { runTranscriptRawStage } from './stages/transcription.js';
import { resolveWorkflowTranscriptionConfig } from '../transcription/config.js';

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
  const transcription = resolveWorkflowTranscriptionConfig({
    state: session.state,
    description: session.description,
    cli: options.transcription,
    reset: options.reset,
    target: session.dir
  });
  session.state.transcription = transcription;
  const mediaInvalidated = await session.refreshMediaState();
  if (mediaInvalidated && options.reset && options.reset !== 'audio') {
    await session.save();
    throw new Error('Media changed; run from audio before resetting to a later stage.');
  }
  if (options.reset) {
    resetSessionToStage(session, options.reset);
  }
  await session.refreshDirtyState();
  retargetDirtyManualStage(session);
  await session.save();

  const currentStage = session.currentStage;
  if (isManualStage(currentStage)) {
    if (options.commit) {
      await commitManualStage({
        session,
        stage: currentStage
      });
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
  const logger = taggedLogger('workflow');
  const limit = options.continue === 'step' && !options.full ? 1 : Number.POSITIVE_INFINITY;
  let steps = 0;

  while (steps < limit) {
    await session.refreshDirtyState();
    if (retargetDirtyManualStage(session)) {
      await session.save();
    }
    const stage = session.currentStage;

    if (stage === 'done') {
      if (session.stage('export').status === 'done') {
        logger.success('session is already complete.');
        logExportOutputs(session, deps.outputLogger);
        return;
      }
      throw new Error('current_stage is done but export is not done.');
    }

    if (isManualStage(stage)) {
      await handleManualStage(session, stage, options);
      logWorkflowStop(session, logger);
      return;
    }

    await runAutomaticStage(session, runtime, stage, options, deps);
    steps += 1;

    if (stage === 'export') {
      logWorkflowStop(session, logger);
      return;
    }

    if (
      !options.full &&
      options.continue === 'until-manual' &&
      isManualStage(session.currentStage)
    ) {
      await setupManualStage({ session, stage: session.currentStage });
      taggedLogger(session.currentStage).info(`waiting for manual stage ${session.currentStage}.`);
      logWorkflowStop(session, logger);
      return;
    }
  }

  logWorkflowStop(session, logger);
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
  stage: ManualStageName,
  options: CliOptions
): Promise<void> {
  if (session.stage(stage).status === 'pending') {
    await setupManualStage({ session, stage });
  }

  if (options.full) {
    const stageLogger = taggedLogger(stage);
    stageLogger.info(`waiting for manual stage ${stage}.`);
    return;
  }

  const stageLogger = taggedLogger(stage);
  stageLogger.info(`waiting for manual stage ${stage}.`);
}

async function runAutomaticStage(
  session: Session,
  runtime: RuntimeConfig,
  stage: StageName,
  options: CliOptions,
  deps: WorkflowDeps
): Promise<void> {
  if (session.stage(stage).status === 'done') {
    await advancePastStage(session, stage);
    return;
  }

  try {
    const resetTranscriptCheckpoints =
      stage === 'transcript_raw' && session.stage(stage).status === 'pending';
    session.markRunning(stage);
    await session.save();

    if (stage === 'audio') {
      await runAudioStage({
        session,
        runtime,
        transcription: session.state.transcription!,
        chunking: options.chunking
      });
    } else if (stage === 'transcript_raw') {
      await runTranscriptRawStage({
        session,
        runtime,
        deps,
        transcription: session.state.transcription!,
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

function logWorkflowStop(session: Session, logger: ExportOutputLogger): void {
  if (session.currentStage === 'done') {
    logger.success('session complete.');
    return;
  }

  logger.info(`current stage: ${session.currentStage}.`);
  logger.info(`next step: ${nextStepMessage(session)}.`);
}

function nextStepMessage(session: Session): string {
  const target = formatCommandTarget(session.dir);
  if (isManualStage(session.currentStage)) {
    return `edit ${manualSegmentsPath(session.currentStage)}, then run rajio ${target} --commit`;
  }
  return `run rajio ${target} --continue=step`;
}

function formatCommandTarget(target: string): string {
  return `'${target.replaceAll("'", "'\\''")}'`;
}

async function advancePastStage(session: Session, stage: StageName): Promise<void> {
  session.currentStage = nextStage(stage);
  await session.save();
}

export function resetSessionToStage(session: Session, stage: StageName): void {
  const start = STAGES.indexOf(stage);
  for (const downstreamStage of STAGES.slice(start)) {
    session.state.stages[downstreamStage] = { status: 'pending' };
  }
  session.currentStage = stage;
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
  logger: ExportOutputLogger = taggedLogger('workflow')
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
