interface EclipseMarkProps {
  size?: number;
  className?: string;
}

export function EclipseMark({ size = 32, className = '' }: EclipseMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={`eclipse-mark ${className}`}
      height={size}
      viewBox="0 0 48 48"
      width={size}
    >
      <circle className="eclipse-mark__orbit" cx="24" cy="24" r="19" />
      <circle className="eclipse-mark__inner" cx="24" cy="24" r="12.5" />
      <path className="eclipse-mark__crescent" d="M31.8 10.8A15.6 15.6 0 1 0 31.8 37.2A18.8 18.8 0 1 1 31.8 10.8Z" />
      <path className="eclipse-mark__axis" d="M4 24H10M38 24H44M24 4V10M24 38V44" />
      <circle className="eclipse-mark__core" cx="24" cy="24" r="3.2" />
      <circle className="eclipse-mark__signal" cx="39.2" cy="15.8" r="1.6" />
    </svg>
  );
}

interface BrandLockupProps {
  compact?: boolean;
}

export function BrandLockup({ compact = false }: BrandLockupProps) {
  return (
    <div className={`brand-lockup ${compact ? 'is-compact' : ''}`}>
      <EclipseMark size={compact ? 24 : 30} />
      <span className="brand-lockup__copy">
        <span>Eclipse Forge</span>
        <strong>Ultron</strong>
      </span>
    </div>
  );
}
