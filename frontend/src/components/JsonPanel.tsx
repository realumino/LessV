/**
 * A read-only, pretty-printed JSON pane.
 *
 * WHY the three-value convention (undefined = loading, null = empty,
 * otherwise content): every config pane on the node page has the same
 * lifecycle, and one component keeps the loading/empty distinction
 * identical across them.
 */
export default function JsonPanel({
  title,
  subtitle,
  value,
  empty,
}: {
  title: string;
  subtitle?: string;
  value: unknown;
  empty: string;
}) {
  return (
    <section className="cf-card">
      <div className="cf-card__head">
        <h2 className="cf-card__title">{title}</h2>
        {subtitle && <span className="cf-card__meta">{subtitle}</span>}
      </div>
      {value === undefined ? (
        <div className="cf-card__body">
          <span className="cf-meta">Loading…</span>
        </div>
      ) : value === null ? (
        <div className="cf-card__body">
          <span className="cf-meta">{empty}</span>
        </div>
      ) : (
        <pre className="cf-code">{JSON.stringify(value, null, 2)}</pre>
      )}
    </section>
  );
}
