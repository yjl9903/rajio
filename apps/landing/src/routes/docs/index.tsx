import { createFileRoute } from '@tanstack/react-router';
import { RajioDocsPage } from '../../docs-page';
import { source } from '../../source';

export const Route = createFileRoute('/docs/')({
  head: () => ({
    meta: [
      {
        title: `${source.getPage(undefined)?.data.title ?? '文档'} - Rajio`
      }
    ]
  }),
  component: DocsIndexPage
});

function DocsIndexPage() {
  return <RajioDocsPage />;
}
