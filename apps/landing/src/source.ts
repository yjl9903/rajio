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

const docs = Object.entries(
  import.meta.glob<DocModule>('../content/docs/**/*.{md,mdx}', {
    eager: true,
    query: {
      collection: 'docs'
    }
  })
).map(([path, doc]) => {
  const virtualPath = path.replace('../content/docs/', '');

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
      getText: async () => '',
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
