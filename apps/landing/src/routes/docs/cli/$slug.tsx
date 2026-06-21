import { createFileRoute, notFound } from '@tanstack/react-router';
import { RajioDocsPage } from '../../../docs-page';
import { source } from '../../../source';

export const Route = createFileRoute('/docs/cli/$slug')({
  loader: ({ params }) => {
    if (!source.getPage(['cli', params.slug])) throw notFound();
  },
  head: ({ params }) => ({
    meta: [
      {
        title: `${source.getPage(['cli', params.slug])?.data.title ?? '页面不存在'} - Rajio`
      }
    ]
  }),
  component: DocsCliSlugPage
});

function DocsCliSlugPage() {
  const { slug } = Route.useParams();

  return <RajioDocsPage slugs={['cli', slug]} />;
}
