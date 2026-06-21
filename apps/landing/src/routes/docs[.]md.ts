import { createFileRoute } from '@tanstack/react-router';
import { getDocMarkdown } from '../source';

export const Route = createFileRoute('/docs.md')({
  server: {
    handlers: {
      GET: () => markdownResponse(getDocMarkdown())
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
