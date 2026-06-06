import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Codex, type ThreadEvent } from '@openai/codex-sdk';

import type { DescriptionInfo, ManualStageName, RuntimeConfig } from '../types.js';
import { pathExists } from '../utils/fs.js';

export async function runCodexAgent(input: {
  sessionDir: string;
  stage: ManualStageName;
  segmentsPath: string;
  description: DescriptionInfo;
  runtime: RuntimeConfig;
}): Promise<void> {
  const outputPath = agentOutputPath(input.sessionDir, input.stage);
  await rotateAgentOutput(outputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });

  const codex = new Codex({
    apiKey: input.runtime.openaiApiKey,
    baseUrl: input.runtime.openaiBaseUrl
  });
  const thread = codex.startThread({
    workingDirectory: input.sessionDir,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    skipGitRepoCheck: true
  });

  const { events } = await thread.runStreamed(
    buildAgentPrompt(input.stage, input.segmentsPath, input.description)
  );
  let failed: string | undefined;

  for await (const event of events) {
    await appendJsonLine(outputPath, event);
    if (event.type === 'turn.failed') {
      failed = event.error.message;
    } else if (event.type === 'error') {
      failed = event.message;
    }
  }

  if (failed) {
    throw new Error(`Codex agent failed: ${failed}`);
  }
}

export function agentOutputPath(sessionDir: string, stage: ManualStageName): string {
  const root = stage === 'transcript_work' ? 'transcript' : 'translation';
  return path.join(sessionDir, root, 'work', 'agent-output.jsonl');
}

async function rotateAgentOutput(outputPath: string): Promise<void> {
  if (!(await pathExists(outputPath))) {
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await rename(outputPath, `${outputPath}.${stamp}`);
}

async function appendJsonLine(outputPath: string, event: ThreadEvent): Promise<void> {
  await writeFile(outputPath, `${JSON.stringify(event)}\n`, { flag: 'a' });
}

function buildAgentPrompt(
  stage: ManualStageName,
  segmentsPath: string,
  description: DescriptionInfo
): string {
  const task =
    stage === 'transcript_work'
      ? '校对和润色日语原文转写。检查说话人、断句、错字、术语、人名和时间轴连贯性。不要翻译。'
      : '校对和润色中文字幕。保持日语、时间轴、segment id 和 speaker 不变，只改 zh。';

  return `你正在 rajio 字幕 session 中工作。

任务：
${task}

必须编辑这个 TOML 文件：
${segmentsPath}

要求：
- 保持 TOML 结构不变。
- 不要合并或删除 segment，除非明显必要；如需调整时间轴，保持递增且不重叠。
- 每条字幕不要过长，尽量按语义断点切分。
- 不要修改与任务无关的文件。

上下文：
${description.body || '(无 description.md 正文上下文)'}
`;
}
