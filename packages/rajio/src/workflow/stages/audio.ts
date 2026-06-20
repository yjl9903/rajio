import { mkdir, stat } from 'node:fs/promises';

import {
  extractAudioFile,
  mediaDurationFromMetadata,
  probeMediaMetadata,
  resolveAudioChunkOptions
} from '../../audio/index.js';
import { pathExists, sha256File, toSessionRelative, writeJson } from '../../utils/fs.js';
import type { AudioChunkOptions, RuntimeConfig, TranscriptionConfig } from '../../types.js';
import type { Session } from '../../session/index.js';

export async function runAudioStage(input: {
  session: Session;
  runtime: RuntimeConfig;
  transcription: TranscriptionConfig;
  chunking?: AudioChunkOptions;
}): Promise<void> {
  const { session, runtime } = input;
  if (input.transcription.provider !== 'elevenlabs') {
    throw new Error(`Transcription provider "${input.transcription.provider}" is not supported.`);
  }

  // Validate explicit chunk options even though ElevenLabs uses a single-file strategy.
  if (input.chunking) {
    resolveAudioChunkOptions(input.chunking);
  }

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
  session.state.stages.audio = {
    status: currentStage.status,
    ...(typeof currentStage.started_at === 'string' ? { started_at: currentStage.started_at } : {}),
    metadata: toSessionRelative(session.dir, metadataPath),
    audio: toSessionRelative(session.dir, audioPath),
    audio_size: audioSize,
    audio_sha256: audioSha256,
    strategy: 'single_file',
    duration: mediaDurationFromMetadata(metadata),
    media_sha256: mediaHash
  };
}
