import { loader } from 'fumadocs-core/source';
import type { MDXContent } from 'mdx/types';

export type DocsPageData = {
  body: MDXContent;
  description?: string;
  title: string;
  toc: [];
};

type DocModule = {
  default: DocsPageData['body'];
  frontmatter: {
    title: string;
    description?: string;
  };
  structuredData: unknown;
  toc: [];
};

const docEntries = Object.entries(
  import.meta.glob<DocModule>('../content/docs/**/*.{md,mdx}', {
    eager: true,
    query: {
      collection: 'docs'
    }
  })
);

const rawDocEntries = new Map(
  Object.entries(
    import.meta.glob<string>('../content/docs/**/*.{md,mdx}', {
      eager: true,
      import: 'default',
      query: '?raw'
    })
  ).map(([path, body]) => [path.replace('../content/docs/', ''), body])
);

function toDocsUrl(path: string) {
  const slug = path.replace(/\.(md|mdx)$/, '');

  if (slug === 'index') return '/docs';

  return `/docs/${slug}`;
}

export const docsPages = docEntries.map(([path, doc]) => {
  const virtualPath = path.replace('../content/docs/', '');

  return {
    description: doc.frontmatter.description,
    path: virtualPath,
    raw: rawDocEntries.get(virtualPath) ?? '',
    title: doc.frontmatter.title,
    url: toDocsUrl(virtualPath)
  };
});

export function getDocMarkdown(slugs?: string[]) {
  const slug = slugs?.join('/') ?? 'index';

  return docsPages.find((page) => page.path.replace(/\.(md|mdx)$/, '') === slug)?.raw;
}

const docs = docEntries.map(([path, doc]) => {
  const virtualPath = path.replace('../content/docs/', '');
  const raw = rawDocEntries.get(virtualPath) ?? '';

  return {
    type: 'page' as const,
    path: virtualPath,
    data: {
      ...doc.frontmatter,
      body: doc.default,
      structuredData: doc.structuredData,
      toc: doc.toc,
      _exports: doc,
      info: {
        path: virtualPath,
        fullPath: virtualPath
      },
      getText: async () => raw,
      getMDAST: async () => {
        throw new Error('MDAST is not generated for the landing docs.');
      }
    }
  };
});

export const source = loader({
  baseUrl: '/docs',
  source: {
    files: docs as any
  }
});
