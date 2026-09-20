export function LoadingPlaceholder({ label, rows = 3 }: { label: string; rows?: number }) {
  return <div className="loading-placeholder" role="status">
    <span className="loading-label">{label}</span>
    <div className="loading-placeholder-rows" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => <div className="loading-placeholder-row" key={index}>
        <span /><span />
      </div>)}
    </div>
  </div>;
}
