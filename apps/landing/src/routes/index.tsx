import { Link, createFileRoute } from '@tanstack/react-router';
import coverUrl from '../../../../examples/【高画質・完全版】春日さくらと乾夏寧の夏もさくらを咲かせたい 第49回/cover-1280x720.jpg?url';

export const Route = createFileRoute('/')({
  component: HomePage
});

function HomePage() {
  return (
    <main>
      <nav className="landing-nav" aria-label="Main">
        <Link to="/">Rajio</Link>
        <Link to="/docs">文档</Link>
      </nav>
      <section className="hero">
        <div className="hero-copy">
          <p>日语声优广播翻译工作流</p>
          <h1>Rajio</h1>
          <p>用可恢复的 TypeScript CLI，把长篇广播音频整理成可审校的转写稿、中文翻译和字幕文件。</p>
          <Link className="button-link" to="/docs/$slug" params={{ slug: 'getting-started' }}>
            阅读文档
          </Link>
        </div>
        <img src={coverUrl} alt="声优广播节目封面示例" />
      </section>
      <section className="card-grid page" aria-label="功能亮点">
        <article className="card">
          <h2>可恢复</h2>
          <p>会话状态会记录每一步产物，长任务中断后也能继续处理。</p>
        </article>
        <article className="card">
          <h2>适合协作审校</h2>
          <p>人工检查阶段保留清晰的文件边界，方便人或 Codex 逐段修改。</p>
        </article>
        <article className="card">
          <h2>面向字幕交付</h2>
          <p>检查重点覆盖转写、翻译、SRT 和 ASS 输出，减少发布前返工。</p>
        </article>
      </section>
    </main>
  );
}
