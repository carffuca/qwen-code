import type { CSSProperties } from 'react';

interface PromptChevronProps {
  className?: string;
  style?: CSSProperties;
}

export function PromptChevron({ className, style }: PromptChevronProps) {
  // Shared "user's turn" marker for both the input and sent messages — a serif
  // "›" that reads editorial, identical in both places so the mental model holds.
  return (
    <span
      className={className}
      style={{
        fontFamily: 'var(--font-heading)',
        fontSize: '1.35em',
        lineHeight: 1,
        ...style,
      }}
      aria-hidden="true"
    >
      ›
    </span>
  );
}
