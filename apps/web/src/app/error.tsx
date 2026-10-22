'use client';
import {Button} from '@trading/ui';
import styles from './fallback.module.css';
export default function ErrorPage({reset}:{error:Error&{digest?:string};reset:()=>void}){
  return <section className={styles.panel} role="alert"><h1>This view could not be loaded</h1><p>Your request was not confirmed. Retry the view; unsaved form input may need to be entered again. No account or trading action is confirmed by this message.</p><Button onClick={()=>reset()}>Try again</Button><a href="/">Return to home</a></section>;
}
