import { Link, createFileRoute } from '@tanstack/react-router';
import { FullSearchTrigger } from 'fumadocs-ui/layouts/shared/slots/search-trigger';
import { ThemeSwitch } from 'fumadocs-ui/layouts/shared/slots/theme-switch';

const coverUrl = '/examples/natsusaku-50.jpg';

const features = [
  {
    title: 'Agent Skill 安装',
    text: '先把 Rajio 工作流装进 Agent，再把视频任务交给它执行。快速开始页已经准备好可复制的安装和运行 prompt。'
  },
  {
    title: '可恢复会话',
    text: '转写、校对、翻译和导出都会落到会话工作区中，长视频可以中断、复查、继续。'
  },
  {
    title: '面向发布',
    text: '检查中文字幕长度、时间轴、未翻译片段和导出文件，让结果更接近可发布状态。'
  }
];

const workflow = ['提取音频并转写', '润色日语转写', '翻译中文字幕', '校对字幕质量', '导出字幕文件'];

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      {
        title: 'Rajio 日语视频中文字幕 Agent 工作流'
      }
    ]
  }),
  component: HomePage
});

function HomePage() {
  return (
    <main className="home">
      <header className="home-topbar">
        <div className="home-topbar-inner">
          <Link className="home-brand" to="/">
            <img src="/rajio-icon.png" alt="" />
            Rajio
          </Link>
          <nav className="home-primary-nav" aria-label="Main">
            <Link to="/docs">文档</Link>
            <Link to="/docs/$slug" params={{ slug: 'examples' }}>
              示例
            </Link>
            <Link to="/docs/$slug" params={{ slug: 'environment' }}>
              配置
            </Link>
          </nav>
          <div className="home-header-tools">
            <FullSearchTrigger hideIfDisabled className="home-search-trigger" />
            <ThemeSwitch className="home-theme-switch" />
            <a className="home-github" href="https://github.com/yjl9903/rajio" aria-label="GitHub">
              <svg role="img" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
            </a>
          </div>
        </div>
      </header>

      <section className="home-hero-card">
        <div className="home-hero">
          <div className="home-hero-copy">
            <p className="home-kicker">日语视频中文字幕 Agent 工作流</p>
            <h1>
              <span>Rajio 为日语视频</span>
              <span>制作中文字幕</span>
            </h1>
            <div className="home-actions">
              <Link className="home-button" to="/docs">
                快速开始
              </Link>
              <Link
                className="home-button secondary"
                to="/docs/$slug"
                params={{ slug: 'examples' }}
              >
                查看示例
              </Link>
            </div>
          </div>

          <div className="home-icon-stage" aria-hidden="true">
            <img src="/rajio-icon.png" alt="" />
          </div>
        </div>
      </section>

      <section className="home-intro">
        <p>
          <span>Rajio</span>{' '}
          是面向日语视频的中文字幕工具。它会完成转写、翻译、检查和导出，帮助你得到可以继续发布或微调的字幕文件。
        </p>
      </section>

      <section className="home-demo-grid">
        <article className="home-command">
          <p className="home-kicker">快速开始</p>
          <h2>复制 prompt，运行 Rajio 工作流</h2>
          <div className="home-command-list">
            <section>
              <span>01 安装 Skill</span>
              <pre>
                <code>{`请用 skill-installer 安装 Rajio skill。
GitHub 仓库：https://github.com/yjl9903/rajio`}</code>
              </pre>
            </section>
            <section>
              <span>02 运行工作流</span>
              <pre>
                <code>{`请使用 rajio skill，为这个会话工作区里的日语视频生成中文字幕。
会话工作区：/Users/me/videos/rajio-demo`}</code>
              </pre>
            </section>
          </div>
        </article>

        <article className="home-result">
          <img src={coverUrl} alt="Rajio 已翻译视频封面示例" />
          <div>
            <p className="home-kicker">示例视频</p>
            <h2>春日さくらと乾夏寧の夏もさくらを咲かせたい 第50回</h2>
          </div>
        </article>
      </section>

      <section className="home-section">
        <div className="home-section-heading">
          <p>Workflow</p>
          <h2>从视频到可发布字幕</h2>
        </div>
        <div className="home-steps">
          {workflow.map((item, index) => (
            <article key={item}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <p>{item}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="home-section">
        <div className="home-section-heading">
          <p>Features</p>
          <h2>给字幕 Agent 的最小工具箱</h2>
        </div>
        <div className="home-feature-grid">
          {features.map((item) => (
            <article key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="home-final">
        <h2>把 Rajio 装进你的 Agent</h2>
        <div className="home-actions">
          <Link className="home-button" to="/docs">
            阅读快速开始
          </Link>
          <Link className="home-button secondary" to="/docs/$slug" params={{ slug: 'examples' }}>
            看成片示例
          </Link>
        </div>
      </section>
    </main>
  );
}
