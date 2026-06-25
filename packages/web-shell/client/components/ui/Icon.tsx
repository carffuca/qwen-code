import type { CSSProperties } from 'react';
import { CODICONS, type CodiconGlyph, type CodiconName } from './codicons';
import styles from './Icon.module.css';

export interface IconProps {
  /** Codicon glyph name. See `codicons.ts` for the available set. */
  name: CodiconName;
  /**
   * Accessible label. Provide it when the icon conveys meaning on its own;
   * omit it for purely decorative icons (then the icon is hidden from
   * assistive tech via `aria-hidden`).
   */
  label?: string;
  /** Any CSS length. Defaults to `1em` so the icon tracks the surrounding font-size. */
  size?: string;
  /** Continuous rotation, e.g. for the `loading` glyph. */
  spin?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * Inline-SVG Codicon. Inherits color from `currentColor` and scales with
 * font-size, so it themes and aligns with surrounding text by default.
 */
export function Icon({
  name,
  label,
  size = '1em',
  spin = false,
  className,
  style,
}: IconProps) {
  const glyph: CodiconGlyph = CODICONS[name];
  const classes = [styles.icon, spin ? styles.spin : null, className]
    .filter(Boolean)
    .join(' ');
  const a11y = label
    ? { role: 'img' as const, 'aria-label': label }
    : { 'aria-hidden': true };

  return (
    <svg
      className={classes}
      viewBox={glyph.viewBox}
      width={size}
      height={size}
      fill="currentColor"
      style={style}
      {...a11y}
    >
      <path
        d={glyph.path}
        fillRule={glyph.fillRule}
        clipRule={glyph.fillRule}
      />
    </svg>
  );
}
