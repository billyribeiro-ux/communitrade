"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { components } from "@trading/contracts";
import type { Draft, ChartDocument } from "@/lib/draft-client";
import { parseChartDocument } from "@/lib/draft-client";
import type { Instrument, InstrumentPage } from "@/lib/instruments";
import { optionStrategies, orderOptionLegs, strategyDefinition, type OptionStrategyId } from "@/lib/option-strategies";
import { PublicationError, publicationRequest, writeHeaders, uuid, type Media, type Publication, type PublicationJob, type TradePlan } from "@/lib/publications";
import {estimatePlan} from "@/lib/plan-estimate";
import { PlanSummary } from "./PlanSummary";
import styles from "./Publication.module.css";

type Upload = components["schemas"]["Upload"];
type Form = {title:string; thesis:string; strategy:TradePlan["strategy"]; quantity:string; entryPrice:string; initialStopPrice:string; entryFrom:string; entryUntil:string; entryCondition:string; timeframe:TradePlan["timeframe"]; exitRules:string; conflicts:string};
const initialForm = (draft:Draft):Form => ({title:draft.title,thesis:draft.thesis,strategy:draft.plan?.strategy ?? (draft.plan?.asset === "option" ? "long_call" : "long"),quantity:String(draft.plan?.quantity ?? 1),entryPrice:draft.plan?.entryPrice ?? "",initialStopPrice:draft.plan?.initialStopPrice ?? "",entryFrom:draft.plan?.entryFrom ?? "",entryUntil:draft.plan?.entryUntil ?? "",entryCondition:draft.plan?.entryCondition ?? "",timeframe:draft.plan?.timeframe ?? "swing",exitRules:draft.plan?.exitRules ?? "",conflicts:draft.plan?.conflicts ?? ""});
const decimal = /^-?[0-9]{1,18}(?:\.[0-9]{1,10})?$/;
function priceKind(strategy:TradePlan["strategy"], asset:string):TradePlan["priceKind"] { return asset === "stock" ? "underlying" : asset === "future" ? "futures" : strategy.includes("credit") ? "spread_credit" : strategy.includes("debit") ? "spread_debit" : "option_premium"; }
function utc(value:string):boolean { return value.endsWith("Z") && Number.isFinite(Date.parse(value)); }

