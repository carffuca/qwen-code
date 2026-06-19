import {
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
  type MutableRefObject,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Message, ACPToolCall, TurnCollapseHead } from '../adapters/types';
import type { PermissionRequest } from '../adapters/types';
import {
  isBackgroundSubAgentToolCall,
  isSubAgentToolCall,
} from '../adapters/toolClassification';
import { CompactModeContext } from '../App';
import { useWebShellCustomization } from '../customization';
import { MessageItem } from './MessageItem';
import { MessageTimestamp } from './MessageTimestamp';
import { ParallelAgentsGroup } from './messages/tools/ParallelAgentsGroup';
import { ToolApproval } from './messages/ToolApproval';
import { AskUserQuestion } from './messages/AskUserQuestion';
import { toolContainsCallId } from './messages/toolFormatting';
import { metricsText, processLabel } from './messages/turnSummary';
import { useI18n } from '../i18n';
import styles from './MessageList.module.css';

interface MessageListProps {
  messages: Message[];
  pendingApproval: PermissionRequest | null;
  onConfirm: (
    id: string,
    selectedOption: string,
    answers?: Record<string, string>,
  ) => void;
  /** Run /context detail, exactly like typing it (context-usage panels). */
  onShowContextDetail?: () => void;
  catchingUp?: boolean;
  /**
   * True while the agent is still answering. The newest turn then stays
   * expanded and un-collapsible so streaming output is never hidden.
   */
  isResponding?: boolean;
  welcomeHeader?: ReactNode;
  workspaceCwd?: string;
  tailContent?: ReactNode;
  tailKey?: string;
  virtualScrollThreshold?: number;
  shellOutputMaxLines: number;
  /**
   * When true, scroll the tail content into view the moment it first appears
   * even if the user had scrolled up. Opt-in per caller so unrelated inline
   * panels don't yank the reader to the bottom. Defaults to false.
   */
  autoScrollTailIntoView?: boolean;
  showRetryHint?: boolean;
  onRetryClick?: () => void;
}

function isAskUserQuestion(request: PermissionRequest): boolean {
  return (
    !!request.rawInput?.questions && Array.isArray(request.rawInput.questions)
  );
}

function approvalMatchesToolGroup(
  messages: Message[],
  approval: PermissionRequest | null,
): boolean {
  if (!approval?.toolCallId) return false;
  for (const msg of messages) {
    if (msg.role === 'tool_group') {
      if (msg.tools.some((t) => toolContainsCallId(t, approval.toolCallId!)))
        return true;
    }
  }
  return false;
}

function getLastUserMessageId(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') return msg.id;
  }
  return null;
}

/**
 * Count substantive messages appended after `sinceId` (the last row the reader
 * had caught up to). Keyed by id — robust to the array being rebuilt each
 * transcript update. Thinking-only / empty assistant placeholders are skipped so
 * the tally tracks visible output. Returns 0 when the baseline is unknown.
 *
 * While a reply is still streaming (`isResponding`), the active turn's messages
 * are NOT counted yet: a message only tallies once its output has settled, so
 * scrolling up mid-stream doesn't pre-increment — the "+1" lands when the reply
 * finishes (matching Claude Code). The active turn spans the last user message
 * onward.
 */
function countUnseenMessages(
  messages: Message[],
  sinceId: string | null,
  isResponding: boolean,
): number {
  if (!sinceId) return 0;
  const idx = messages.findIndex((m) => m.id === sinceId);
  if (idx === -1) return 0;
  let end = messages.length;
  if (isResponding) {
    for (let i = messages.length - 1; i > idx; i--) {
      if (messages[i].role === 'user') {
        end = i;
        break;
      }
    }
  }
  let count = 0;
  for (let i = idx + 1; i < end; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && !m.content) continue;
    count++;
  }
  return count;
}

export type DisplayItem =
  | {
      type: 'message';
      key: string;
      message: Message;
      /**
       * Present only on a turn's leading user-message row when the turn is
       * collapsible; drives the prompt-row expand/collapse toggle.
       */
      collapse?: TurnCollapseHead;
      /**
       * Process-drawer row: an expanded turn's intermediate step, rendered
       * inside the drawer with a left timeline rail.
       */
      drawer?: boolean;
      /**
       * This drawer row is mid auto-collapse — kept rendered for one fade-out
       * beat before the fold removes it, so the process doesn't just blink out.
       */
      collapsing?: boolean;
    }
  | {
      type: 'parallel_agents';
      key: string;
      agents: ACPToolCall[];
      /**
       * Wall-clock time of the first grouped launch, carried so the grouped
       * box reveals its time on hover exactly like a standalone message row.
       */
      timestamp?: number;
      /** Process drawer: see the message variant's `drawer`. */
      drawer?: boolean;
      /** Mid auto-collapse fade-out; see the message variant. */
      collapsing?: boolean;
    };

function isAgentOnlyToolGroup(msg: Message): boolean {
  return (
    msg.role === 'tool_group' &&
    msg.tools.length === 1 &&
    isSubAgentToolCall(msg.tools[0])
  );
}

function isBackgroundAgentOnlyToolGroup(msg: Message): boolean {
  return (
    msg.role === 'tool_group' &&
    msg.tools.length === 1 &&
    isBackgroundSubAgentToolCall(msg.tools[0])
  );
}

function isBackgroundLaunchNarration(msg: Message): boolean {
  // The daemon often streams short main-agent thought text between background
  // launches, e.g. "agent A is running, now starting agent B". The CLI treats
  // those as internal launch narration and shows a single Parallel agents box.
  // Only skip thought-only messages here; any user-facing assistant content
  // still breaks the group and remains visible.
  return msg.role === 'assistant' && Boolean(msg.thinking) && !msg.content;
}

function isForceExpandGroup(
  msg: Message,
  pendingApproval: PermissionRequest | null,
): boolean {
  if (msg.role !== 'tool_group') return false;
  if (
    pendingApproval?.toolCallId &&
    msg.tools.some((t) => toolContainsCallId(t, pendingApproval.toolCallId!))
  )
    return true;
  return false;
}

function isHiddenInCompactMode(msg: Message): boolean {
  if (msg.role === 'assistant' && msg.thinking && !msg.content) return true;
  return false;
}

function mergeCompactToolGroups(
  messages: Message[],
  pendingApproval: PermissionRequest | null,
): Message[] {
  const result: Message[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role !== 'tool_group' || isForceExpandGroup(msg, pendingApproval)) {
      if (!isHiddenInCompactMode(msg)) {
        result.push(msg);
      }
      i++;
      continue;
    }

    const mergeableGroups: Message[] = [msg];
    let lastMergedIdx = i;
    let j = i + 1;

    while (j < messages.length) {
      const next = messages[j];

      if (isHiddenInCompactMode(next)) {
        j++;
        continue;
      }

      if (
        next.role === 'tool_group' &&
        !isForceExpandGroup(next, pendingApproval)
      ) {
        mergeableGroups.push(next);
        lastMergedIdx = j;
        j++;
        continue;
      }

      break;
    }

    if (mergeableGroups.length === 1) {
      result.push(msg);
      i++;
      continue;
    }

    const mergedTools = mergeableGroups.flatMap((g) =>
      g.role === 'tool_group' ? g.tools : [],
    );
    result.push({
      id: mergeableGroups[0].id,
      role: 'tool_group',
      tools: mergedTools,
    });
    i = lastMergedIdx + 1;
  }

  return result;
}

