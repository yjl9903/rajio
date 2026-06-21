import { createFileRoute } from '@tanstack/react-router';
import { docsPages } from '../source';

export const Route = createFileRoute('/llms.txt')({
  server: {
    handlers: {
      GET: () => {
        const body = [
          '# Rajio 文档',
          '',
          '> 日语视频字幕翻译 Agent 工作流文档。',
          '',
          ...docsPages.map((page) => `- [${page.title}](${page.url}): ${page.description ?? ''}`)
        ].join('\n');

        return new Response(body, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8'
          }
        });
      }
    }
  }
});
