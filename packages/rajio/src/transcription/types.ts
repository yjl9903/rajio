import type { DescriptionInfo, RuntimeConfig, TranscriptionConfig } from '../types.js';

export interface TranscribeInput {
  audioPath: string;
  mediaPath: string;
  description: DescriptionInfo;
  runtime: RuntimeConfig;
  transcription: TranscriptionConfig;
}

export interface TranscriptInputResult {
  index: number;
  audioPath: string;
  start: number;
  end: number;
  response: unknown;
}