export function groupParallelAgents(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let i = 0;
  while (i < messages.length) {
    if (isBackgroundAgentOnlyToolGroup(messages[i])) {
      const grouped: Message[] = [];
      let j = i;
      while (j < messages.length) {
        const current = messages[j];
        if (isBackgroundAgentOnlyToolGroup(current)) {
          grouped.push(current);
          j++;
          continue;
        }
        if (isBackgroundLaunchNarration(current)) {
          let nextAgentIdx = j + 1;
          while (
            nextAgentIdx < messages.length &&
            isBackgroundLaunchNarration(messages[nextAgentIdx])
          ) {
            nextAgentIdx++;
          }
          if (
            nextAgentIdx < messages.length &&
            isBackgroundAgentOnlyToolGroup(messages[nextAgentIdx])
          ) {
            j = nextAgentIdx;
            continue;
          }
        }
        break;
      }

      if (grouped.length >= 2) {
        items.push({
          type: 'parallel_agents',
          key: `par-${grouped[0].id}`,
          agents: grouped.map((m) => (m as { tools: ACPToolCall[] }).tools[0]),
          timestamp: grouped[0].timestamp,
        });
        i = j;
        continue;
      }
    }

    if (isAgentOnlyToolGroup(messages[i])) {
      const start = i;
      while (i < messages.length && isAgentOnlyToolGroup(messages[i])) i++;
      if (i - start >= 2) {
        const grouped = messages.slice(start, i);
        items.push({
          type: 'parallel_agents',
          key: `par-${grouped[0].id}`,
          agents: grouped.map((m) => (m as { tools: ACPToolCall[] }).tools[0]),
          timestamp: grouped[0].timestamp,
        });
      } else {
        items.push({
          type: 'message',
          key: messages[start].id,
          message: messages[start],
        });
      }
    } else {
      items.push({
        type: 'message',
        key: messages[i].id,
        message: messages[i],
      });
      i++;
    }
  }
  return items;
}

export function getDisplayItemVirtualKey(item: DisplayItem): string {
  return item.type === 'parallel_agents'
    ? `group:${item.key}`
    : `msg:${item.key}`;
}

export interface ApplyTurnCollapseOptions {
  /**
   * Per-turn user override keyed by the turn's user-message id:
   * `true` = forced expanded, `false` = forced collapsed. Turns absent from the
   * map follow the default (completed turns collapse).
   */
  overrides: ReadonlyMap<string, boolean>;
  /**
   * True while the agent is still answering. The final turn then stays expanded
   * and un-collapsible so live output is never hidden.
   */
  isResponding: boolean;
  /**
   * Tool-call id of a pending approval, if any. The turn containing it is
   * force-expanded so the inline approve/reject UI is never folded away (mirrors
   * compact mode's `isForceExpandGroup`).
   */
  pendingApprovalCallId?: string | null;
  /** Master switch; when false the items pass through untouched. */
  enabled: boolean;
  /**
   * Maps a drawered row to its step-kind keys (`thinking` / `tool` / `agent` /
   * `plan`; a multi-tool group yields one key per tool) so the reducer can tally
   * per-kind counts for the summary bar. Returns null for rows that aren't a
   * counted step (key rows, handled by `noteCount`).
   */
  stepKinds?: (item: DisplayItem) => string[] | null;
  /**
   * A turn that just auto-collapsed and is briefly animating its process drawer
   * out. Its drawer rows are still emitted (tagged `collapsing`) for one
   * fade-out beat, instead of vanishing the instant it folds.
   */
  collapsingTurnId?: string | null;
}

function isAssistantAnswer(item: DisplayItem): boolean {
  return (
    item.type === 'message' &&
    item.message.role === 'assistant' &&
    // `content` is typed `string`, but daemon SSE text can be undefined at
    // runtime (transcriptToMessages copies `textBlock.text` through). Guard it:
    // `applyTurnCollapse` runs in render, so a bare `.trim()` would blank the
    // whole transcript.
    !!item.message.content &&
    item.message.content.trim().length > 0
  );
}

/**
 * Whether a row is a routine "step" (tool activity, plans, mid-turn assistant
 * text) as opposed to a key row (system/shell/insight: errors, cancellations,
 * command output) or the final answer. In the drawer model every non-answer row
 * folds away regardless; this only distinguishes routine steps from key rows so
 * the latter can be tallied into the summary's note badge (`noteCount`).
 */
function isHideableStep(item: DisplayItem, isFinalAnswer: boolean): boolean {
  if (item.type === 'parallel_agents') return true;
  switch (item.message.role) {
    case 'tool_group':
    case 'plan':
      return true;
    case 'assistant':
      return !isFinalAnswer;
    case 'user':
    case 'system':
    case 'user_shell':
    case 'btw':
    case 'insight_progress':
    case 'insight_ready':
    case 'insight_error':
      return false;
    default: {
      // Compile-time exhaustiveness: a newly added DaemonMessage role fails to
      // assign to `never` here. At runtime (e.g. a newer daemon sending an
      // unknown role) it falls through as not-hideable — kept visible rather
      // than crashing the transcript or vanishing from a collapsed turn.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _exhaustive: never = item.message;
      return false;
    }
  }
}

/** Wall-clock stamp of a display row, whichever variant carries it. */
function itemTimestamp(item: DisplayItem): number | undefined {
  return item.type === 'message' ? item.message.timestamp : item.timestamp;
}

/**
 * Per-turn token usage contribution of a row. The SDK reducer folds each round's
 * usage — including the sub-agent rounds a turn spawns — onto the turn's
 * top-level assistant blocks, so summing the turn's assistant messages yields
 * its true total cost.
 */
function itemAssistantUsage(
  item: DisplayItem,
):
  | { inputTokens: number; outputTokens: number; cachedTokens?: number }
  | undefined {
  return item.type === 'message' && item.message.role === 'assistant'
    ? item.message.usage
    : undefined;
}

/**
 * Walk backwards from `index` to the user-message row that heads its turn and
 * return that turn's id, or null when `index` precedes the first turn.
 */
export function findTurnIdForIndex(
  items: readonly DisplayItem[],
  index: number,
): string | null {
  for (let i = Math.min(index, items.length - 1); i >= 0; i--) {
    const item = items[i];
    if (item.type === 'message' && item.message.role === 'user') {
      return item.message.id;
    }
  }
  return null;
}

