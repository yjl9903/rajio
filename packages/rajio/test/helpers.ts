import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, vi } from 'vitest';

import { Session } from '../src/index.js';
import { writeSegmentsFile } from '../src/segments/index.js';
import { sha256File } from '../src/utils/fs.js';
import type { CliOptions, SegmentsFile, SessionState } from '../src/types.js';

const originalEnv = { ...process.env };

export const baseOptions: CliOptions = {
  continue: 'until-manual',
  commit: false,
  agent: undefined,
  full: false,
  verbose: false
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-06T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...originalEnv };
});

export async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'rajio-test-'));
}

export async function fakeFfprobeBin(): Promise<string> {
  const dir = await tempDir();
  const filePath = path.join(dir, 'ffprobe');
  await writeFile(filePath, '#!/usr/bin/env node\nconsole.log("1");\n');
  await chmod(filePath, 0o755);
  return filePath;
}

export async function preparedSession(
  currentStage: SessionState['current_stage'],
  stages: Partial<SessionState['stages']>
): Promise<string> {
  const dir = await tempDir();
  await writeFile(path.join(dir, 'video.mp4'), 'media');
  await writeFile(
    path.join(dir, 'description.md'),
    ['---', 'media: ./video.mp4', 'title: Example', '---', '', 'context'].join('\n')
  );
  await mkdir(path.join(dir, 'transcript/raw'), { recursive: true });
  await writeSegmentsFile(path.join(dir, 'transcript/raw/segments.toml'), sampleTranscript());

  const session = baseSession(currentStage);
  for (const [stage, state] of Object.entries(stages)) {
    session.stages[stage as keyof SessionState['stages']] = {
      ...session.stages[stage as keyof SessionState['stages']],
      ...state
    };
  }
  const wrapper = await Session.loadOrCreate(dir);
  wrapper.state = session;
  await wrapper.save();
  return dir;
}

export async function preparedCompleteSession(): Promise<string> {
  const dir = await preparedSession('export', {});
  await mkdir(path.join(dir, 'transcript/work'), { recursive: true });
  await mkdir(path.join(dir, 'translation/work'), { recursive: true });
  await mkdir(path.join(dir, 'output'), { recursive: true });

  const transcriptPath = path.join(dir, 'transcript/work/segments.toml');
  const translationPath = path.join(dir, 'translation/work/segments.toml');
  await writeSegmentsFile(transcriptPath, sampleTranscript());
  await writeSegmentsFile(translationPath, sampleTranslation(), { requireZh: true });
  await writeFile(path.join(dir, 'output/Example.zh.srt'), '你好');

  const session = baseSession('done');
  session.input.media_sha256 = await sha256File(path.join(dir, 'video.mp4'));
  session.stages.transcript_raw = {
    status: 'done',
    segments: 'transcript/raw/segments.toml',
    segments_sha256: await sha256File(path.join(dir, 'transcript/raw/segments.toml'))
  };
  session.stages.transcript_work = {
    status: 'committed',
    segments: 'transcript/work/segments.toml',
    segments_sha256: await sha256File(transcriptPath)
  };
  session.stages.translation_work = {
    status: 'committed',
    segments: 'translation/work/segments.toml',
    segments_sha256: await sha256File(translationPath)
  };
  session.stages.export = {
    status: 'done',
    ja_srt: 'output/Example.ja.srt',
    zh_srt: 'output/Example.zh.srt',
    bilingual_ass: 'output/Example.ja-zh.ass'
  };

  const wrapper = await Session.loadOrCreate(dir);
  wrapper.state = session;
  await wrapper.save();
  return dir;
}

export function baseSession(currentStage: SessionState['current_stage']): SessionState {
  return {
    schema_version: 1,
    session_id: 'test',
    created_at: '2026-06-06T00:00:00.000Z',
    updated_at: '2026-06-06T00:00:00.000Z',
    current_stage: currentStage,
    input: { description: 'description.md' },
    stages: {
      audio: { status: 'done' },
      transcript_raw: { status: 'pending' },
      transcript_work: { status: 'pending' },
      translation_work: { status: 'pending' },
      export: { status: 'pending' }
    }
  };
}

export function sampleTranscript(): SegmentsFile {
  return {
    version: 1,
    source: { kind: 'transcript', generated_at: '2026-06-06T00:00:00.000Z' },
    segments: [
      { id: '1', start: 0, end: 1.2, speaker: 'A', ja: 'こんにちは' },
      { id: '2', start: 1.5, end: 2.7, speaker: 'B', ja: 'さようなら' }
    ]
  };
}

export function sampleTranslation(): SegmentsFile {
  return {
    ...sampleTranscript(),
    source: { kind: 'translation', generated_at: '2026-06-06T00:00:00.000Z' },
    segments: sampleTranscript().segments.map((segment) => ({
      ...segment,
      zh: segment.id === '1' ? '你好' : '再见'
    }))
  };
}
