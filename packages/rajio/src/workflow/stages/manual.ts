import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { runCodexAgent } from '../agent.js';
import { manualSegmentsPath } from '../stages.js';
import { fromSessionRelative, pathExists, sha256File, toSessionRelative } from '../../utils/fs.js';
import { printCheckIssues, type CheckIssue } from '../../session/check.js';
import {
  blockingValidationErrors,
  cloneForTranslation,
  formatValidationIssueForProfile,
  formatValidationErrorSummary,
  normalizeTranscriptWorkGaps,
  readSegmentsFile,
  validateSegments,
  writeSegmentsFile
} from '../../segments/index.js';
import type { ManualStageName, RuntimeConfig } from '../../types.js';
import type { Session } from '../../session/index.js';
import { taggedLogger } from '../../utils/logger.js';

export async function setupManualStage(input: {
  session: Session;
  stage: ManualStageName;
}): Promise<void> {
  const { session, stage } = input;
  const sourceStage =
    stage === 'transcript_work'
      ? session.stage('transcript_raw')
      : session.stage('transcript_work');
  if (typeof sourceStage.segments !== 'string') {
    throw new Error(`${stage} source segments are missing.`);
  }
  if (stage === 'translation_work' && sourceStage.status !== 'committed') {
    throw new Error('transcript_work must be committed before translation_work.');
  }
  const sourcePath = fromSessionRelative(session.dir, sourceStage.segments);
  const workPath = session.resolve(manualSegmentsPath(stage));

  if ((await pathExists(workPath)) && session.stage(stage).status !== 'pending') {
    return;
  }

  await mkdir(path.dirname(workPath), { recursive: true });
  if (stage === 'transcript_work') {
    const source = await readSegmentsFile(sourcePath);
    await writeSegmentsFile(workPath, normalizeTranscriptWorkGaps(source), {
      requireZh: false,
      validate: false
    });
  } else {
    const source = await readSegmentsFile(sourcePath);
    await writeSegmentsFile(workPath, cloneForTranslation(source, new Date().toISOString()), {
      requireZh: false,
      validate: false
    });
  }
  session.updateStage(stage, {
    status: 'waiting',
    source_segments: toSessionRelative(session.dir, sourcePath),
    segments: toSessionRelative(session.dir, workPath),
    started_at: new Date().toISOString()
  });
  session.currentStage = stage;
  await session.save();
}

export async function commitManualStage(input: {
  session: Session;
  stage: ManualStageName;
  verbose: boolean;
}): Promise<void> {
  const { session, stage, verbose } = input;
  const state = session.stage(stage);
  if (typeof state.segments !== 'string') {
    throw new Error(`${stage} does not have a work segments path.`);
  }
  const segmentsPath = fromSessionRelative(session.dir, state.segments);
  const requireZh = stage === 'translation_work';
  const profile = stage === 'translation_work' ? 'translation_work' : 'default';
  const segments = await readSegmentsFile(segmentsPath);
  const issues = validateSegments(segments, { requireZh });
  const errors = blockingValidationErrors(issues, { profile });
  const stageLogger = taggedLogger(stage);
  printCheckIssues(
    issues
      .map((issue) => formatValidationIssueForProfile(issue, { profile }))
      .filter((issue) => issue.level === 'warning')
      .map(
        (issue): CheckIssue => ({
          file: segmentsPath,
          level: 'warning',
          code: issue.code,
          message: issue.message,
          segmentId: issue.segmentId
        })
      ),
    { verbose, logger: stageLogger }
  );
  if (errors.length > 0) {
    const file = toSessionRelative(session.dir, segmentsPath);
    throw new Error(
      `${formatValidationErrorSummary(errors, `${stage} ${file}`)} Run rajio check <session> --stage ${stage} --level error --verbose for details.`
    );
  }

  session.updateStage(stage, {
    status: 'committed',
    segments_sha256: await sha256File(segmentsPath),
    committed_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    force_committed: undefined
  });
}

export async function runAgentAndCommit(input: {
  session: Session;
  runtime: RuntimeConfig;
  stage: ManualStageName;
  verbose: boolean;
}): Promise<void> {
  const { session, runtime, stage, verbose } = input;
  if (session.stage(stage).status === 'pending') {
    await setupManualStage({ session, stage });
  }
  const state = session.stage(stage);
  if (typeof state.segments !== 'string') {
    throw new Error(`${stage} does not have a work segments path.`);
  }
  try {
    await runCodexAgent({
      sessionDir: session.dir,
      stage,
      segmentsPath: state.segments,
      description: session.description,
      runtime
    });
    await commitManualStage({ session, stage, verbose });
  } catch (error) {
    session.markFailed(stage, error);
    await session.save();
    throw error;
  }
}