/**
 * Fold each completed turn down to its prompt and final answer, hiding the
 * intermediate steps (thinking, tool calls, mid-turn assistant text) behind a
 * toggle attached to the prompt row. A turn spans one user message up to the
 * next; its "final answer" is the last assistant row carrying visible content.
 * The leading user row of every collapsible turn is tagged with a
 * `TurnCollapseHead`; when collapsed, the hidden middle rows are dropped and the
 * final answer's own thinking is stripped so only its purple-prefixed content
 * remains. Returns the original array untouched when disabled or when there is
 * nothing to collapse.
 */
/** Does any tool group / parallel-agents row in [start, end] own `callId`? */
function turnOwnsCallId(
  items: DisplayItem[],
  start: number,
  end: number,
  callId: string | null | undefined,
): boolean {
  if (!callId) return false;
  for (let i = start; i <= end; i++) {
    const item = items[i];
    if (item.type === 'parallel_agents') {
      if (item.agents.some((agent) => toolContainsCallId(agent, callId))) {
        return true;
      }
    } else if (item.message.role === 'tool_group') {
      if (item.message.tools.some((tool) => toolContainsCallId(tool, callId))) {
        return true;
      }
    }
  }
  return false;
}

export function applyTurnCollapse(
  items: DisplayItem[],
  {
    overrides,
    isResponding,
    pendingApprovalCallId,
    enabled,
    stepKinds,
    collapsingTurnId,
  }: ApplyTurnCollapseOptions,
): DisplayItem[] {
  if (!enabled || items.length === 0) return items;

  const userIdxs: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === 'message' && item.message.role === 'user') {
      userIdxs.push(i);
    }
  }
  if (userIdxs.length === 0) return items;

  const result: DisplayItem[] = [];
  // Anything before the first prompt (e.g. a session-restore banner) is not
  // part of any turn and passes through verbatim.
  for (let i = 0; i < userIdxs[0]; i++) result.push(items[i]);

  for (let k = 0; k < userIdxs.length; k++) {
    const start = userIdxs[k];
    const end = (k + 1 < userIdxs.length ? userIdxs[k + 1] : items.length) - 1;
    const head = items[start] as Extract<DisplayItem, { type: 'message' }>;
    const turnId = head.message.id;
    const isActiveTurn = k === userIdxs.length - 1 && isResponding;
    const hasPendingApproval = turnOwnsCallId(
      items,
      start,
      end,
      pendingApprovalCallId,
    );

    // Final answer = last assistant-with-content row in (start, end]. On an
    // active turn this is provisional (the latest streamed text), so it is not
    // counted as a step — keeping a step-less reply step-less — but it is folded
    // away with everything else when the live turn is collapsed (see below).
    let answerIdx = -1;
    for (let i = end; i > start; i--) {
      if (isAssistantAnswer(items[i])) {
        answerIdx = i;
        break;
      }
    }

    // The latest assistant answer always sits outside the drawer — including
    // while it streams — so it never starts inside the drawer (with a left rail)
    // and then jumps out when the turn completes.
    const finalOutsideIdx = answerIdx;

    let drawerCount = 0; // every row that goes into the drawer
    let noteCount = 0; // drawered key rows (errors/shell/system)
    const summary: Record<string, number> = {}; // per-kind step counts
    let lastStepTs: number | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let hasUsage = false;
    for (let i = start + 1; i <= end; i++) {
      const hideable = isHideableStep(items[i], i === answerIdx);
      if (i !== finalOutsideIdx) {
        drawerCount++;
        if (!hideable) noteCount++;
        if (stepKinds) {
          const kinds = stepKinds(items[i]);
          if (kinds) {
            for (const kind of kinds) summary[kind] = (summary[kind] ?? 0) + 1;
          }
        }
      }
      const ts = itemTimestamp(items[i]);
      if (ts !== undefined) {
        lastStepTs = lastStepTs === undefined ? ts : Math.max(lastStepTs, ts);
      }
      const usage = itemAssistantUsage(items[i]);
      if (usage) {
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
        cachedTokens += usage.cachedTokens ?? 0;
        hasUsage = true;
      }
    }

    const promptTs = head.message.timestamp;
    const elapsedMs =
      promptTs !== undefined &&
      lastStepTs !== undefined &&
      lastStepTs >= promptTs
        ? lastStepTs - promptTs
        : undefined;
    const hasMetrics = hasUsage || elapsedMs !== undefined;

    if (hasPendingApproval || (drawerCount === 0 && !hasMetrics)) {
      // Nothing to add: the inline approve/reject UI must stay reachable, or the
      // turn has neither foldable steps nor a measured metric. Emit it untouched.
      for (let i = start; i <= end; i++) result.push(items[i]);
      continue;
    }

    // A turn with foldable steps gets a chevron and defaults to expanded while
    // streaming, collapsed once complete (the whole turn stays open until the
    // response finishes — folding mid-stream churns the virtualized layout). A
    // step-less turn (e.g. a plain "hi" reply) has nothing to fold, so it stays
    // expanded and shows a chevron-less metrics line. A turn that drawered any
    // key row (an error, cancellation, or shell/system output — `noteCount`)
    // also defaults to expanded so that out-of-band output is never hidden
    // behind the fold; the user can still collapse it by hand. An explicit user
    // toggle always wins.
    const expanded =
      drawerCount === 0
        ? true
        : overrides.has(turnId)
          ? (overrides.get(turnId) as boolean)
          : isActiveTurn || noteCount > 0;
    const collapsed = !expanded;

    result.push({
      type: 'message',
      key: head.key,
      message: head.message,
      collapse: {
        turnId,
        collapsed,
        hiddenCount: drawerCount,
        ...(noteCount > 0 ? { noteCount } : {}),
        ...(Object.keys(summary).length > 0 ? { summary } : {}),
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
        ...(hasUsage ? { inputTokens, outputTokens } : {}),
        ...(cachedTokens > 0 ? { cachedTokens } : {}),
        ...(isActiveTurn && promptTs !== undefined
          ? { liveStartedAt: promptTs }
          : {}),
      },
    });

    // The final answer sits outside the fold. While collapsed its own thinking is
    // stripped so only the conclusion shows; expanded it keeps its thinking (the
    // process is on display anyway).
    const stripThinking = (item: DisplayItem): DisplayItem => {
      if (
        item.type === 'message' &&
        item.message.role === 'assistant' &&
        item.message.thinking
      ) {
        return {
          type: 'message',
          key: item.key,
          message: { ...item.message, thinking: undefined },
        };
      }
      return item;
    };

    // Process drawer: nothing leaks out. Collapsed shows only the final answer;
    // expanded tags every other row so it renders inside the drawer. A turn mid
    // auto-collapse keeps emitting its drawer rows (tagged `collapsing`) for one
    // fade-out beat before they're dropped.
    const animatingCollapse = collapsed && turnId === collapsingTurnId;
    if (collapsed && !animatingCollapse) {
      if (finalOutsideIdx >= 0)
        result.push(stripThinking(items[finalOutsideIdx]));
    } else {
      for (let i = start + 1; i <= end; i++) {
        if (i === finalOutsideIdx) {
          result.push(collapsed ? stripThinking(items[i]) : items[i]);
        } else {
          result.push({
            ...items[i],
            drawer: true,
            ...(animatingCollapse ? { collapsing: true } : {}),
          });
        }
      }
    }
  }

  return result;
}

