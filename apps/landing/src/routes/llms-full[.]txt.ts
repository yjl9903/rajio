import { createFileRoute } from '@tanstack/react-router';
import { docsPages } from '../source';

export const Route = createFileRoute('/llms-full.txt')({
  server: {
    handlers: {
      GET: () => {
        const body = docsPages
          .map((page) =>
            [
              `# ${page.title}`,
              '',
              `URL: ${page.url}`,
              '',
              page.description ?? '',
              '',
              page.raw
            ].join('\n')
          )
          .join('\n\n');

        return new Response(body, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8'
          }
        });
      }
    }
  }
});
