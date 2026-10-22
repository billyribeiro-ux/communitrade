import Link from 'next/link';
import styles from './fallback.module.css';
export const metadata={title:'Page unavailable',robots:{index:false,follow:false}};
export default function NotFound(){return <main id="main-content" className={styles.panel}><p>Trading Community</p><h1>This page is unavailable</h1><p>The page may not exist, or access may not be available. Private record details are never included here.</p><Link href="/">Return to home</Link><Link href="/support">Get help</Link></main>;}