/**
 * Locate a display item by message id, falling back to the tool call id for
 * tool groups that were merged (compact mode) or grouped (parallel agents)
 * under another message's id.
 */
export function findDisplayItemIndex(
  items: readonly DisplayItem[],
  messageId: string,
  callId?: string,
): number {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === 'message') {
      if (item.message.id === messageId) return i;
      if (
        callId &&
        item.message.role === 'tool_group' &&
        item.message.tools.some((tool) => toolContainsCallId(tool, callId))
      ) {
        return i;
      }
    } else if (
      callId &&
      item.agents.some((agent) => toolContainsCallId(agent, callId))
    ) {
      return i;
    }
  }
  return -1;
}

export interface MessageListHandle {
  /**
   * Scroll the transcript so the given message is visible and briefly
   * highlight it. Returns false when the message is not in the list.
   */
  scrollToMessage: (messageId: string, callId?: string) => boolean;
}

const HEADER_INDEX = 0;
const ESTIMATE_HEADER = 120;
const ESTIMATE_MESSAGE = 80;
const ESTIMATE_APPROVAL = 200;
const ESTIMATE_TAIL = 240;
export const VIRTUAL_SCROLL_THRESHOLD = 200;

// Mac laptops lack a dedicated End key (it's Fn+→), and ⌘↓ is the native
// "jump to end" gesture — so the jump-to-bottom shortcut and its hint adapt.
const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

