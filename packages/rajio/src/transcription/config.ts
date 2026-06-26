import type {
  DescriptionInfo,
  SessionState,
  TranscriptionCliOptions,
  TranscriptionConfig
} from '../types.js';

export const DEFAULT_TRANSCRIPTION_CONFIG: TranscriptionConfig = {
  provider: 'elevenlabs',
  model: 'scribe_v2',
  segmenter: 'integrated'
};

export function resolveWorkflowTranscriptionConfig(input: {
  state: SessionState;
  description: DescriptionInfo;
  cli?: TranscriptionCliOptions;
  reset?: string;
  target: string;
}): TranscriptionConfig {
  const cli = definedCliOptions(input.cli);
  const hasCli = Object.keys(cli).length > 0;
  const recorded = input.state.transcription
    ? normalizeTranscriptionConfig(input.state.transcription)
    : undefined;

  if (recorded) {
    if (!hasCli) {
      return recorded;
    }
    const requested = normalizeTranscriptionConfig({ ...recorded, ...cli });
    if (sameTranscriptionConfig(recorded, requested)) {
      return recorded;
    }
    if (input.reset !== 'transcript_raw') {
      throw new Error(
        `Transcription config differs from session.toml. Rerun with:\nrajio ${quoteTarget(
          input.target
        )} --reset=transcript_raw ${formatTranscriptionCli(cli)}`
      );
    }
    return requested;
  }

  return normalizeTranscriptionConfig({
    ...frontmatterTranscription(input.description),
    ...cli
  });
}

export function resolveClipTranscriptionConfig(input: {
  state: SessionState;
  cli?: TranscriptionCliOptions;
}): TranscriptionConfig {
  return normalizeTranscriptionConfig({
    ...(input.state.transcription ?? DEFAULT_TRANSCRIPTION_CONFIG),
    ...definedCliOptions(input.cli)
  });
}

export function normalizeTranscriptionConfig(value: unknown): TranscriptionConfig {
  const input = isRecord(value) ? value : {};
  const provider = input.provider ?? DEFAULT_TRANSCRIPTION_CONFIG.provider;

  if (provider !== 'elevenlabs' && provider !== 'openai') {
    throw new Error(`Transcription provider "${String(provider)}" is not supported.`);
  }

  const model = input.model ?? (provider === 'openai' ? 'whisper-1' : 'scribe_v2');
  const segmenter = input.segmenter ?? DEFAULT_TRANSCRIPTION_CONFIG.segmenter;
  if (segmenter !== 'integrated') {
    throw new Error(`Transcription segmenter "${String(segmenter)}" is not supported.`);
  }
  if (
    (provider === 'elevenlabs' && model !== 'scribe_v2') ||
    (provider === 'openai' && model !== 'whisper-1')
  ) {
    throw new Error(
      `Transcription model "${String(model)}" is not supported for provider "${provider}".`
    );
  }

  return { provider, model: model as TranscriptionConfig['model'], segmenter };
}

export function sameTranscriptionConfig(
  left: TranscriptionConfig,
  right: TranscriptionConfig
): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.segmenter === right.segmenter
  );
}

function frontmatterTranscription(description: DescriptionInfo): Partial<TranscriptionConfig> {
  const value = description.frontmatter.transcription;
  if (!isRecord(value)) {
    return {};
  }
  return {
    ...(typeof value.provider === 'string' ? { provider: value.provider } : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.segmenter === 'string' ? { segmenter: value.segmenter } : {})
  } as Partial<TranscriptionConfig>;
}

function definedCliOptions(input: TranscriptionCliOptions | undefined): TranscriptionCliOptions {
  return {
    ...(input?.provider !== undefined ? { provider: input.provider } : {}),
    ...(input?.model !== undefined ? { model: input.model } : {}),
    ...(input?.segmenter !== undefined ? { segmenter: input.segmenter } : {})
  };
}

function formatTranscriptionCli(input: TranscriptionCliOptions): string {
  return [
    input.provider === undefined ? undefined : `--transcription-provider ${input.provider}`,
    input.model === undefined ? undefined : `--transcription-model ${input.model}`,
    input.segmenter === undefined ? undefined : `--transcription-segmenter ${input.segmenter}`
  ]
    .filter(Boolean)
    .join(' ');
}

function quoteTarget(target: string): string {
  return `'${target.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
