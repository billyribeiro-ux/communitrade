import styles from "./PreviewBanner.module.css";

export function PreviewBanner() {
  return <p className={styles.banner}><strong>Product preview</strong><span>All records and examples in this local preview are synthetic. Execution reports are member reported, not broker verified.</span></p>;
}
