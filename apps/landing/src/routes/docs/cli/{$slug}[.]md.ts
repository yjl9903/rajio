import { createFileRoute } from '@tanstack/react-router';
import { getDocMarkdown } from '../../../source';

export const Route = createFileRoute('/docs/cli/{$slug}.md')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => {
        const pathname = new URL(request.url).pathname;
        const slug = pathname.replace(/^\/docs\/cli\//, '').replace(/\.md$/, '');

        return markdownResponse(getDocMarkdown(['cli', slug]));
      }
    }
  }
});

function markdownResponse(body?: string) {
  if (!body) return new Response('Not found', { status: 404 });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8'
    }
  });
}
