import type { TurnCollapseHead } from '../../adapters/types';

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/** Fixed display order for the process summary's per-kind step counts. */
export const STEP_KIND_ORDER = ['thinking', 'tool', 'agent', 'plan'] as const;

/** Compact turn duration: `820ms` · `12.4s` · `1m 5s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  return `${minutes}m ${seconds}s`;
}

/** Token count abbreviated past 1k (e.g. `3.1k`), matching the context badge. */
export function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
}

/**
 * Inert metrics shown after the fold toggle: duration and `↑input ↓output`
 * tokens, each present only when measured. Cached reads are a subset of input,
 * shown parenthetically on ↑input with their share ("↑3.1k (2.8k cached, 90%)")
 * so they read as "of which N cached", not an additive figure. e.g.
 * `12.4s · ↑3.1k (2.8k cached, 90%) ↓5.1k`.
 */
export function metricsText(
  collapse: TurnCollapseHead,
  elapsedMs: number | undefined,
  t: Translate,
): string {
  const parts: string[] = [];
  if (elapsedMs !== undefined) {
    parts.push(formatDuration(elapsedMs));
  }
  if (
    collapse.inputTokens !== undefined &&
    collapse.outputTokens !== undefined
  ) {
    const cachedTokens = collapse.cachedTokens ?? 0;
    const cached =
      cachedTokens > 0 && collapse.inputTokens > 0
        ? ` (${formatTokenCount(cachedTokens)} ${t('turn.cached')}, ${Math.round(
            (cachedTokens / collapse.inputTokens) * 100,
          )}%)`
        : '';
    parts.push(
      `↑${formatTokenCount(collapse.inputTokens)}${cached} ↓${formatTokenCount(
        collapse.outputTokens,
      )}`,
    );
  }
  return parts.join(' · ');
}

/**
 * The process bar's left side: "过程 · 思考 N · 工具 N · 记录 N",
 * built from the per-kind step counts plus the note (key-row) count. Falls back
 * to a plain step count when no per-kind summary is available.
 */
export function processLabel(collapse: TurnCollapseHead, t: Translate): string {
  const counts = collapse.summary;
  const parts = counts
    ? STEP_KIND_ORDER.filter((kind) => counts[kind] > 0).map(
        (kind) => `${t(`turn.kind.${kind}`)} ${counts[kind]}`,
      )
    : [];
  if (collapse.noteCount) {
    parts.push(`${t('turn.kind.note')} ${collapse.noteCount}`);
  }
  if (parts.length === 0) {
    return `${t('turn.process')} · ${t('turn.hiddenSteps', {
      count: collapse.hiddenCount,
    })}`;
  }
  return [t('turn.process'), ...parts].join(' · ');
}
