'use client';
import {useState} from 'react';
import {Avatar,Button,Dialog} from '@trading/ui';
import styles from './controls.module.css';
export function Controls(){const[open,setOpen]=useState(false);return <div className={styles.controls}>
  <h1>Component review · synthetic preview</h1><p>Keyboard checks: Tab to Open dialog, press Enter, cycle focus, press Escape, and confirm focus returns to the trigger.</p>
  <section><h2>Buttons</h2><div className={styles.row}><Button onClick={()=>setOpen(true)}>Open dialog</Button><Button variant="secondary">Secondary</Button><Button busy>Saving</Button><Button disabled disabledReason="Available when the identity integration is connected.">Unavailable</Button></div></section>
  <section><h2>Missing avatars and long names</h2><div className={styles.row}><Avatar name="Alexandria Montgomery Research and Risk Planning"/><span>Alexandria Montgomery Research and Risk Planning</span><Avatar name=""/></div></section>
  <Dialog open={open} onOpenChange={setOpen} title="Review a local example" description="This dialog does not modify any account or trade record."><p>Native modal focus containment and Escape dismissal are used.</p><label>Example note<input placeholder="A synthetic note"/></label><Button onClick={()=>setOpen(false)}>Done</Button></Dialog>
</div>;}
