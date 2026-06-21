import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { MarkdownCopyButton, ViewOptionsPopover } from 'fumadocs-ui/layouts/docs/page';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import type { Root } from 'fumadocs-core/page-tree';
import { BilibiliVideoCard } from './components/bilibili-video-card';
import { type DocsPageData, source } from './source';

const docsTree: Root = {
  name: 'Rajio',
  children: [
    {
      type: 'folder',
      name: '介绍',
      defaultOpen: true,
      children: [
        {
          type: 'page',
          name: '快速开始',
          url: '/docs'
        },
        {
          type: 'page',
          name: '什么是 Rajio',
          url: '/docs/what-is-rajio'
        },
        {
          type: 'page',
          name: 'Rajio 会话工作区',
          url: '/docs/session-workspace'
        }
      ]
    },
    {
      type: 'folder',
      name: '示例',
      defaultOpen: true,
      children: [
        {
          type: 'page',
          name: '也想让夏天绽放樱花',
          url: '/docs/examples'
        }
      ]
    },
    {
      type: 'folder',
      name: '配置参考',
      defaultOpen: true,
      children: [
        {
          type: 'page',
          name: '环境变量',
          url: '/docs/environment'
        },
        {
          type: 'page',
          name: '音频处理',
          url: '/docs/audio'
        }
      ]
    },
    {
      type: 'folder',
      name: 'CLI 参考',
      defaultOpen: true,
      children: [
        {
          type: 'page',
          name: '总览',
          url: '/docs/cli'
        },
        {
          type: 'page',
          name: '默认命令',
          url: '/docs/cli/default'
        },
        {
          type: 'page',
          name: 'check',
          url: '/docs/cli/check'
        },
        {
          type: 'page',
          name: 'doctor',
          url: '/docs/cli/doctor'
        },
        {
          type: 'page',
          name: 'clean',
          url: '/docs/cli/clean'
        },
        {
          type: 'page',
          name: 'segments',
          url: '/docs/cli/segments'
        },
        {
          type: 'page',
          name: 'clips',
          url: '/docs/cli/clips'
        }
      ]
    }
  ]
};

const githubContentUrl = 'https://github.com/yjl9903/rajio/blob/main/apps/landing/content/docs';
const mdxComponents = {
  ...defaultMdxComponents,
  BilibiliVideoCard,
  Step,
  Steps,
  Tab,
  Tabs
};

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
  const slug = slugs?.join('/') ?? 'index';
  const markdownUrl = slug === 'index' ? '/docs.md' : `/docs/${slug}.md`;
  const githubUrl = `${githubContentUrl}/${slug}.mdx`;

  return (
    <DocsLayout
      tree={docsTree}
      githubUrl="https://github.com/yjl9903/rajio"
      nav={{
        title: (
          <span className="docs-nav-title">
            <img src="/rajio-icon.png" alt="" />
            Rajio
          </span>
        ),
        url: '/'
      }}
      sidebar={{ defaultOpenLevel: 2 }}
      searchToggle={{ enabled: true }}
    >
      <DocsPage toc={data.toc}>
        <DocsTitle>{data.title}</DocsTitle>
        <DocsDescription>{data.description}</DocsDescription>
        <div className="docs-actions">
          <MarkdownCopyButton markdownUrl={markdownUrl}>复制 Markdown</MarkdownCopyButton>
          <ViewOptionsPopover
            className="docs-open-button"
            markdownUrl={markdownUrl}
            githubUrl={githubUrl}
          >
            打开
          </ViewOptionsPopover>
        </div>
        <DocsBody>
          <MDX components={mdxComponents} />
        </DocsBody>
      </DocsPage>
    </DocsLayout>
  );
}
