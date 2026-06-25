import { CODICONS, type CodiconName } from './codicons';
import { Icon } from './Icon';
import styles from './IconShowcase.module.css';

const NAMES = Object.keys(CODICONS) as CodiconName[];

/**
 * Demo surface for the Codicon `Icon` component. Drop `<IconShowcase />` into
 * any view (e.g. temporarily inside WelcomeHeader) to see the icons render.
 * Not wired into the live app — it exists purely as a usage example.
 */
export function IconShowcase() {
  return (
    <section className={styles.showcase} aria-label="Codicon examples">
      <h2 className={styles.heading}>Codicons</h2>

      {/* 1. The full set — labelled so each is announced by screen readers. */}
      <ul className={styles.grid}>
        {NAMES.map((name) => (
          <li key={name} className={styles.cell}>
            <Icon name={name} label={name} size="1.25rem" />
            <code className={styles.name}>{name}</code>
          </li>
        ))}
      </ul>

      {/* 2. Inline with text: icons scale with font-size and inherit color. */}
      <p className={styles.inline}>
        <Icon name="git-branch" /> main
        <span className={styles.dim}> · </span>
        <Icon name="terminal" /> web-shell
      </p>

      {/* 3. Semantic color via currentColor — set color on the parent. */}
      <ul className={styles.statusList}>
        <li className={styles.ok}>
          <Icon name="check" label="Success" /> Build passed
        </li>
        <li className={styles.warn}>
          <Icon name="warning" label="Warning" /> Deprecated API in use
        </li>
        <li className={styles.bad}>
          <Icon name="error" label="Error" /> 2 type errors
        </li>
        <li className={styles.info}>
          <Icon name="info" label="Info" /> 3 files changed
        </li>
      </ul>

      {/* 4. Animated spinner for in-flight work. */}
      <p className={styles.running}>
        <Icon name="loading" label="Loading" spin /> Running command…
      </p>
    </section>
  );
}
