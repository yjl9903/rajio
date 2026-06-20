import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { type DocsPageData, source } from './source';

export function RajioDocsPage({ slugs }: { slugs?: string[] }) {
  const page = source.getPage(slugs);

  if (!page) {
    return (
      <main className="page">
        <h1>页面不存在</h1>
        <p>请求的 Rajio 文档页面不存在。</p>
      </main>
    );
  }

  const data = page.data as DocsPageData;
  const MDX = data.body;

  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{ title: 'Rajio', url: '/' }}
      links={[{ text: '文档', url: '/docs', active: 'nested-url' }]}
    >
      <DocsPage toc={data.toc}>
        <DocsTitle>{data.title}</DocsTitle>
        <DocsDescription>{data.description}</DocsDescription>
        <DocsBody>
          <MDX components={defaultMdxComponents} />
        </DocsBody>
      </DocsPage>
    </DocsLayout>
  );
}
