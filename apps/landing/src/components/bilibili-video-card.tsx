type BilibiliVideoCardProps = {
  coverSrc?: string;
  href: string;
  title: string;
};

export function BilibiliVideoCard({ coverSrc, href, title }: BilibiliVideoCardProps) {
  return (
    <article className="video-card">
      <a className="video-media video-cover-link" href={href} aria-label={`在 B 站打开：${title}`}>
        {coverSrc ? (
          <img src={coverSrc} alt="" />
        ) : (
          <span className="video-cover-placeholder">Bilibili</span>
        )}
      </a>
      <div className="video-card-body">
        <h2>{title}</h2>
      </div>
    </article>
  );
}
