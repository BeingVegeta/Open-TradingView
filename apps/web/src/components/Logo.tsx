export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M9 7v18M16 4v24M23 9v14"
        stroke="var(--text-faint)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <rect x="6" y="11" width="6" height="9" rx="1.5" fill="var(--up)" />
      <rect x="13" y="8" width="6" height="12" rx="1.5" fill="var(--down)" />
      <rect x="20" y="13" width="6" height="7" rx="1.5" fill="var(--up)" />
    </svg>
  );
}
