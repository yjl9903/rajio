import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  fromSessionRelative,
  sanitizeFileStem,
  toSessionRelative,
  writeFileAtomic
} from '../../utils/fs.js';
import { assertValidSegments, readSegmentsFile } from '../../segments/index.js';
import { renderAss, renderSrt } from '../subtitles.js';
import type { Session } from '../../session/index.js';

export async function runExportStage(session: Session): Promise<void> {
  const translation = session.stage('translation_work');
  if (translation.status !== 'committed' || typeof translation.segments !== 'string') {
    throw new Error('translation_work must be committed before export.');
  }
  const segmentsPath = fromSessionRelative(session.dir, translation.segments);
  const segments = assertValidSegments(await readSegmentsFile(segmentsPath), { requireZh: true });
  const title = session.description.frontmatter.title || path.parse(session.mediaPath).name;
  const stem = sanitizeFileStem(title);
  const outputDir = session.artifact('output');
  await mkdir(outputDir, { recursive: true });

  const jaSrt = path.join(outputDir, `${stem}.ja.srt`);
  const zhSrt = path.join(outputDir, `${stem}.zh.srt`);
  const bilingualAss = path.join(outputDir, `${stem}.ja-zh.ass`);

  await writeFileAtomic(jaSrt, renderSrt(segments, 'ja'));
  await writeFileAtomic(zhSrt, renderSrt(segments, 'zh'));
  await writeFileAtomic(bilingualAss, renderAss(segments, title));

  session.setStage('export', {
    ...session.stage('export'),
    status: 'done',
    ja_srt: toSessionRelative(session.dir, jaSrt),
    zh_srt: toSessionRelative(session.dir, zhSrt),
    bilingual_ass: toSessionRelative(session.dir, bilingualAss),
    completed_at: new Date().toISOString()
  });
}
