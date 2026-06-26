import { mkdir, stat } from 'node:fs/promises';

import {
  createAudioChunksIfNeeded,
  extractAudioFile,
  mediaDurationFromMetadata,
  probeMediaMetadata,
  resolveAudioChunkOptions
} from '../../audio/index.js';
import { pathExists, sha256File, toSessionRelative, writeJson } from '../../utils/fs.js';
import type { AudioChunkOptions, RuntimeConfig, TranscriptionConfig } from '../../types.js';
import type { Session } from '../../session/index.js';
import { providerAudioStrategy } from '../../transcription/provider.js';

export async function runAudioStage(input: {
  session: Session;
  runtime: RuntimeConfig;
  transcription: TranscriptionConfig;
  chunking?: AudioChunkOptions;
}): Promise<void> {
  const { session, runtime } = input;
  const chunkOptions = resolveAudioChunkOptions(input.chunking);

  await mkdir(session.artifact('audio'), { recursive: true });
  const metadataPath = session.artifact('audio', 'metadata.json');
  const audioPath = session.artifact('audio', 'extracted.m4a');
  const mediaHash = await sha256File(session.mediaPath);

  const metadata = await probeMediaMetadata(runtime.ffprobeBin, session.mediaPath);
  await writeJson(metadataPath, metadata);

  const expectedMediaHash =
    typeof session.state.input.media_sha256 === 'string'
      ? session.state.input.media_sha256
      : typeof session.stage('audio').media_sha256 === 'string'
        ? session.stage('audio').media_sha256
        : undefined;
  const expectedAudioSize = Number(session.stage('audio').audio_size);
  const expectedAudioSha256 =
    typeof session.stage('audio').audio_sha256 === 'string'
      ? session.stage('audio').audio_sha256
      : undefined;
  const canReuseAudio =
    expectedMediaHash === mediaHash &&
    (await pathExists(audioPath)) &&
    (!Number.isFinite(expectedAudioSize) || (await stat(audioPath)).size === expectedAudioSize) &&
    (!expectedAudioSha256 || (await sha256File(audioPath)) === expectedAudioSha256);
  if (!canReuseAudio) {
    await extractAudioFile(runtime.ffmpegBin, session.mediaPath, audioPath);
  }

  const audioSize = (await stat(audioPath)).size;
  const audioSha256 = await sha256File(audioPath);
  session.setMediaHash(mediaHash);
  const currentStage = session.stage('audio');
  const baseStage = {
    status: currentStage.status,
    ...(typeof currentStage.started_at === 'string' ? { started_at: currentStage.started_at } : {}),
    metadata: toSessionRelative(session.dir, metadataPath),
    audio: toSessionRelative(session.dir, audioPath),
    audio_size: audioSize,
    audio_sha256: audioSha256,
    duration: mediaDurationFromMetadata(metadata),
    media_sha256: mediaHash
  };
  const strategy = providerAudioStrategy(input.transcription);
  if (strategy === 'single_file') {
    session.state.stages.audio = {
      ...baseStage,
      strategy
    };
    return;
  }

  const chunksDir = session.artifact('audio', 'chunks');
  const { chunks, chunking } = await createAudioChunksIfNeeded(
    runtime,
    audioPath,
    chunksDir,
    chunkOptions
  );
  session.state.stages.audio = {
    ...baseStage,
    strategy,
    chunks_dir: toSessionRelative(session.dir, chunksDir),
    chunk_count: chunks.length,
    chunking,
    chunks: chunks.map((chunk) => ({
      audio: toSessionRelative(session.dir, chunk.audioPath),
      start: chunk.start,
      end: chunk.end,
      size: chunk.size,
      sha256: chunk.sha256
    }))
  };
}
