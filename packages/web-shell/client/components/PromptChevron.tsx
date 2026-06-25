import type { CSSProperties } from 'react';
import { Icon } from './ui/Icon';

interface PromptChevronProps {
  className?: string;
  style?: CSSProperties;
}

export function PromptChevron({ className, style }: PromptChevronProps) {
  return (
    <Icon
      name="chevron-right"
      size="0.85em"
      className={className}
      style={style}
    />
  );
}