export function Composer({initialDraft, initialChart, instrument, csrfToken}: {initialDraft:Draft; initialChart:ChartDocument|null; instrument:Instrument; csrfToken:string}) {
  const router = useRouter();
  const [draft,setDraft] = useState(initialDraft);
  const [form,setForm] = useState(() => initialForm(initialDraft));
  const baseline = useRef(JSON.stringify(initialForm(initialDraft)));
  const [selected,setSelected] = useState<string[]>(initialDraft.plan?.legs?.map(leg=>leg.instrumentId) ?? []);
  const legBaseline = useRef(JSON.stringify(selected));
  const [contracts,setContracts] = useState<Instrument[]>([]);
  const [contractsCursor,setContractsCursor] = useState<string|null>(null);
  const [contractError,setContractError] = useState("");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [message,setMessage] = useState("");
  const [conflict,setConflict] = useState(false);
  const [review,setReview] = useState<{draft:Draft; chart:ChartDocument}|null>(null);
  const [ack,setAck] = useState(false);
  const [job,setJob] = useState<PublicationJob|null>(()=>initialDraft.publicationStatus==="processing"&&initialDraft.publicationJobId?{id:initialDraft.publicationJobId,status:"pending",publicationId:null,failureCode:null,createdAt:initialDraft.updatedAt}:null);
  const publishAttempt = useRef<{key:string; body:string; revision:number}|null>(null);
  const [uploadMessage,setUploadMessage] = useState("");
  const [uploadBusy,setUploadBusy] = useState(false);
  const [uploadReady,setUploadReady] = useState<string|null>(null);
  const upload = useRef<{file:File; key:string; completeKey:string; id?:string; bytesSent?:boolean}|null>(null);
  const [fileName,setFileName] = useState("");
  const mounted = useRef(false);
  const education = draft.kind === "education";
  const asset = draft.plan?.asset ?? instrument.asset;
  const option = asset === "option";
  const definition = strategyDefinition(form.strategy);
  const requiredLegs = definition?.contracts ?? 1;
  const displayedContracts = useMemo(() => contracts.filter(contract => contract.optionType === definition?.optionType), [contracts,definition?.optionType]);
  const dirty = JSON.stringify(form) !== baseline.current || JSON.stringify(selected) !== legBaseline.current;
  const locked = busy || draft.publicationStatus==="published" || (!!job && job.status !== "failed");
  const riskEstimate=useMemo(()=>{if(!review||education)return null;try{return {result:estimatePlan(review.draft.plan as TradePlan,instrument,contracts)};}catch(error){return {error:error instanceof Error?error.message:"The displayed references could not produce a planning estimate."};}},[review,education,instrument,contracts]);

  useEffect(() => { mounted.current = true; return () => {mounted.current=false;}; }, []);
  useEffect(() => {
    if (!option || education) return;
    const abort = new AbortController();
    publicationRequest<InstrumentPage>(`/instruments/${instrument.id}/option-contracts?limit=50`, {signal:abort.signal}).then(({data})=>{setContracts(data.items);setContractsCursor(data.nextCursor);}).catch(e=>{if(!abort.signal.aborted)setContractError(e instanceof Error?e.message:"Option contracts are unavailable.");});
    return ()=>abort.abort();
  },[instrument.id,option,education]);
  useEffect(() => {
    if (!dirty && !uploadBusy) return;
    const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};
    window.addEventListener("beforeunload",warn);
    return ()=>window.removeEventListener("beforeunload",warn);
  },[dirty,uploadBusy]);
  useEffect(() => {
    if (!job || ["failed","succeeded"].includes(job.status)) return;
    const abort = new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try {
        const {data}=await publicationRequest<PublicationJob>(`/publication-jobs/${job.id}`,{signal:abort.signal});
        if (abort.signal.aborted) return;
        setJob(data);
        if(data.status==="failed"){const current=await latest();if(!abort.signal.aborted)setDraft(current);}
        if(data.status==="succeeded"&&data.publicationId){const published=await publicationRequest<Publication>(`/publications/${data.publicationId}`,{signal:abort.signal});if(!abort.signal.aborted)router.push(`/ideas/${published.data.id}/${published.data.slug}`);}
        else if(data.status!=="failed")timer=setTimeout(poll,1500);
      }catch(e){if(!abort.signal.aborted){setMessage(e instanceof Error?e.message:"Publication status is temporarily unavailable. Keep this page open or check the job again.");timer=setTimeout(poll,5000);}}
    };
    timer=setTimeout(poll,500);
    return()=>{abort.abort();clearTimeout(timer);};
  },[job?.id,job?.status,router]);

  function update<K extends keyof Form>(key:K,value:Form[K]){setForm(previous=>({...previous,[key]:value}));setReview(null);setAck(false);}
  async function latest(){return (await publicationRequest<Draft>(`/drafts/${draft.id}`)).data;}
  async function savePlan(openChart=false){
    setBusy(true);setError("");setMessage("");
    try{
      if(!form.title.trim()||!form.thesis.trim())throw new Error("Add a title and thesis before continuing.");
      const quantity=Number(form.quantity);
      if(!education&&(!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000))throw new Error("Quantity must be a whole number from 1 to 1,000,000.");
      if(!education&&!decimal.test(form.entryPrice))throw new Error("Enter a decimal entry price.");
      if(!education&&(!utc(form.entryFrom)||!utc(form.entryUntil)||Date.parse(form.entryFrom)>=Date.parse(form.entryUntil)))throw new Error("Enter an increasing UTC entry window, for example 2026-10-21T13:30:00.000Z.");
      if(!education&&(!form.entryCondition.trim()||!form.exitRules.trim()||!form.conflicts.trim()))throw new Error("Complete entry conditions, intended exits and conflicts. Write None if there are no conflicts.");
      if(!education&&!option&&!decimal.test(form.initialStopPrice))throw new Error("Stocks and futures require an initial planned stop.");
      const chosen=selected.map(id=>contracts.find(item=>item.id===id)).filter((item):item is Instrument=>!!item);
      if(!education&&option&&chosen.length&&new Set(chosen.map(item=>item.expiration)).size!==1)throw new Error("Option legs must use the same actual expiration.");
      if(!education&&option&&(chosen.length!==requiredLegs||new Set(selected).size!==requiredLegs))throw new Error(`Choose ${requiredLegs} distinct actual option contract${requiredLegs>1?"s":""}.`);
      const legs=option&&!education?orderOptionLegs(form.strategy as OptionStrategyId,chosen.map(item=>({...item,strike:item.strike??"0"}))).map(({contract,side})=>({instrumentId:contract.id,side:side==="long"?"buy" as const:"sell" as const,quantity})):[];
      const current=await latest();
      if(current.title!==draft.title||current.thesis!==draft.thesis||JSON.stringify({...current.plan,underlyingChartLevels:undefined})!==JSON.stringify({...draft.plan,underlyingChartLevels:undefined})){setConflict(true);throw new Error("Draft text or plan changed in another session. Your inputs remain here; reload the current draft to continue.");}
      // Asset/instrument and linked chart levels are retained from their separately saved editor.
      const plan=education?{conflicts:form.conflicts}:{strategy:form.strategy,quantity,entryPrice:form.entryPrice,priceKind:priceKind(form.strategy,asset),legs,entryFrom:form.entryFrom,entryUntil:form.entryUntil,entryCondition:form.entryCondition,timeframe:form.timeframe,exitRules:form.exitRules,conflicts:form.conflicts,...(!option?{initialStopPrice:form.initialStopPrice}:{})};
      const {data}=await publicationRequest<Draft>(`/drafts/${draft.id}`,{method:"PATCH",headers:writeHeaders(csrfToken,undefined,current.revision),body:JSON.stringify({title:form.title.trim(),thesis:form.thesis,plan})});
      setDraft(data);baseline.current=JSON.stringify(form);legBaseline.current=JSON.stringify(selected);setMessage("Private plan saved. The server revalidates complete terms and current data rights at publication.");setReview(null);
      if(openChart)router.push(`/app/drafts/${draft.id}`);
      return data;
    }catch(e){if(e instanceof PublicationError&&e.status===409)setConflict(true);setError(e instanceof Error?e.message:"Plan could not be saved.");return null;}
    finally{setBusy(false);}
  }
  async function prepareReview(event?:FormEvent){
    event?.preventDefault();
    const saved=await savePlan();if(!saved)return;
    setBusy(true);setError("");
    try{const [latestDraft,savedChart]=await Promise.all([latest(),publicationRequest<unknown>(`/drafts/${draft.id}/chart`)]);const chart=parseChartDocument(savedChart.data);if(latestDraft.chartRevision!==chart.revision)throw new Error("The chart changed during review. Load the latest review again.");if(!chart.revision)throw new Error("Save the chart in the chart editor before reviewing.");setDraft(latestDraft);setReview({draft:latestDraft,chart});setAck(false);}catch(e){setError(e instanceof Error?e.message:"Review could not be loaded. Save your chart first.");}finally{setBusy(false);}
  }
  async function publish(){
    if(!review||!ack)return;
    setBusy(true);setError("");
    try{
      const body=JSON.stringify({draftRevision:review.draft.revision,chartRevision:review.chart.revision});
      if(!publishAttempt.current||publishAttempt.current.body!==body)publishAttempt.current={key:crypto.randomUUID(),body,revision:review.draft.revision};
      const attempt=publishAttempt.current;
      const {data}=await publicationRequest<PublicationJob>(`/drafts/${draft.id}/publish`,{method:"POST",headers:writeHeaders(csrfToken,attempt.key,attempt.revision),body:attempt.body});
      setJob(data);setMessage("The reviewed candidate is frozen. It becomes public only after the trusted snapshot job succeeds.");
    }catch(e){if(e instanceof PublicationError&&e.status===409)setConflict(true);setError(e instanceof Error?e.message:"Publishing could not be started. Retry uses the same request.");}finally{setBusy(false);}
  }
  async function pollMedia(id:string):Promise<Media>{
    for(let i=0;i<30;i++){if(!mounted.current)throw new Error("Upload page closed.");const {data}=await publicationRequest<Media>(`/media/${id}`);if(data.status==="ready")return data;if(data.status==="rejected")throw new Error(data.reason??"The processor rejected this image.");await new Promise(resolve=>setTimeout(resolve,1000));}
    throw new Error("Image processing is still pending. Retry to check the same upload; your saved draft is preserved.");
  }
  async function uploadAttachment(){
    const attempt=upload.current;if(!attempt)return;setUploadBusy(true);setUploadMessage("");
    try{
      if(attempt.file.size>2097152||!['image/png','image/jpeg','image/webp'].includes(attempt.file.type))throw new Error("Choose a PNG, JPEG or WebP image no larger than 2 MiB.");
      if(!attempt.id){const {data}=await publicationRequest<Upload>("/uploads",{method:"POST",headers:writeHeaders(csrfToken,attempt.key),body:JSON.stringify({purpose:"publication_attachment",resourceId:draft.id,resourceType:"draft",filename:attempt.file.name.slice(0,200),mime:attempt.file.type,sizeBytes:attempt.file.size})});if(!uuid.test(data.id))throw new Error("The upload service returned an invalid identifier.");attempt.id=data.id;}
      if(!attempt.bytesSent){const r=await fetch(`/api/v1/uploads/${attempt.id}/content`,{method:"POST",credentials:"same-origin",cache:"no-store",signal:AbortSignal.timeout(30000),headers:{"Content-Type":attempt.file.type,"X-CSRF-Token":csrfToken},body:attempt.file});if(!r.ok)throw new Error("Image bytes could not be stored. Retry this upload; your draft has not changed.");attempt.bytesSent=true;}
      await publicationRequest<Media>(`/uploads/${attempt.id}/complete`,{method:"POST",headers:writeHeaders(csrfToken,attempt.completeKey)});
      await pollMedia(attempt.id);setUploadReady(attempt.id);setUploadMessage("Processed image ready. Attach it to the draft below.");
    }catch(e){setUploadMessage(e instanceof Error?e.message:"Upload failed. Your existing draft and attachments are preserved.");}finally{setUploadBusy(false);}
  }
  async function assignAttachments(ids:readonly string[]){
    setBusy(true);setError("");
    try{const current=await latest();if(JSON.stringify(current.attachmentIds)!==JSON.stringify(draft.attachmentIds)){setConflict(true);throw new Error("Attachments changed in another session. Reload the current draft before assigning images; the existing list is preserved.");}const {data}=await publicationRequest<Draft>(`/drafts/${draft.id}`,{method:"PATCH",headers:writeHeaders(csrfToken,undefined,current.revision),body:JSON.stringify({attachmentIds:ids})});setDraft(data);setReview(null);setAck(false);setUploadReady(null);setUploadMessage("Draft attachments saved.");}catch(e){setError(e instanceof Error?e.message:"Attachment assignment failed. Retry after refreshing the draft.");}finally{setBusy(false);}
  }
  async function loadMoreContracts(){try{const {data}=await publicationRequest<InstrumentPage>(`/instruments/${instrument.id}/option-contracts?${new URLSearchParams({limit:"50",cursor:contractsCursor??""})}`);setContracts(items=>[...items,...data.items.filter(item=>!items.some(old=>old.id===item.id))]);setContractsCursor(data.nextCursor);}catch(e){setContractError(e instanceof Error?e.message:"More contracts could not be loaded.");}}

  return <main className={styles.page} id="main-content"><p className={styles.eyebrow}>PRIVATE COMPOSER · {education?"EDUCATIONAL POST":asset.toUpperCase()}</p><h1>Complete your idea</h1><ol className={styles.steps}><li>1 · {instrument.symbol}{instrument.contractMonth?` · ${instrument.contractMonth}`:""}</li><li aria-current={review?undefined:"step"}>2 · Plan and explanation</li><li><Link href={`/app/drafts/${draft.id}`}>3 · Chart</Link></li><li aria-current={review?"step":undefined}>4 · Review and publish</li></ol><p className={styles.notice}>Members report their own plans and executions. The platform does not verify brokerage activity. Chart notes, thesis, conflicts and attached images become public with this idea; keep journal-only notes private.</p>
    {draft.publicationStatus==="published"&&draft.publicationId&&<p className={styles.notice}>This draft has been published and is locked. <Link href={`/ideas/${draft.publicationId}/publication`}>Open the published idea and visible correction workflow</Link>.</p>}{error&&<p role="alert" className={`${styles.notice} ${styles.error}`}>{error}</p>}{message&&<p role="status" className={styles.notice}>{message}</p>}{conflict&&<p className={styles.notice}><button onClick={()=>{if(window.confirm("Discard local composer inputs and reload the current draft?"))window.location.reload();}}>Reload current draft…</button></p>}
    <form onSubmit={prepareReview} className={styles.card}><fieldset disabled={locked||conflict}><legend>{education?"Educational explanation":"Structured trade plan"}</legend><div className={styles.fields}><label className={styles.wide}>Title<input required maxLength={120} value={form.title} onChange={e=>update("title",e.target.value)}/></label><label className={styles.wide}>Thesis<textarea required maxLength={10000} rows={5} value={form.thesis} onChange={e=>update("thesis",e.target.value)}/></label>
    {!education&&<><label>Strategy<select value={form.strategy} onChange={e=>{update("strategy",e.target.value as Form["strategy"]);setSelected([]);}}>{option?optionStrategies.map(item=><option value={item.id} key={item.id}>{item.label}</option>):["long","short"].map(value=><option key={value}>{value}</option>)}</select></label><label>Whole {option?"contracts / spread units":asset==="stock"?"shares":"contracts"}<input required type="number" min={1} max={1000000} step={1} value={form.quantity} onChange={e=>update("quantity",e.target.value)}/></label><label>Entry price · {priceKind(form.strategy,asset).replaceAll("_"," ")}<input required inputMode="decimal" value={form.entryPrice} onChange={e=>update("entryPrice",e.target.value)}/></label>{!option&&<label>Initial planned stop<input required inputMode="decimal" value={form.initialStopPrice} onChange={e=>update("initialStopPrice",e.target.value)}/></label>}<label>Entry window starts · UTC<input required placeholder="2026-10-21T13:30:00.000Z" value={form.entryFrom} onChange={e=>update("entryFrom",e.target.value)}/></label><label>Entry window ends · UTC<input required placeholder="2026-10-21T20:00:00.000Z" value={form.entryUntil} onChange={e=>update("entryUntil",e.target.value)}/></label><label className={styles.wide}>Entry condition<textarea required maxLength={1000} value={form.entryCondition} onChange={e=>update("entryCondition",e.target.value)}/></label><label>Timeframe<select value={form.timeframe} onChange={e=>update("timeframe",e.target.value as Form["timeframe"])}>{["intraday","swing","position"].map(value=><option key={value}>{value}</option>)}</select></label><label className={styles.wide}>Intended exits<textarea required maxLength={2000} value={form.exitRules} onChange={e=>update("exitRules",e.target.value)}/></label></>}
    <label className={styles.wide}>Conflicts and disclosures<textarea required={!education} maxLength={1000} placeholder="State relevant positions, relationships or compensation. Write None if none." value={form.conflicts} onChange={e=>update("conflicts",e.target.value)}/></label></div>
    {option&&!education&&<fieldset><legend>Actual listed option contracts · choose {requiredLegs}</legend><p>Verticals require the same underlying, expiration and option right, distinct strikes and equal units. The server validates the complete structure. Premiums/spread prices are separate from the underlying chart.</p>{contractError&&<p role="alert">{contractError}</p>}<div className={styles.contracts}>{displayedContracts.map(contract=><label className={styles.checkbox} key={contract.id}><input type="checkbox" checked={selected.includes(contract.id)} disabled={!contract.enabled||!contract.meta.capabilities.newPublishing||(!selected.includes(contract.id)&&selected.length>=requiredLegs)} onChange={()=>{setSelected(ids=>ids.includes(contract.id)?ids.filter(id=>id!==contract.id):[...ids,contract.id]);setReview(null);}}/><span>{contract.symbol} · {contract.expiration} · {contract.optionType} · strike {contract.strike} · multiplier {contract.multiplier} · metadata v{contract.metadataVersion}{contract.meta.demo?" · synthetic fixture":""}</span></label>)}</div>{contractsCursor&&<button type="button" onClick={loadMoreContracts}>More actual contracts</button>}</fieldset>}
    <div className={styles.actions}><button type="button" onClick={()=>savePlan()}>Save private plan</button><button type="button" onClick={()=>savePlan(true)}>Save and edit chart</button><button type="submit" className={styles.primary}>Save and review</button></div></fieldset></form>
    <section className={styles.card}><h2>Processed attachments · {draft.attachmentIds.length}/3</h2><p>PNG, JPEG or WebP, maximum 2 MiB each. Only processed, owned images can be attached. Uploading an image never replaces the trusted chart snapshot.</p>{draft.attachmentIds.map(id=><div key={id}><img className={styles.attachment} src={`/api/v1/media/${id}/content`} alt="Image attached to this draft"/><button disabled={locked||conflict} onClick={()=>assignAttachments(draft.attachmentIds.filter(item=>item!==id))}>Remove attachment</button></div>)}<label>Choose an image<input type="file" accept="image/png,image/jpeg,image/webp" disabled={locked||uploadBusy||draft.attachmentIds.length>=3} onChange={e=>{const file=e.target.files?.[0];upload.current=file?{file,key:crypto.randomUUID(),completeKey:crypto.randomUUID()}:null;setFileName(file?.name??"");setUploadReady(null);setUploadMessage("");}}/></label><div className={styles.actions}><button disabled={locked||uploadBusy||!fileName||draft.attachmentIds.length>=3} onClick={uploadAttachment}>{uploadBusy?"Processing…":"Upload / retry image"}</button>{uploadReady&&<button disabled={locked||draft.attachmentIds.length>=3} onClick={()=>assignAttachments([...draft.attachmentIds,uploadReady])}>Attach processed image</button>}</div>{uploadMessage&&<p role="status">{uploadMessage}</p>}</section>
    <section className={styles.card}><h2>Chart and underlying levels</h2><p>{initialChart?`Saved chart revision ${draft.chartRevision}. `:"No saved chart yet. "}One chart with up to 50 drawings. Open the chart editor to save or correct its values before review.</p><Link href={`/app/drafts/${draft.id}`}>Edit chart and public chart notes</Link></section>
    {review&&<section className={styles.card}><h2>Review the frozen candidate</h2><h3>{review.draft.title}</h3><p>{review.draft.thesis}</p><PlanSummary plan={education?null:review.draft.plan as TradePlan} references={[instrument,...contracts]}/><p>Chart revision {review.chart.revision} · {review.chart.state.drawings.length} drawings · {review.chart.state.provenance.demo?"Demo data · synthetic":"Source"} {review.chart.state.provenance.provider} · as of {review.chart.state.provenance.asOf} · {review.chart.state.provenance.delaySeconds}s delay · {review.draft.attachmentIds.length} processed attachments.</p><p>Planning estimate: {riskEstimate&&"result" in riskEstimate?`initial cash risk ${riskEstimate.result.initialRisk??"unavailable"} USD · theoretical maximum profit ${riskEstimate.result.maxProfitKind==="unlimited"?"unlimited":riskEstimate.result.maxProfit??"not capped by this plan"} USD before costs`:riskEstimate&&"error" in riskEstimate?riskEstimate.error:"Educational post · no position risk calculation"}. The server independently validates the reference metadata, plan and current permissions.</p><p>Initial risk stays frozen after publication. Stock/futures stops are planned risk, not guaranteed loss limits. Option theoretical maximum loss assumes the supported standard structure; assignment/expiry exceptions require explicit reporting and review.</p><label className={styles.checkbox}><input type="checkbox" checked={ack} disabled={locked} onChange={e=>setAck(e.target.checked)}/>I reviewed these public terms, drawings and attachments. Reported outcomes are unverified; later corrections remain visible.</label><button className={styles.primary} disabled={locked||!ack||conflict||uploadBusy||!!riskEstimate&&"error" in riskEstimate} onClick={publish}>{busy?"Starting publication…":"Freeze and publish idea"}</button></section>}
    {job&&<section className={styles.card} aria-live="polite"><h2>Publication job · {job.status}</h2><p>Reference {job.id}. {job.status==="failed"?`The snapshot did not complete (${job.failureCode??"processing failure"}). Your draft is preserved.`:"No public timestamp is created until all required processing succeeds."}</p>{job.status==="failed"&&<button onClick={()=>{setJob(null);setReview(null);publishAttempt.current=null;setAck(false);setMessage("Reload the saved plan and review before creating a new publication attempt.");}}>Return to saved draft review</button>}{job.status==="succeeded"&&job.publicationId&&<Link href={`/ideas/${job.publicationId}/publication`}>Open publication status</Link>}</section>}
  </main>;
}
