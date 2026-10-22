"use client";

import { useState } from "react";
import styles from "./workspace.module.css";

export function ComposerForm() {
  const [strategy, setStrategy] = useState("Call debit spread");
  const [kind, setKind] = useState("idea");
  const [asset, setAsset] = useState("Options");
  const [thesis, setThesis] = useState("");
  const [note, setNote] = useState("");
  return <form className={styles.card} onSubmit={(event)=>event.preventDefault()}>
    <h2>Plan details</h2>
    <label>Publication type<select value={kind} onChange={event=>setKind(event.target.value)}><option value="idea">Trade idea</option><option value="education">Educational post</option></select></label>
    <label>Asset class<select value={asset} onChange={(event) => setAsset(event.target.value)}><option>Stocks</option><option>Options</option><option>Futures</option></select></label>
    <label>Instrument<input defaultValue={asset === "Options" ? "SPY" : asset === "Futures" ? "MES" : "AAPL"} key={asset} autoComplete="off"/><small>Choose from the licensed instrument catalog when connected.</small></label>
    {kind === "idea" && (asset === "Options" ? <>
      <label>Options strategy<select value={strategy} onChange={event=>setStrategy(event.target.value)}><option>Long call</option><option>Long put</option><option>Call debit spread</option><option>Put debit spread</option><option>Call credit spread</option><option>Put credit spread</option></select></label>
      <label>Expiration<input type="date"/><small>Vertical spreads use one expiration.</small></label>
      <div className={styles.tableWrap}><table className={styles.legTable}><caption>Illustrative option legs · not catalog-validated</caption><thead><tr><th scope="col">Leg</th><th scope="col">Action</th><th scope="col">Right</th><th scope="col">Strike</th><th scope="col">Quantity</th></tr></thead><tbody>{[0, ...(strategy.startsWith("Long") ? [] : [1])].map(index=><tr key={`${strategy}-${index}`}><td data-label="Leg">{index+1}</td><td data-label="Action">{index===0?'Buy to open':'Sell to open'}</td><td data-label="Right">{strategy.toLowerCase().includes('put')?'Put':'Call'}</td><td data-label="Strike"><input aria-label={`Leg ${index+1} strike`} inputMode="decimal" placeholder={(strategy==='Put debit spread'||strategy==='Call credit spread')?(index===0?'505':'500'):(index===0?'500':'505')}/></td><td data-label="Quantity"><input aria-label={`Leg ${index+1} quantity`} inputMode="numeric" defaultValue="1"/></td></tr>)}</tbody></table></div>
    </> : asset === "Futures" ? <>
      <label>Contract month<input placeholder="Listed contract month"/><small>Catalog validation, tick value, and expiry rules appear when connected.</small></label>
      <label>Direction<select><option>Long</option><option>Short</option></select></label>
      <label>Contracts<input type="number" min="1" placeholder="1"/></label>
    </> : <>
      <label>Side<select><option>Long shares</option><option>Short shares</option></select></label>
      <label>Quantity<input type="number" min="1" placeholder="Shares"/></label>
    </>)}
    <label>{kind==='education'?'Educational explanation':'Thesis'}<textarea rows={4} maxLength={1200} value={thesis} onChange={(event)=>setThesis(event.target.value)} placeholder="Explain your reasoning and uncertainty."/><small>{thesis.length} / 1,200 characters</small></label>
    {kind==='idea'&&<><label>Entry level<input placeholder="Price or condition"/></label><label>Target level<input placeholder="Price or condition"/></label><label>Invalidation level<input placeholder="Price or condition"/></label></>}
    <label>Public chart note<textarea rows={3} maxLength={500} value={note} onChange={(event)=>setNote(event.target.value)} placeholder="Visible with the publication."/><small>{note.length} / 500 characters</small></label>
    <button type="button" disabled title="Draft persistence is not connected">Save draft unavailable</button> <button type="button" disabled title="Review and publishing are not connected">Review publication unavailable</button>
  </form>;
}
