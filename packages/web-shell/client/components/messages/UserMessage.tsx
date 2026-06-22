import { memo, useEffect, useRef, useState } from 'react';
import { PromptChevron } from '../PromptChevron';
import { isSafeImageSrc } from './Markdown';
import { useI18n } from '../../i18n';
import type { CommandInfo, TurnCollapseHead } from '../../adapters/types';
import { metricsText, processLabel } from './turnSummary';
import styles from './UserMessage.module.css';

interface UserMessageImage {
  data: string;
  mimeType: string;
}

interface UserMessageProps {
  content: string;
  images?: UserMessageImage[];
  commands?: readonly CommandInfo[];
  /** When set, renders a toggle that folds/unfolds this turn's steps. */
  collapse?: TurnCollapseHead;
  onToggleCollapse?: (turnId: string) => void;
}

/**
 * Wall-clock that re-renders this row once a second while `active`, so a live
 * turn's elapsed advances smoothly instead of jumping per step. Idle (and for
 * completed turns) it never ticks. App code, so `Date.now()` is available.
 */
function useNowTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function isKnownSlashCommandPrompt(
  content: string,
  commands: readonly CommandInfo[] | undefined,
): boolean {
  if (!commands?.length) return false;
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('/')) return false;
  const firstToken = trimmed.split(/\s+/, 1)[0]?.slice(1);
  if (!firstToken) return false;
  return commands.some((command) => command.name === firstToken);
}

export const UserMessage = memo(function UserMessage({
  content,
  images,
  commands,
  collapse,
  onToggleCollapse,
}: UserMessageProps) {
  const { t } = useI18n();

  // Pulse the summary bar only when the process *auto*-collapses (the model
  // started its conclusion), so the user sees where the steps went. A manual
  // toggle already ties the action to its result, so it doesn't pulse.
  const collapsedNow = collapse?.collapsed;
  const prevCollapsedRef = useRef(collapsedNow);
  const userToggledRef = useRef(false);
  const [collapsePulse, setCollapsePulse] = useState(false);
  useEffect(() => {
    const prev = prevCollapsedRef.current;
    prevCollapsedRef.current = collapsedNow;
    if (collapsedNow === true && prev === false) {
      if (userToggledRef.current) {
        userToggledRef.current = false; // manual collapse — consume, no pulse
        return;
      }
      setCollapsePulse(true);
      // Keep in sync with the summary-pulse CSS duration (1400ms).
      const timer = setTimeout(() => setCollapsePulse(false), 1400);
      return () => clearTimeout(timer);
    }
  }, [collapsedNow]);

  // A live turn ticks `now - liveStartedAt`; a completed turn shows its frozen
  // elapsedMs. The ref clamps the shown value monotonically so it never steps
  // backward when a live turn settles onto its (timestamp-derived) final figure.
  const liveStartedAt = collapse?.liveStartedAt;
  const now = useNowTicker(liveStartedAt !== undefined);
  const elapsedSeenRef = useRef(0);
  let displayElapsedMs: number | undefined;
  if (liveStartedAt !== undefined) {
    elapsedSeenRef.current = Math.max(
      elapsedSeenRef.current,
      Math.max(0, now - liveStartedAt),
    );
    displayElapsedMs = elapsedSeenRef.current;
  } else if (collapse?.elapsedMs !== undefined) {
    elapsedSeenRef.current = Math.max(
      elapsedSeenRef.current,
      collapse.elapsedMs,
    );
    displayElapsedMs = elapsedSeenRef.current;
  } else {
    displayElapsedMs = undefined;
  }

  // The chevron and step count toggle together (one comfortably-sized target);
  // the trailing metrics are inert. A step-less turn has no toggle, just metrics.
  const hasToggle = !!collapse && collapse.hiddenCount > 0;
  const metrics = collapse ? metricsText(collapse, displayElapsedMs, t) : '';
  const isSlashCommand = isKnownSlashCommandPrompt(content, commands);

  // Collapsed bar reads "过程 · 思考 2 · 工具 3" from per-kind step counts, so it
  // conveys what the turn did without ballooning as tools pile up.
  const turnLabel = collapse ? processLabel(collapse, t) : '';

  // A process-less turn (no foldable steps) shows no second row — its metrics
  // ride on the prompt line instead, so metrics always sit right and no
  // empty-left row appears.
  // Slash-command prompts (e.g. /clear) render plainly — no process toggle or
  // metrics — matching upstream's slash-command handling.
  const promptMetrics = !hasToggle && !isSlashCommand ? metrics : '';
  const collapseRow =
    !isSlashCommand && collapse && onToggleCollapse && hasToggle ? (
      <div className={styles.collapseRow}>
        <button
          type="button"
          className={[
            styles.collapseToggle,
            // While the turn is still streaming, sweep a color shimmer across the
            // label so it reads as "in progress".
            collapse.liveStartedAt !== undefined &&
              styles.collapseToggleLoading,
            collapsePulse && styles.collapsePulse,
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => {
            userToggledRef.current = true;
            onToggleCollapse(collapse.turnId);
          }}
          aria-expanded={!collapse.collapsed}
          aria-label={
            collapse.collapsed ? t('turn.expand') : t('turn.collapse')
          }
          title={collapse.collapsed ? t('turn.expand') : t('turn.collapse')}
        >
          {`${collapse.collapsed ? '▸' : '▾'} ${turnLabel}`}
        </button>
        {metrics && (
          <span
            className={`${styles.collapseMeta} ${styles.collapseMetaRight}`}
          >
            {metrics}
          </span>
        )}
      </div>
    ) : null;

  const card = (
    <div className={styles.message}>
      <span className={styles.prefix}>
        <PromptChevron />
      </span>
      <div className={styles.body}>
        {images && images.length > 0 && (
          <div className={styles.images}>
            {images.map((img, index) => {
              const src = img.data.startsWith('data:')
                ? img.data
                : `data:${img.mimeType};base64,${img.data}`;
              if (!isSafeImageSrc(src)) return null;
              return (
                <img
                  key={index}
                  src={src}
                  alt={`User uploaded image ${index + 1}`}
                  className={styles.imageThumb}
                />
              );
            })}
          </div>
        )}
        {content}
      </div>
      {promptMetrics && (
        <span className={styles.promptMetrics}>{promptMetrics}</span>
      )}
    </div>
  );

  // When the turn is expanded AND a drawer row sits directly below, the head
  // drops its bottom rounding/gap so it fuses into one continuous card with the
  // process band (the band rounds the bottom). If the turn instead opens with
  // answer prose, the head stays a self-contained rounded card.
  const open =
    hasToggle &&
    !!collapse &&
    !collapse.collapsed &&
    collapse.drawerStartsBelow === true;

  // One card: the prompt on top, the process bar (toggle + metrics) fused below.
  return (
    <div
      className={[
        styles.turnHead,
        collapse?.collapsed ? styles.turnHeadCollapsed : '',
        open ? styles.turnHeadOpen : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {card}
      {collapseRow}
    </div>
  );
});
