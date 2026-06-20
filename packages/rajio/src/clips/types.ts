import type { Segment, TranscriptionConfig } from '../types.js';

export interface ClipChunkMetadata {
  audio: string;
  checkpoint: string;
  start: number;
  end: number;
  absolute_start: number;
  absolute_end: number;
  size: number;
  sha256: string;
}

export interface ClipFile {
  id: string;
  label?: string;
  source_media: string;
  source_media_sha256: string;
  source_audio: string;
  segments: string;
  created_at: string;
  updated_at: string;
  provider?: TranscriptionConfig['provider'];
  model: string;
  segmenter?: TranscriptionConfig['segmenter'];
  start: number;
  end: number;
  strategy?: 'single_file';
  chunks: ClipChunkMetadata[];
}

export type ClipStatus = 'done' | 'failed' | 'partial' | 'missing';

export interface ClipListRow {
  id: string;
  label: string;
  start: number;
  end: number;
  duration: number;
  status: ClipStatus;
  segments: number | '';
}

export interface ClipSegmentsFile {
  version: 1;
  source: {
    kind: 'transcript';
    generated_at: string;
  };
  segments: Segment[];
}