export function shouldUseVirtualScroll(
  totalCount: number,
  threshold = VIRTUAL_SCROLL_THRESHOLD,
): boolean {
  return totalCount > threshold;
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(
  function MessageList(
    {
      messages,
      pendingApproval,
      onConfirm,
      onShowContextDetail,
      catchingUp,
      isResponding = false,
      welcomeHeader,
      workspaceCwd,
      tailContent,
      tailKey = 'tail',
      virtualScrollThreshold = VIRTUAL_SCROLL_THRESHOLD,
      shellOutputMaxLines,
      autoScrollTailIntoView = false,
      showRetryHint = false,
      onRetryClick,
    },
    ref,
  ) {
    const compactMode = useContext(CompactModeContext);
    const mergedMessages = useMemo(
      () =>
        compactMode
          ? mergeCompactToolGroups(messages, pendingApproval)
          : messages,
      [compactMode, messages, pendingApproval],
    );
    const displayItems = useMemo(
      () => groupParallelAgents(mergedMessages),
      [mergedMessages],
    );

    // ── Per-turn collapse ────────────────────────────────────────────────
    // Completed turns fold down to their prompt + final answer (toggle on the
    // prompt row). `collapseOverrides` records explicit user toggles keyed by
    // the turn's user-message id; turns absent from it follow the default
    // (collapsed once complete). `displayItems` stays the full, pre-collapse
    // list — used only to locate rows hidden inside a collapsed turn — while
    // `visibleItems` is what actually renders.
    const { collapseCompletedTurns } = useWebShellCustomization();
    const collapseEnabled = collapseCompletedTurns ?? true;
    const [collapseOverrides, setCollapseOverrides] = useState<
      ReadonlyMap<string, boolean>
    >(() => new Map());
    const handleToggleCollapse = useCallback((turnId: string) => {
      // (Un)folding a turn is the user reading history, not following the tail.
      // Pause follow so the height change does not yank the viewport to the
      // bottom — the toggled prompt row stays where it is on screen.
      shouldFollow.current = false;
      setCollapseOverrides((prev) => {
        const currentlyExpanded = prev.get(turnId) ?? false;
        const next = new Map(prev);
        next.set(turnId, !currentlyExpanded);
        return next;
      });
    }, []);
    const { t } = useI18n();
    // Classifies a drawered row into step-kind keys for the process summary
    // counts. A multi-tool group yields one key per tool; sub-agent tools and
    // parallel-agent groups count as 'agent'. Key rows (errors/shell/system)
    // return null — they're surfaced by the separate note badge.
    const stepKinds = useCallback((item: DisplayItem): string[] | null => {
      if (item.type === 'parallel_agents') {
        return item.agents.map(() => 'agent');
      }
      const m = item.message;
      if (m.role === 'tool_group') {
        return m.tools.map((tool) =>
          isSubAgentToolCall(tool) ? 'agent' : 'tool',
        );
      }
      if (m.role === 'plan') return ['plan'];
      if (m.role === 'assistant') return ['thinking'];
      return null;
    }, []);
    // The turn whose process drawer is mid auto-collapse fade-out.
    const [collapsingTurnId, setCollapsingTurnId] = useState<string | null>(
      null,
    );
    const visibleItems = useMemo(
      () =>
        applyTurnCollapse(displayItems, {
          overrides: collapseOverrides,
          isResponding,
          pendingApprovalCallId: pendingApproval?.toolCallId ?? null,
          enabled: collapseEnabled,
          stepKinds,
          collapsingTurnId,
        }),
      [
        displayItems,
        collapseOverrides,
        isResponding,
        pendingApproval?.toolCallId,
        collapseEnabled,
        stepKinds,
        collapsingTurnId,
      ],
    );

    const containerRef = useRef<HTMLDivElement>(null);

    // When a turn finishes responding, play a brief drawer fade-out before the
    // fold drops the rows: mark it collapsing, then clear so the reducer stops
    // emitting its drawer rows. useLayoutEffect so the marker is set before
    // paint — the drawer never blinks out for a frame first.
    const prevRespondingRef = useRef(isResponding);
    useLayoutEffect(() => {
      const was = prevRespondingRef.current;
      prevRespondingRef.current = isResponding;
      if (!was || isResponding) return;
      let lastTurnId: string | undefined;
      for (const item of displayItems) {
        if (item.type === 'message' && item.message.role === 'user') {
          lastTurnId = item.message.id;
        }
      }
      if (!lastTurnId) return;
      setCollapsingTurnId(lastTurnId);
      const timer = setTimeout(() => setCollapsingTurnId(null), 200);
      return () => clearTimeout(timer);
    }, [isResponding, displayItems]);

    // ── Scroll-follow state ──────────────────────────────────────────────
    //
    // The scroll behavior follows 6 rules:
    //
    //   1. Default follow-bottom — while the user is looking at the bottom,
    //      new content (streaming tokens, tool cards expanding, approval
    //      cards appearing, any height change) keeps the viewport pinned
    //      to the latest output.
    //
    //   2. Scroll-up pauses follow — if the user scrolls up, the page
    //      assumes they want to read history and stops auto-scrolling.
    //      Even if the model is still streaming, the viewport stays put.
    //
    //   3. Scroll-back-to-bottom resumes — when the user scrolls back
    //      near the bottom (< 30px from edge), follow mode re-engages
    //      and new content resumes sticking.
    //
    //   4. New message resets follow — after the user sends a message,
    //      follow mode is forced on so the model's reply scrolls in
    //      naturally.
    //
    //   5. Session restore / reconnect — during history replay
    //      (`catchingUp === true`), all auto-scrolling is suppressed to
    //      avoid fighting the rapidly replaying transcript. Once replay
    //      finishes (`catchingUp` flips to falsy), a single scroll-to-
    //      bottom fires so the user lands at the latest content.
    //
    //   6. Short content — if the content doesn't overflow the container
    //      (no scrollbar), scrollToBottom is a no-op. This avoids a
    //      visual flash when the model just started replying with a
    //      short first chunk.
    //
    // Implementation: three refs, three effects, one scroll handler.
    //
    //   - `shouldFollow`      — whether auto-scroll is active
    //   - `lastScrollTop`     — previous scrollTop for direction detection
    //   - `prevLastUserMsgId` — tracks when a new user message appears
    //   - `prevCatchingUp`    — tracks the catchingUp → ready transition
    //
    // The single auto-scroll driver is a `useLayoutEffect` on
    // `totalVirtualSize` (the virtualizer's computed content height).
    // Every height change — streaming text, card expand, approval
    // appearance — flows through this one effect.
    // ─────────────────────────────────────────────────────────────────────

    const shouldFollow = useRef(true);
    const lastScrollTop = useRef(0);
    const scrollCooldown = useRef(false);
    const scrollCooldownCount = useRef(0);
    const prevLastUserMsgId = useRef<string | null>(null);
    const prevCatchingUp: MutableRefObject<boolean | undefined> =
      useRef(catchingUp);
    const catchingUpRef = useRef(catchingUp);
    const prevHasTailContent = useRef(false);
    catchingUpRef.current = catchingUp;

    // "Jump to bottom" pill: shown when the user has scrolled away from the
    // tail. While away, new messages are tallied (`unseenCount`) so the pill can
    // read "N new messages" and the reader knows there's fresh output below.
    const [showJumpButton, setShowJumpButton] = useState(false);
    const [unseenCount, setUnseenCount] = useState(0);
    // Id of the last row the reader had caught up to (baseline for the tally),
    // plus a live handle to the messages array for the scroll/click callbacks.
    const lastSeenIdRef = useRef<string | null>(null);
    const messagesRef = useRef(messages);
    messagesRef.current = messages;

    const hasTailApproval = useMemo(() => {
      if (!pendingApproval) return false;
      if (isAskUserQuestion(pendingApproval)) return true;
      return !approvalMatchesToolGroup(messages, pendingApproval);
    }, [pendingApproval, messages]);

    const hasTailContent = tailContent !== undefined && tailContent !== null;
    const hasHeader = !!welcomeHeader;
    const headerOffset = hasHeader ? 1 : 0;
    const tailApprovalIndex = headerOffset + visibleItems.length;
    const tailContentIndex = tailApprovalIndex + (hasTailApproval ? 1 : 0);
    const totalCount = tailContentIndex + (hasTailContent ? 1 : 0);
    const useVirtualScroll = shouldUseVirtualScroll(
      totalCount,
      virtualScrollThreshold,
    );

    const getItemKey = useCallback(
      (index: number) => {
        if (hasHeader && index === HEADER_INDEX) return 'slot:header';
        if (hasTailApproval && index === tailApprovalIndex) {
          return pendingApproval
            ? `slot:approval:${pendingApproval.id}`
            : 'slot:approval';
        }
        if (hasTailContent && index === tailContentIndex) {
          return `slot:tail:${tailKey}`;
        }
        const item = visibleItems[index - headerOffset];
        return item ? getDisplayItemVirtualKey(item) : `slot:row:${index}`;
      },
      [
        hasHeader,
        hasTailApproval,
        tailApprovalIndex,
        pendingApproval,
        hasTailContent,
        tailContentIndex,
        tailKey,
        visibleItems,
        headerOffset,
      ],
    );

    // Rule 6: skip if content doesn't overflow (no scrollbar).
    const scrollToBottom = useCallback(() => {
      const el = containerRef.current;
      if (!el) return;
      if (el.scrollHeight <= el.clientHeight) return;
      scrollCooldownCount.current += 1;
      const gen = scrollCooldownCount.current;
      scrollCooldown.current = true;
      el.scrollTop = el.scrollHeight;
      lastScrollTop.current = el.scrollTop;
      requestAnimationFrame(() => {
        if (scrollCooldownCount.current === gen) {
          scrollCooldown.current = false;
        }
      });
    }, []);

    // Re-engage follow, clear the unseen tally, and snap to the tail. Used by
    // the jump-to-bottom pill and the Ctrl+End shortcut.
    const handleJumpToBottom = useCallback(() => {
      shouldFollow.current = true;
      const msgs = messagesRef.current;
      lastSeenIdRef.current = msgs.length ? msgs[msgs.length - 1].id : null;
      setUnseenCount(0);
      setShowJumpButton(false);
      scrollToBottom();
    }, [scrollToBottom]);

    const virtualizer = useVirtualizer({
      count: totalCount,
      enabled: useVirtualScroll,
      getScrollElement: () => containerRef.current,
      getItemKey,
      estimateSize: (index) => {
        if (hasHeader && index === HEADER_INDEX) return ESTIMATE_HEADER;
        if (hasTailApproval && index === tailApprovalIndex) {
          return ESTIMATE_APPROVAL;
        }
        if (hasTailContent && index === tailContentIndex) return ESTIMATE_TAIL;
        return ESTIMATE_MESSAGE;
      },
      overscan: 20,
      useFlushSync: false,
      useAnimationFrameWithResizeObserver: true,
    });

    // Sticky prompt: the current turn's user message pinned at the top of the
    // viewport once its real row has scrolled off, as a context anchor. Rendered
    // as an overlay OUTSIDE the scroll flow (not a sticky child) so it never
    // shifts the virtualizer's measured offsets.
    const stickyRef = useRef<HTMLDivElement>(null);
    const [stickyTurn, setStickyTurn] = useState<{
      turnId: string;
      text: string;
      index: number;
      collapse?: TurnCollapseHead;
    } | null>(null);
    // Push-out offset (px): as the NEXT turn's prompt nears the top, the pinned
    // bar slides up by this much so two prompts never stack — the incoming
    // prompt shoves the old anchor off, iOS section-header style.
    const [stickyPush, setStickyPush] = useState(0);
    const refreshSticky = useCallback(() => {
      const el = containerRef.current;
      if (!el) {
        setStickyTurn(null);
        setStickyPush(0);
        return;
      }
      const scrollTop = el.scrollTop;
      let active: {
        turnId: string;
        text: string;
        index: number;
        start: number;
        collapse?: TurnCollapseHead;
      } | null = null;
      let nextStart: number | undefined;
      for (let i = 0; i < visibleItems.length; i++) {
        const item = visibleItems[i];
        if (item.type !== 'message' || item.message.role !== 'user') continue;
        const content = item.message.content;
        const text = typeof content === 'string' ? content : '';
        if (!text) continue;
        const fullIndex = headerOffset + i;
        let start: number | undefined;
        if (useVirtualScroll) {
          start = virtualizer.measurementsCache?.[fullIndex]?.start;
        } else {
          const row = el.querySelector(`[data-index="${fullIndex}"]`);
          start = row instanceof HTMLElement ? row.offsetTop : undefined;
        }
        if (start == null) continue;
        // Anchors are in document order; the last one at/above the top is the
        // active turn, and the first one below the top is the incoming one.
        if (start <= scrollTop + 1) {
          active = {
            turnId: item.message.id,
            text,
            index: fullIndex,
            start,
            collapse: item.collapse,
          };
        } else {
          nextStart = start;
          break;
        }
      }
      // Only surface once the real prompt row has scrolled (mostly) off the top.
      const next =
        active && scrollTop - active.start > 8
          ? {
              turnId: active.turnId,
              text: active.text,
              index: active.index,
              collapse: active.collapse,
            }
          : null;
      // Push-out: when the incoming prompt is within one bar-height of the top,
      // shove the pinned bar up by the overlap so they never coexist.
      const barHeight = stickyRef.current?.offsetHeight || 52;
      const push =
        next && nextStart !== undefined
          ? Math.max(0, barHeight - (nextStart - scrollTop))
          : 0;
      setStickyPush((prev) => (prev === push ? prev : push));
      setStickyTurn((prev) =>
        prev?.turnId === next?.turnId &&
        prev?.index === next?.index &&
        prev?.collapse === next?.collapse
          ? prev
          : next,
      );
    }, [visibleItems, headerOffset, useVirtualScroll, virtualizer]);

    // handleScroll keeps stable `[]` deps; reach the latest refreshSticky via ref.
    const refreshStickyRef = useRef(refreshSticky);
    refreshStickyRef.current = refreshSticky;

    const handleStickyClick = useCallback(() => {
      const target = stickyTurn;
      if (!target) return;
      if (useVirtualScroll) {
        virtualizer.scrollToIndex(target.index, { align: 'start' });
      } else {
        containerRef.current
          ?.querySelector(`[data-index="${target.index}"]`)
          ?.scrollIntoView({ block: 'start' });
      }
    }, [stickyTurn, useVirtualScroll, virtualizer]);

    // The pinned process bar mirrors the inline one: clicking its label both
    // jumps to the turn and force-expands its drawer, so the steps are open when
    // you arrive. Clicking elsewhere on the bar only jumps (handleStickyClick).
    const handleStickyExpand = useCallback(() => {
      const target = stickyTurn;
      if (!target) return;
      // Reading history, not following the tail (mirror handleToggleCollapse).
      shouldFollow.current = false;
      setCollapseOverrides((prev) => {
        if (prev.get(target.turnId) === true) return prev;
        const next = new Map(prev);
        next.set(target.turnId, true);
        return next;
      });
      handleStickyClick();
    }, [stickyTurn, handleStickyClick]);

    // Imperative scroll-to-message (e.g. the floating TodoPanel's "show in
    // transcript" button) with a brief highlight on the target row.
    const [flashKey, setFlashKey] = useState<string | null>(null);
    useEffect(() => {
      if (!flashKey) return;
      const timer = setTimeout(() => setFlashKey(null), 1600);
      return () => clearTimeout(timer);
    }, [flashKey]);

    // Scroll a visible row to center and flash it.
    const performScrollToRow = useCallback(
      (rowIndex: number) => {
        // Explicit navigation away from the tail — pause follow so the
        // auto-scroll driver doesn't yank the viewport straight back down,
        // and engage the same cooldown scrollToBottom uses so the scroll
        // events this triggers short-circuit handleScroll. Without it, Rule 3
        // (near-bottom → resume follow) would re-enable follow whenever the
        // target sits near the bottom, and the next streaming height change
        // would pull the viewport back to the tail. An instant (non-smooth)
        // scroll keeps that cooldown window short and deterministic.
        shouldFollow.current = false;
        scrollCooldownCount.current += 1;
        const gen = scrollCooldownCount.current;
        scrollCooldown.current = true;
        if (useVirtualScroll) {
          virtualizer.scrollToIndex(rowIndex, { align: 'center' });
        } else {
          containerRef.current
            ?.querySelector(`[data-index="${rowIndex}"]`)
            ?.scrollIntoView({ block: 'center' });
        }
        // Release once the scroll has settled (the virtualizer may re-scroll
        // a frame or two later after measuring the target row).
        setTimeout(() => {
          if (scrollCooldownCount.current === gen) {
            scrollCooldown.current = false;
          }
        }, 150);
        const key = getItemKey(rowIndex);
        setFlashKey(null);
        requestAnimationFrame(() => setFlashKey(key));
      },
      [useVirtualScroll, virtualizer, getItemKey],
    );

    // A scroll target that currently sits inside a collapsed turn: expand the
    // turn, then finish the scroll once its rows materialize in `visibleItems`.
    const pendingScrollRef = useRef<{
      messageId: string;
      callId?: string;
    } | null>(null);

    const scrollToMessage = useCallback(
      (messageId: string, callId?: string): boolean => {
        const visibleIndex = findDisplayItemIndex(
          visibleItems,
          messageId,
          callId,
        );
        if (visibleIndex >= 0) {
          pendingScrollRef.current = null;
          performScrollToRow(visibleIndex + headerOffset);
          return true;
        }
        // Not on screen — it may be folded inside a collapsed turn. Locate it
        // in the full list, expand that turn, and defer the scroll.
        const fullIndex = findDisplayItemIndex(displayItems, messageId, callId);
        if (fullIndex < 0) return false;
        const turnId = findTurnIdForIndex(displayItems, fullIndex);
        if (!turnId) return false;
        pendingScrollRef.current = { messageId, callId };
        setCollapseOverrides((prev) => {
          if (prev.get(turnId) === true) return prev;
          const next = new Map(prev);
          next.set(turnId, true);
          return next;
        });
        return true;
      },
      [visibleItems, displayItems, headerOffset, performScrollToRow],
    );

    useImperativeHandle(ref, () => ({ scrollToMessage }), [scrollToMessage]);

    // Flush a deferred scroll once the expanded turn's rows are visible.
    useEffect(() => {
      const pending = pendingScrollRef.current;
      if (!pending) return;
      const idx = findDisplayItemIndex(
        visibleItems,
        pending.messageId,
        pending.callId,
      );
      if (idx < 0) return;
      pendingScrollRef.current = null;
      performScrollToRow(idx + headerOffset);
    }, [visibleItems, headerOffset, performScrollToRow]);

    // Rules 2 & 3: detect scroll direction to toggle follow mode.
    // Runs synchronously in the scroll handler — no rAF needed since
    // the browser already coalesces scroll events.
    const handleScroll = useCallback(() => {
      const el = containerRef.current;
      if (!el) return;
      if (scrollCooldown.current) {
        lastScrollTop.current = el.scrollTop;
        return;
      }
      const prev = lastScrollTop.current;
      const curr = el.scrollTop;
      lastScrollTop.current = curr;
      const distanceFromBottom = el.scrollHeight - curr - el.clientHeight;

      // Rule 2: scrolling up → pause follow
      if (curr < prev - 1) {
        shouldFollow.current = false;
      }
      // Rule 3: near bottom → resume follow
      // (runs unconditionally so that container-resize-induced scrollTop
      // clamping — which looks like scrolling up — doesn't permanently
      // disable follow when the viewport is still near the bottom)
      if (distanceFromBottom < 30) {
        shouldFollow.current = true;
      }
      // Jump-to-bottom pill: visible once meaningfully scrolled up. Arriving
      // near the tail clears the unseen tally and advances the baseline so the
      // next scroll-away counts only genuinely new output.
      const nearBottom = distanceFromBottom < 40;
      setShowJumpButton((prev) => (prev === !nearBottom ? prev : !nearBottom));
      if (nearBottom) {
        const msgs = messagesRef.current;
        lastSeenIdRef.current = msgs.length ? msgs[msgs.length - 1].id : null;
        setUnseenCount((c) => (c === 0 ? c : 0));
      }
      refreshStickyRef.current();
    }, []);

    // Clear screen (e.g. /clear) → reset to follow mode, drop stale per-turn
    // collapse overrides, and disarm any deferred scroll so it can't fire
    // against the next session.
    useEffect(() => {
      if (messages.length === 0) {
        shouldFollow.current = true;
        pendingScrollRef.current = null;
        setCollapseOverrides((prev) => (prev.size ? new Map() : prev));
        lastSeenIdRef.current = null;
        setUnseenCount(0);
        setShowJumpButton(false);
      }
    }, [messages.length]);

    // Tally messages that arrive while the reader is away from the tail.
    //
    // The baseline (`lastSeenIdRef`) advances only while caught up at the bottom
    // AND idle. The active reply doesn't tally until it settles (see
    // countUnseenMessages), so the "+1" appears when the reply finishes rather
    // than the moment it starts streaming. Derived, not accumulated, so it can't
    // drift when the transcript array is rebuilt.
    useEffect(() => {
      if (shouldFollow.current && !isResponding) {
        lastSeenIdRef.current = messages.length
          ? messages[messages.length - 1].id
          : null;
      }
      const n = shouldFollow.current
        ? 0
        : countUnseenMessages(messages, lastSeenIdRef.current, isResponding);
      setUnseenCount((prev) => (prev === n ? prev : n));
    }, [messages, isResponding]);

    // Jump-to-bottom shortcut, matching the pill's hint: ⌘↓ on Mac (no End key
    // on laptops), Ctrl/Cmd+End elsewhere. Skipped while typing in a field so it
    // never steals the editor's own cursor-to-end navigation.
    useEffect(() => {
      const onKeyDown = (e: KeyboardEvent) => {
        const el = e.target as HTMLElement | null;
        if (
          el &&
          (el.isContentEditable ||
            el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.tagName === 'SELECT')
        ) {
          return;
        }
        const isEnd = e.key === 'End' && (e.ctrlKey || e.metaKey);
        const isCmdDown = IS_MAC && e.metaKey && e.key === 'ArrowDown';
        if (isEnd || isCmdDown) {
          e.preventDefault();
          handleJumpToBottom();
        }
      };
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, [handleJumpToBottom]);

    // Container-resize guard: when floating panels (e.g. TodoPanel)
    // appear or disappear the scroll container's clientHeight changes.
    // Snap back to bottom so the user doesn't lose their place while
    // follow mode is active.
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const observer = new ResizeObserver(() => {
        if (catchingUpRef.current) return;
        if (!shouldFollow.current) return;
        requestAnimationFrame(() => {
          if (!catchingUpRef.current && shouldFollow.current) {
            scrollToBottom();
          }
        });
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, [scrollToBottom]);

    // Rule 4: new user message → force follow on so the model's reply
    // scrolls into view as it streams in.
    useEffect(() => {
      const lastId = getLastUserMessageId(messages);
      if (catchingUp) {
        prevLastUserMsgId.current = lastId;
        return;
      }
      if (lastId && lastId !== prevLastUserMsgId.current) {
        shouldFollow.current = true;
        // A new prompt supersedes any pending "Show in transcript" scroll.
        pendingScrollRef.current = null;
        requestAnimationFrame(scrollToBottom);
        // Anchor the unseen baseline at the user's own prompt: scrolling away
        // while it answers then counts only the reply ("1 new message"), not the
        // prompt the user just typed.
        lastSeenIdRef.current = lastId;
      }
      prevLastUserMsgId.current = lastId;
    }, [messages, catchingUp, scrollToBottom]);

    // Rule 5: session restore — when catchingUp flips from true → falsy,
    // replay just finished. Scroll to bottom once so the user sees the
    // latest content without the viewport fighting the replay.
    useEffect(() => {
      if (prevCatchingUp.current && !catchingUp) {
        shouldFollow.current = true;
        requestAnimationFrame(scrollToBottom);
      }
      prevCatchingUp.current = catchingUp;
    }, [catchingUp, scrollToBottom]);

    // Rule 6: an inline picker/dialog (tailContent) just appeared. It renders
    // at the very bottom of the virtualized list, so if the user had scrolled
    // up it would open below the fold and the action would look like a no-op.
    // Only opt-in callers (autoScrollTailIntoView) force-follow it into view, so
    // unrelated tail panels keep the reader's scroll position.
    useEffect(() => {
      if (
        autoScrollTailIntoView &&
        hasTailContent &&
        !prevHasTailContent.current
      ) {
        shouldFollow.current = true;
        // Re-check follow inside the frame: if the user scrolls up in the gap
        // before it fires (Rule 2 clears the flag), don't fight them.
        requestAnimationFrame(() => {
          if (shouldFollow.current) scrollToBottom();
        });
      }
      prevHasTailContent.current = hasTailContent;
    }, [autoScrollTailIntoView, hasTailContent, scrollToBottom]);

    const renderVirtualItem = useCallback(
      (index: number) => {
        if (hasHeader && index === HEADER_INDEX) {
          return welcomeHeader;
        }

        if (hasTailApproval && index === tailApprovalIndex) {
          if (pendingApproval && isAskUserQuestion(pendingApproval)) {
            return (
              <AskUserQuestion
                request={pendingApproval}
                onConfirm={onConfirm}
              />
            );
          }
          if (pendingApproval) {
            return (
              <ToolApproval request={pendingApproval} onConfirm={onConfirm} />
            );
          }
          return null;
        }

        if (hasTailContent && index === tailContentIndex) {
          return tailContent;
        }

        const itemIndex = index - headerOffset;
        const item = visibleItems[itemIndex];
        if (!item) return null;

        // Process drawer: wrap an expanded turn's intermediate rows in a
        // left-railed container so they read as one bounded "process" block.
        const inDrawer = item.drawer === true;
        const withDrawer = (node: ReactNode) =>
          inDrawer ? (
            <div
              className={`${styles.drawerRow}${
                item.collapsing ? ` ${styles.drawerRowCollapsing}` : ''
              }`}
            >
              {node}
            </div>
          ) : (
            node
          );

        if (item.type === 'parallel_agents') {
          return withDrawer(
            <MessageTimestamp timestamp={item.timestamp}>
              <ParallelAgentsGroup
                agents={item.agents}
                pendingApproval={pendingApproval}
                onConfirm={onConfirm}
              />
            </MessageTimestamp>,
          );
        }

        return withDrawer(
          <MessageItem
            message={item.message}
            pendingApproval={pendingApproval}
            onConfirm={onConfirm}
            onShowContextDetail={onShowContextDetail}
            workspaceCwd={workspaceCwd}
            isLatest={itemIndex === visibleItems.length - 1}
            showRetryHint={showRetryHint}
            onRetryClick={onRetryClick}
            shellOutputMaxLines={shellOutputMaxLines}
            collapse={item.collapse}
            onToggleCollapse={handleToggleCollapse}
          />,
        );
      },
      [
        hasHeader,
        welcomeHeader,
        hasTailContent,
        tailContent,
        tailContentIndex,
        hasTailApproval,
        tailApprovalIndex,
        pendingApproval,
        onConfirm,
        onShowContextDetail,
        headerOffset,
        visibleItems,
        workspaceCwd,
        showRetryHint,
        onRetryClick,
        shellOutputMaxLines,
        handleToggleCollapse,
      ],
    );

    const virtualItems = virtualizer.getVirtualItems();
    const totalVirtualSize = virtualizer.getTotalSize();

    // ── Single auto-scroll driver (rules 1, 5, 6) ──────────────────────
    // Fires whenever the virtualizer's total content height changes —
    // this captures every scenario: streaming tokens appending, tool
    // cards expanding/collapsing, approval cards appearing, etc.
    //
    // Rule 5: during replay (catchingUp) → skip, avoid fighting rapid
    //         transcript replay. The catchingUp→ready transition effect
    //         above handles the final scroll.
    // Rule 1: when shouldFollow is true → scroll to bottom.
    // Rule 6: scrollToBottom itself checks scrollHeight <= clientHeight
    //         and is a no-op when there's no overflow.
    useLayoutEffect(() => {
      if (catchingUp) return;
      if (shouldFollow.current) {
        scrollToBottom();
      }
    }, [totalVirtualSize, messages, totalCount, catchingUp, scrollToBottom]);

    // Recompute the sticky prompt when content height, layout, or theme changes
    // (streaming, expand/collapse, theme switch) — not just on scroll.
    useEffect(() => {
      refreshSticky();
    }, [refreshSticky, totalVirtualSize]);

    return (
      <div className={styles.listWrap}>
        {stickyTurn &&
          (() => {
            const c = stickyTurn.collapse;
            const hasProcess =
              !!c &&
              (!!(c.summary && Object.keys(c.summary).length) || !!c.noteCount);
            const m = c ? metricsText(c, c.elapsedMs, t) : '';
            return (
              <div
                ref={stickyRef}
                role="button"
                tabIndex={0}
                className={styles.stickyTurn}
                style={stickyPush ? { top: `${-stickyPush}px` } : undefined}
                onClick={handleStickyClick}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleStickyClick();
                  }
                }}
                title={stickyTurn.text}
                aria-label={`${t('turn.jumpToPrompt')}: ${stickyTurn.text}`}
              >
                <span className={styles.stickyPrompt}>
                  <span className={styles.stickyChevron} aria-hidden="true">
                    ›
                  </span>
                  <span className={styles.stickyText}>{stickyTurn.text}</span>
                  {/* Process-less turn: metrics ride on the prompt line, right. */}
                  {!hasProcess && m && (
                    <span className={styles.stickyPromptMetrics}>{m}</span>
                  )}
                </span>
                {hasProcess && c && (
                  <span className={styles.stickyProcess}>
                    <button
                      type="button"
                      className={styles.stickyProcessLabel}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleStickyExpand();
                      }}
                      aria-label={`${t('turn.expand')} · ${processLabel(c, t)}`}
                    >
                      {processLabel(c, t)}
                    </button>
                    {m && (
                      <span
                        className={`${styles.stickyMetrics} ${styles.stickyMetricsRight}`}
                      >
                        {m}
                      </span>
                    )}
                  </span>
                )}
              </div>
            );
          })()}
        <div ref={containerRef} className={styles.list} onScroll={handleScroll}>
          {useVirtualScroll ? (
            <div
              style={{
                height: totalVirtualSize,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualItems.map((virtualRow) => (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className={
                    flashKey === String(virtualRow.key)
                      ? styles.rowFlash
                      : undefined
                  }
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {renderVirtualItem(virtualRow.index)}
                </div>
              ))}
            </div>
          ) : (
            Array.from({ length: totalCount }, (_, index) => {
              const key = getItemKey(index);
              return (
                <div
                  key={key}
                  data-index={index}
                  className={flashKey === key ? styles.rowFlash : undefined}
                >
                  {renderVirtualItem(index)}
                </div>
              );
            })
          )}
        </div>
        {showJumpButton && (
          <button
            type="button"
            className={styles.jumpToBottom}
            onClick={handleJumpToBottom}
          >
            <span className={styles.jumpToBottomLabel}>
              {unseenCount > 0
                ? t('scroll.newMessages', { count: unseenCount })
                : t('scroll.toBottom')}
            </span>
            <span className={styles.jumpToBottomHint} aria-hidden="true">
              {IS_MAC ? ' ⌘↓' : ' (ctrl+End)'}
            </span>
            {/* Mac's ⌘↓ already carries the down-arrow; only add a standalone
                affordance arrow on platforms whose hint has none. */}
            {!IS_MAC && <span aria-hidden="true">↓</span>}
          </button>
        )}
      </div>
    );
  },
);
