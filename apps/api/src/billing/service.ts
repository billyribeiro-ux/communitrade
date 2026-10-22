import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { CommandError } from '../http/problem.js';
import { effectivePlan } from '../workspace/entitlements.js';
import { enqueueTransactionalNotification } from '../notifications/service.js';
import { recordProductEvent } from '../measurement/events.js';
import { requireUuid, withActorTransaction, withTransaction, type Transaction } from '../persistence/transactions.js';
import { entitlementFor, intervalFor, BILLING_PLANS, planFor } from './domain.js';
import type { BillingMode, BillingPlan, BillingRuntime, NormalizedBillingEvent, ProviderCustomerState, ProviderSubscription } from './provider.js';
import type { BillingProviderConfig } from './provider-config.js';
import { BillingProviderError } from './stripe-provider.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const iso = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : null;
const safeReason = (value: unknown) => typeof value === 'string' ? [...value.trim()].map(character => {
  const code = character.charCodeAt(0);
  return code < 32 || code === 127 ? ' ' : character;
}).join('').slice(0, 2000) : '';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const providerStatus = (value: string | null | undefined) => {
  const status = (value ?? 'free').toLowerCase().replaceAll('-', '_');
  return ['active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired'].includes(status) ? status : 'free';
};
const lockOwner = (tx: Transaction, owner: string) => tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`billing-owner:${owner}`]);
const planPrice = (plan: BillingPlan) => plan === 'pro_month' ? BILLING_PLANS[0]! : BILLING_PLANS[1]!;
const resultJson = <T>(value: unknown): T | null => value && typeof value === 'object' ? value as T : null;

export interface CheckoutInput { plan: 'pro'; interval: 'monthly' | 'annual'; termsVersion: string }
export interface BillingActionInput { action: 'reconcile' | 'refund' | 'cancel'; reason: string; paymentId?: string; amount?: string; cancelSubscription?: boolean }

export class BillingService {
  constructor(private readonly pool: Pool, private readonly port: BillingRuntime, private readonly config: BillingProviderConfig) {}

  private async requireAdmin(tx:Transaction,userId:string){
    const role=await tx.query("SELECT 1 FROM role_grant WHERE user_id=$1 AND role='admin' LIMIT 1",[userId]);
    if(!role.rowCount)throw new CommandError(403,'ADMIN_REQUIRED');
  }

  listPlans() { return {items:[
    {id:'free',monthlyUsd:'0.00',annualUsd:'0.00',limits:{watchlists:1,itemsPerWatchlist:25,savedLayouts:1,newJournalEntriesPerMonth:30}},
    {id:'pro',monthlyUsd:'29.00',annualUsd:'290.00',limits:{watchlists:10,itemsPerWatchlist:100,savedLayouts:10,newJournalEntriesPerMonth:1000}}
  ]}; }

  private get databaseAccount() { return `${this.port.provider}:${this.port.providerAccountId}`; }

  private checkScope(value: { providerAccountId: string; mode: BillingMode }) {
    if (value.providerAccountId !== this.port.providerAccountId || value.mode !== this.port.mode) throw new CommandError(400, 'BILLING_SCOPE_MISMATCH');
  }

  async getSubscription(userId: string) {
    requireUuid(userId);
    return withActorTransaction(this.pool, userId, async tx => this.summary(tx, userId));
  }

  private async summary(tx: Transaction, userId: string) {
    const scope = [this.databaseAccount, this.port.mode];
    const found = await tx.query(`SELECT s.*, c.provider_customer_id FROM subscription s
      LEFT JOIN billing_customer c ON c.user_id=s.user_id AND c.provider_account=s.provider_account AND c.mode=s.mode
      WHERE s.user_id=$1 AND s.provider_account=$2 AND s.mode=$3
      ORDER BY s.last_reconciled_at DESC NULLS LAST,s.current_period_end DESC NULLS LAST LIMIT 1`, [userId, ...scope]);
    const sub = found.rows[0];
    const limits = await effectivePlan(tx, userId);
    const apiLimits={watchlists:limits.watchlists,itemsPerWatchlist:limits.watchlistItems,savedLayouts:limits.layouts,newJournalEntriesPerMonth:limits.journalMonthly};
    const quota = await tx.query(`SELECT COALESCE((SELECT count+reserved_count FROM quota_bucket WHERE user_id=$1 AND metric='journal_monthly'
        AND month_start=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::int AS journal_used,
      (SELECT count(*)::int FROM watchlist WHERE owner_user_id=$1) AS watchlists,
      (SELECT count(*)::int FROM saved_layout WHERE owner_user_id=$1) AS layouts,
      (SELECT count(*)::int FROM saved_search WHERE owner_user_id=$1) AS saved_searches`, [userId]);
    const usage = [
      { key:'journal_monthly', label:'Journal entries this month', used:Number(quota.rows[0]?.journal_used ?? 0), limit:limits.journalMonthly },
      { key:'watchlists', label:'Watchlists', used:Number(quota.rows[0]?.watchlists ?? 0), limit:limits.watchlists },
      { key:'layouts', label:'Saved layouts', used:Number(quota.rows[0]?.layouts ?? 0), limit:limits.layouts },
      { key:'saved_searches', label:'Saved searches', used:Number(quota.rows[0]?.saved_searches ?? 0), limit:limits.plan==='pro'?5:0 }
    ];
    const invoices = await tx.query(`SELECT id,provider_invoice_id,status,amount_due,amount_paid,currency,created_at,hosted_invoice_url,payment_id
      FROM billing_invoice WHERE user_id=$1 AND provider_account=$2 AND mode=$3 ORDER BY created_at DESC,id DESC LIMIT 24`, [userId, ...scope]);
    const pending = await tx.query(`SELECT id,kind,status FROM billing_operation WHERE user_id=$1 AND provider_account=$2 AND mode=$3 AND status IN ('pending','processing','uncertain')
      ORDER BY updated_at DESC,id DESC LIMIT 1`, [userId,...scope]);
    const plan = limits.plan;
    const resumable = plan === 'free' ? await tx.query(`SELECT result->>'url' url FROM billing_operation
      WHERE user_id=$1 AND provider_account=$2 AND mode=$3 AND kind='checkout' AND status='succeeded'
        AND NULLIF(result->>'expiresAt','')::timestamptz>now() ORDER BY updated_at DESC,id DESC LIMIT 1`, [userId,...scope]) : { rows: [] as Record<string, unknown>[] };
    const entitlementStatus = sub ? providerStatus(sub.provider_status) : 'free';
    return {
      plan, status: entitlementStatus, paidThrough: iso(sub?.paid_through), graceUntil: iso(sub?.grace_until), limits:apiLimits,
      interval: intervalFor(planFor(sub?.plan)), cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end), provider: this.port.provider,
      mode: this.port.mode, demo: this.port.provider === 'fake' && this.port.mode === 'test', portalAvailable: Boolean(sub?.provider_customer_id),
      usage, invoices: invoices.rows.map(row => ({ id:String(row.id), number:null, status:String(row.status), amountMinor:Number(row.amount_due), currency:'usd',
        issuedAt:iso(row.created_at), hostedInvoiceUrl:row.hosted_invoice_url ? String(row.hosted_invoice_url) : null, paymentId:row.payment_id ? String(row.payment_id) : null })),
      pendingOperation: pending.rows[0] ? { id:String(pending.rows[0].id), status:String(pending.rows[0].status), kind:String(pending.rows[0].kind) } : null,
      resumeCheckoutUrl: typeof resumable.rows[0]?.url === 'string' ? String(resumable.rows[0].url) : null,
      lastReconciledAt:iso(sub?.last_reconciled_at)
    };
  }

  private async beginOperation(userId: string, kind: string, idempotencyKey: string, input: unknown) {
    requireUuid(userId);
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 16 || idempotencyKey.length > 200 || !/^[A-Za-z0-9._:/-]+$/.test(idempotencyKey)) throw new CommandError(400, 'INVALID_COMMAND_KEY');
    const requestHash = hash(input);
    return withActorTransaction(this.pool, userId, async tx => {
      await lockOwner(tx, userId);
      const existing = await tx.query('SELECT * FROM billing_operation WHERE user_id=$1 AND provider_account=$3 AND mode=$4 AND idempotency_key=$2 FOR UPDATE', [userId,idempotencyKey,this.databaseAccount,this.port.mode]);
      if (existing.rows[0]) {
        const operation = existing.rows[0];
        if (operation.kind!==kind||operation.request_hash !== requestHash) throw new CommandError(409, 'IDEMPOTENCY_MISMATCH');
        return { operation, created:false };
      }
      if(kind==='checkout'){
        const checkout=input as CheckoutInput;
        const accepted=await tx.query('SELECT 1 FROM policy_acceptance WHERE user_id=$1 AND policy_slug=$2 AND version=$3',[userId,'terms',checkout.termsVersion]);
        if(!accepted.rowCount)throw new CommandError(403,'TERMS_ACCEPTANCE_REQUIRED');
        const current=await tx.query(`SELECT 1 FROM subscription_entitlement WHERE user_id=$1 AND provider_account=$2 AND provider_mode=$3
          AND plan='pro' AND valid_until>now() LIMIT 1`,[userId,this.databaseAccount,this.port.mode]);
        if(current.rowCount)throw new CommandError(409,'ALREADY_PRO');
        const providerSubscription=await tx.query(`SELECT 1 FROM subscription WHERE user_id=$1 AND provider_account=$2 AND mode=$3
          AND provider_status IN ('active','trialing','past_due','incomplete') LIMIT 1`,[userId,this.databaseAccount,this.port.mode]);
        if(providerSubscription.rowCount)throw new CommandError(409,'ALREADY_SUBSCRIBED');
        const open=await tx.query(`SELECT id FROM billing_operation WHERE user_id=$1 AND provider_account=$2 AND mode=$3 AND kind='checkout' AND status IN ('pending','processing','uncertain')
          UNION ALL SELECT id FROM billing_operation WHERE user_id=$1 AND provider_account=$2 AND mode=$3 AND kind='checkout' AND status='succeeded'
          AND NULLIF(result->>'expiresAt','')::timestamptz>now() LIMIT 1`,[userId,this.databaseAccount,this.port.mode]);
        if(open.rowCount)throw new CommandError(409,'CHECKOUT_ALREADY_PENDING');
      }
      const id = randomUUID();
      const inserted = await tx.query(`INSERT INTO billing_operation(id,user_id,kind,idempotency_key,request_hash,provider_account,mode,status,result,attempts,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8::jsonb,0,now(),now()) RETURNING *`, [id,userId,kind,idempotencyKey,requestHash,this.databaseAccount,this.port.mode,JSON.stringify(input)]);
      return { operation:inserted.rows[0], created:true };
    });
  }

  private async updateOperation(id: string, status: string, providerRef?: string | null, result?: unknown, reason?: string) {
    await withTransaction(this.pool, async tx => {
      await tx.query(`UPDATE billing_operation SET status=$2::text,provider_ref=COALESCE($3,provider_ref),result=COALESCE($4::jsonb,result),
        reason=$5,attempts=attempts+1,updated_at=now(),next_attempt_at=CASE WHEN $2::text IN ('pending','uncertain') THEN now()+interval '1 minute'*LEAST(60,GREATEST(attempts,1)) ELSE now() END WHERE id=$1`, [id,status,providerRef ?? null,result === undefined ? null : JSON.stringify(result),reason ?? null]);
    });
  }

  private async completeAdminOperation(operationId:string,actorUserId:string,subscriptionId:string,action:'refund'|'cancel'|'reconcile',reason:string,paymentId?:string|null,providerRef?:string|null){
    return withActorTransaction(this.pool,actorUserId,async tx=>{
      await this.requireAdmin(tx,actorUserId);
      const target=await tx.query('SELECT id FROM subscription WHERE id=$1 AND provider_account=$2 AND mode=$3',[subscriptionId,this.databaseAccount,this.port.mode]);
      if(!target.rowCount)throw new CommandError(404,'SUBSCRIPTION_NOT_FOUND');
      const id=randomUUID();const metadata={provider:this.port.provider,mode:this.port.mode,action,...(paymentId?{paymentId}:{}),cancelSubscription:false};
      const row=await tx.query(`INSERT INTO audit_event(id,actor,resource_type,resource_id,action,reason,request_id,metadata,created_at)
        VALUES($1,$2,'subscription',$3,$4,$5,NULL,$6::jsonb,now()) RETURNING created_at`,[id,actorUserId,subscriptionId,`billing_${action}`,reason,JSON.stringify(metadata)]);
      const createdAt=row.rows[0]?.created_at;if(!createdAt)throw new Error('Audit insert returned no timestamp');
      const response={id,actorId:actorUserId,resourceType:'subscription',resourceId:subscriptionId,action:`billing_${action}`,reason,createdAt:iso(createdAt)};
      await tx.query("UPDATE billing_operation SET status='succeeded',provider_ref=COALESCE($2,provider_ref),result=$3::jsonb,reason=NULL,attempts=attempts+1,updated_at=now(),next_attempt_at=now() WHERE id=$1",[operationId,providerRef??null,JSON.stringify(response)]);
      return response;
    });
  }

  private async customer(userId: string, operationId: string, idempotencyKey: string) {
    const saved = await withActorTransaction(this.pool, userId, async tx => {
      const row = await tx.query('SELECT provider_customer_id FROM billing_customer WHERE user_id=$1 AND provider_account=$2 AND mode=$3', [userId,this.databaseAccount,this.port.mode]);
      const user = await tx.query('SELECT email FROM user_account WHERE id=$1', [userId]);
      return { customerId:row.rows[0]?.provider_customer_id ?? null, email:user.rows[0]?.email ?? undefined };
    });
    const customer = await this.port.ensureCustomer({ userId, email:saved.email ?? undefined, existingCustomerId:saved.customerId, idempotencyKey:`${idempotencyKey}:customer` });
    this.checkScope(customer);
    await withActorTransaction(this.pool, userId, async tx => {
      await tx.query(`INSERT INTO billing_customer(id,user_id,provider_account,mode,provider_customer_id,created_at) VALUES($1,$2,$3,$4,$5,now())
        ON CONFLICT(provider_account,mode,user_id) DO UPDATE SET provider_customer_id=EXCLUDED.provider_customer_id`, [randomUUID(),userId,this.databaseAccount,this.port.mode,customer.customerId]);
    });
    return customer.customerId;
  }

  async createCheckout(userId: string, input: CheckoutInput, idempotencyKey: string) {
    if (!input || input.plan !== 'pro' || !['monthly','annual'].includes(input.interval) || typeof input.termsVersion !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(input.termsVersion)) throw new CommandError(422, 'INVALID_CHECKOUT');
    const plan: BillingPlan = input.interval === 'monthly' ? 'pro_month' : 'pro_year';
    const savedCustomer=await withActorTransaction(this.pool,userId,async tx=>tx.query('SELECT provider_customer_id FROM billing_customer WHERE user_id=$1 AND provider_account=$2 AND mode=$3',[userId,this.databaseAccount,this.port.mode]));
    if(savedCustomer.rows[0]?.provider_customer_id)try{await this.reconcileCustomer(String(savedCustomer.rows[0].provider_customer_id));}catch{throw new CommandError(503,'BILLING_RECONCILIATION_REQUIRED');}
    const begun = await this.beginOperation(userId,'checkout',idempotencyKey,{...input});
    const operation=begun.operation;if(!operation)throw new Error('Billing operation insert returned no row');
    const previous = resultJson<{url:string;expiresAt:string}>(operation.result);
    if (operation.status === 'succeeded' && previous) return { url:previous.url };
    if (operation.status === 'failed') throw new CommandError(409, 'BILLING_OPERATION_FAILED');
    if (!begun.created) throw new CommandError(503,'BILLING_OPERATION_UNCERTAIN','The original checkout is being reconciled. Retry with the same idempotency key.');
    try {
      const customerId = await this.customer(userId,String(operation.id),idempotencyKey);
      const successUrl = `${this.config.appOrigin}/subscribe/return`;
      const cancelUrl = `${this.config.appOrigin}/subscribe/return`;
      const session = await this.port.createCheckout({userId,customerId,plan,successUrl,cancelUrl,idempotencyKey:`${idempotencyKey}:checkout`});
      if (!session.url.startsWith('https://') && !session.url.startsWith(`${this.config.appOrigin}/`)) throw new Error('Unsafe provider checkout URL');
      const response = {url:session.url,expiresAt:session.expiresAt.toISOString(),pendingWebhook:true};
      await this.updateOperation(String(operation.id),'succeeded',session.sessionId,response);
      return {url:session.url};
    } catch (error) {
      if (error instanceof CommandError && ['TERMS_ACCEPTANCE_REQUIRED','ALREADY_PRO','ALREADY_SUBSCRIBED','CHECKOUT_ALREADY_PENDING'].includes(error.code)) {
        await this.updateOperation(String(operation.id),'failed',null,undefined,error.code);
        throw error;
      }
      await this.updateOperation(String(operation.id),'uncertain',null,undefined,'PROVIDER_WRITE_UNCERTAIN');
      throw new CommandError(503,'BILLING_OPERATION_UNCERTAIN','Checkout status is being reconciled. Retry with the same idempotency key.');
    }
  }

  async createPortal(userId: string, idempotencyKey: string) {
    const begun = await this.beginOperation(userId,'portal',idempotencyKey,{});
    const operation=begun.operation;if(!operation)throw new Error('Billing operation insert returned no row');
    const existing = resultJson<{url:string}>(operation.result);
    if (operation.status === 'succeeded' && existing) return {url:existing.url};
    if (operation.status === 'failed') throw new CommandError(409,'BILLING_OPERATION_FAILED');
    if (!begun.created) throw new CommandError(503,'BILLING_OPERATION_UNCERTAIN','The original portal session is being reconciled. Retry with the same idempotency key.');
    try {
      const customer = await withActorTransaction(this.pool,userId,async tx => {
        const row=await tx.query('SELECT provider_customer_id FROM billing_customer WHERE user_id=$1 AND provider_account=$2 AND mode=$3',[userId,this.databaseAccount,this.port.mode]);
        if(!row.rows[0])throw new CommandError(404,'BILLING_CUSTOMER_NOT_FOUND');return String(row.rows[0].provider_customer_id);
      });
      const result=await this.port.createPortal({customerId:customer,returnUrl:`${this.config.appOrigin}/app/billing`,idempotencyKey:`${idempotencyKey}:portal`});
      const response={url:result.url};await this.updateOperation(String(operation.id),'succeeded',null,response);return response;
    } catch(error) {
      if(error instanceof CommandError)throw error;
      await this.updateOperation(String(operation.id),'uncertain',null,undefined,'PROVIDER_WRITE_UNCERTAIN');
      throw new CommandError(503,'BILLING_OPERATION_UNCERTAIN','Portal status is being reconciled. Retry with the same idempotency key.');
    }
  }

  async receiveWebhook(rawBody: Uint8Array, signatureHeader?: string) {
    let event: NormalizedBillingEvent;
    try { event=await this.port.verifyWebhook(rawBody,signatureHeader); }
    catch { throw new CommandError(400,'INVALID_WEBHOOK_SIGNATURE'); }
    this.checkScope(event);
    const inserted=await withTransaction(this.pool,async tx=>{
      const result=await tx.query(`INSERT INTO billing_event(id,provider_account,mode,event_id,signature_verified_at,reconciliation_status,event_type,
        object_status,provider_customer_id,provider_subscription_id,provider_invoice_id,payment_id,created_at,reason)
        VALUES($1,$2,$3,$4,now(),'received',$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(provider_account,mode,event_id) DO NOTHING RETURNING id`,
      [randomUUID(),this.databaseAccount,event.mode,event.eventId,event.type,event.objectStatus,event.customerId,event.subscriptionId,event.invoiceId,event.paymentId,event.createdAt,event.reason]);
      if(!result.rowCount){const old=await tx.query('SELECT reconciliation_status FROM billing_event WHERE provider_account=$1 AND mode=$2 AND event_id=$3',[this.databaseAccount,event.mode,event.eventId]);return {duplicate:true,id:null as string|null,status:old.rows[0]?.reconciliation_status};}
      const id=result.rows[0]?.id;if(!id)throw new Error('Billing event insert returned no id');
      return {duplicate:false,id:String(id),status:'received'};
    });
    if(inserted.duplicate&&inserted.status==='reconciled')return {received:true,duplicate:true,reconciled:true};
    if(inserted.duplicate&&!inserted.id)return {received:true,duplicate:true,reconciled:false};
    try {
      if(event.customerId) await this.reconcileCustomer(event.customerId,event);
      await withTransaction(this.pool,async tx=>tx.query(`UPDATE billing_event SET reconciliation_status='reconciled',reconciled_at=now(),reason=NULL
        WHERE provider_account=$1 AND mode=$2 AND event_id=$3`,[this.databaseAccount,event.mode,event.eventId]));
      return {received:true,duplicate:inserted.duplicate,reconciled:true};
    } catch {
      await withTransaction(this.pool,async tx=>tx.query(`UPDATE billing_event SET reconciliation_status='failed',reason='RECONCILIATION_PENDING',attempts=LEAST(attempts+1,5),next_attempt_at=now()+interval '1 minute'*LEAST(60,GREATEST(attempts+1,1))
        WHERE provider_account=$1 AND mode=$2 AND event_id=$3`,[this.databaseAccount,event.mode,event.eventId]));
      return {received:true,duplicate:inserted.duplicate,reconciled:false};
    }
  }

  private async reconcileCustomer(customerId: string, sourceEvent?: NormalizedBillingEvent) {
    const owner=await withTransaction(this.pool,async tx=>{
      const row=await tx.query('SELECT user_id FROM billing_customer WHERE provider_customer_id=$1 AND provider_account=$2 AND mode=$3',[customerId,this.databaseAccount,this.port.mode]);
      return row.rows[0]?.user_id ? String(row.rows[0].user_id) : null;
    });
    if(!owner)return false;
    return withTransaction(this.pool,async tx=>{
      const lockKey=`billing-reconcile:${this.databaseAccount}:${this.port.mode}:${owner}`;
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lockKey]);
      const state=await this.port.getCustomerState({customerId});this.checkScope(state);
      if(state.customerId!==customerId)throw new Error('Provider customer mismatch');
      return this.applyProviderState(owner,state,sourceEvent,tx);
    });
  }

  private async applyProviderState(userId: string,state: ProviderCustomerState, sourceEvent?: NormalizedBillingEvent, transaction?:Transaction) {
    if(!UUID.test(userId))throw new Error('Invalid provider owner');
    for(const item of state.subscriptions){
      this.checkScope(item);
      if(item.customerId!==state.customerId || (item.userId && item.userId!==userId))throw new Error('Provider subscription scope mismatch');
    }
    for(const invoice of state.invoices){
      this.checkScope(invoice);if(invoice.customerId!==state.customerId||!Number.isSafeInteger(invoice.amountDue)||!Number.isSafeInteger(invoice.amountPaid)||invoice.amountDue<0||invoice.amountPaid<0)throw new Error('Provider invoice invalid');
    }
    for(const refund of state.refunds){this.checkScope(refund);if(!refund.paymentId||!Number.isSafeInteger(refund.amountMinor)||refund.amountMinor<1)throw new Error('Provider refund invalid');}
    for(const dispute of state.disputes){this.checkScope(dispute);if(!dispute.paymentId||!Number.isSafeInteger(dispute.amountMinor)||dispute.amountMinor<0)throw new Error('Provider dispute invalid');}
    const apply=async(tx:Transaction)=>{
      await lockOwner(tx,userId);
      const previous=await tx.query(`SELECT plan,valid_until FROM subscription_entitlement WHERE user_id=$1 AND provider_account=$2 AND provider_mode=$3 FOR UPDATE`,[userId,this.databaseAccount,this.port.mode]);
      const before=previous.rows[0]?.plan==='pro'?'pro':'free';
      const oldSubs=await tx.query(`SELECT provider_subscription_id,grace_until,paid_through,provider_status,cancel_at_period_end FROM subscription WHERE user_id=$1 AND provider_account=$2 AND mode=$3`,[userId,this.databaseAccount,this.port.mode]);
      const graceById=new Map(oldSubs.rows.map(row=>[String(row.provider_subscription_id),row.grace_until?new Date(row.grace_until):null]));
      const priorPaidById=new Map(oldSubs.rows.map(row=>[String(row.provider_subscription_id),row.paid_through?new Date(row.paid_through):null]));
      const oldStatusById=new Map(oldSubs.rows.map(row=>[String(row.provider_subscription_id),String(row.provider_status)]));
      const nextDecisions: {provider:ProviderSubscription;decision:ReturnType<typeof entitlementFor>}[]=[];
      for(const providerSub of state.subscriptions){
        let firstFailureAt:Date|null=null;
        let lastRecoveredAt:Date|null=null;
        if(providerSub.status.toLowerCase()==='past_due'){
          const failed=await tx.query(`SELECT (SELECT min(e.created_at) FROM billing_event e WHERE e.provider_account=$1 AND e.mode=$2
            AND e.provider_subscription_id=$3 AND e.event_type IN ('invoice.payment_failed','invoice.payment_action_required')
            AND e.created_at>COALESCE((SELECT max(r.created_at) FROM billing_event r WHERE r.provider_account=$1 AND r.mode=$2
              AND r.provider_subscription_id=$3 AND (r.object_status IN ('active','trialing') OR r.event_type IN ('invoice.paid','customer.subscription.resumed'))),'-infinity'::timestamptz)) AS first_failed_at,
            (SELECT max(r.created_at) FROM billing_event r WHERE r.provider_account=$1 AND r.mode=$2 AND r.provider_subscription_id=$3
              AND (r.object_status IN ('active','trialing') OR r.event_type IN ('invoice.paid','customer.subscription.resumed'))) AS recovered_at`,[this.databaseAccount,this.port.mode,providerSub.subscriptionId]);
          firstFailureAt=failed.rows[0]?.first_failed_at?new Date(failed.rows[0].first_failed_at):null;
          lastRecoveredAt=failed.rows[0]?.recovered_at?new Date(failed.rows[0].recovered_at):null;
          if(!firstFailureAt&&sourceEvent?.subscriptionId===providerSub.subscriptionId&&sourceEvent.objectStatus?.toLowerCase()==='past_due')firstFailureAt=sourceEvent.createdAt;
        }
        let priorGrace=graceById.get(providerSub.subscriptionId)??null;
        const previousFailureAt=priorGrace?new Date(priorGrace.getTime()-72*60*60*1000):null;
        if(providerSub.status.toLowerCase()==='past_due'&&priorGrace&&firstFailureAt&&previousFailureAt&&firstFailureAt>previousFailureAt)priorGrace=null;
        if(['active','trialing','canceled','cancelled','unpaid','incomplete_expired'].includes(providerSub.status.toLowerCase())
          &&lastRecoveredAt)priorGrace=null;
        const paidInvoiceEnds=state.invoices.filter(invoice=>invoice.subscriptionId===providerSub.subscriptionId&&invoice.amountPaid>0&&invoice.status.toLowerCase()==='paid'&&invoice.periodEnd)
          .map(invoice=>invoice.periodEnd as Date);
        const oldPaidThrough=priorPaidById.get(providerSub.subscriptionId)??null;
        const evidencePaidThrough=[providerSub.paidThrough,oldPaidThrough,...paidInvoiceEnds].filter((value):value is Date=>Boolean(value)).sort((a,b)=>b.getTime()-a.getTime())[0]??null;
        const activeStatus=['active','trialing'].includes(providerSub.status.toLowerCase());
        const actualPaidThrough=activeStatus ? (providerSub.currentPeriodEnd??evidencePaidThrough) : evidencePaidThrough;
        const decision=entitlementFor(providerSub,priorGrace,actualPaidThrough,new Date(),firstFailureAt);
        nextDecisions.push({provider:providerSub,decision});
        const plan=providerSub.plan;
        const saved=await tx.query(`INSERT INTO subscription(id,user_id,provider_customer_id,provider_subscription_id,mode,provider_status,provider_version,paid_through,grace_until,
          plan,interval,current_period_start,current_period_end,cancel_at_period_end,canceled_at,provider_account,last_reconciled_at,reason)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),$17)
          ON CONFLICT(provider_account,mode,provider_subscription_id) DO UPDATE SET provider_customer_id=EXCLUDED.provider_customer_id,provider_status=EXCLUDED.provider_status,
          provider_version=EXCLUDED.provider_version,paid_through=EXCLUDED.paid_through,grace_until=EXCLUDED.grace_until,plan=EXCLUDED.plan,interval=EXCLUDED.interval,
          current_period_start=EXCLUDED.current_period_start,current_period_end=EXCLUDED.current_period_end,cancel_at_period_end=EXCLUDED.cancel_at_period_end,canceled_at=EXCLUDED.canceled_at,last_reconciled_at=now(),reason=EXCLUDED.reason
          WHERE subscription.user_id=EXCLUDED.user_id RETURNING id`, [randomUUID(),userId,state.customerId,providerSub.subscriptionId,providerSub.mode,providerSub.status,sourceEvent?.eventId??`state:${Date.now()}`,
          actualPaidThrough,decision.graceUntil,plan,intervalFor(plan),providerSub.currentPeriodStart,providerSub.currentPeriodEnd,providerSub.cancelAtPeriodEnd,providerSub.canceledAt,this.databaseAccount,providerSub.reason]);
        if(!saved.rowCount)throw new Error('Provider subscription belongs to a different local account');
      }
      const paidInvoices: string[]=[];
      for(const invoice of state.invoices){
        if(invoice.currency.toLowerCase()!=='usd')continue;
        const beforeInvoice=await tx.query('SELECT status FROM billing_invoice WHERE provider_account=$1 AND mode=$2 AND provider_invoice_id=$3',[this.databaseAccount,this.port.mode,invoice.invoiceId]);
        await tx.query(`INSERT INTO billing_invoice(id,user_id,provider_account,mode,provider_invoice_id,provider_subscription_id,status,amount_due,amount_paid,currency,created_at,period_start,period_end,hosted_invoice_url,payment_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'usd',$10,$11,$12,$13,$14)
          ON CONFLICT(provider_account,mode,provider_invoice_id) DO UPDATE SET status=EXCLUDED.status,amount_due=EXCLUDED.amount_due,amount_paid=EXCLUDED.amount_paid,
          period_start=EXCLUDED.period_start,period_end=EXCLUDED.period_end,hosted_invoice_url=EXCLUDED.hosted_invoice_url,payment_id=EXCLUDED.payment_id
          WHERE billing_invoice.user_id=EXCLUDED.user_id`,[randomUUID(),userId,this.databaseAccount,this.port.mode,invoice.invoiceId,invoice.subscriptionId,invoice.status,invoice.amountDue,invoice.amountPaid,invoice.createdAt,invoice.periodStart,invoice.periodEnd,invoice.hostedInvoiceUrl,invoice.paymentId]);
        if(invoice.status.toLowerCase()==='paid'&&beforeInvoice.rows[0]?.status?.toLowerCase()!=='paid')paidInvoices.push(invoice.invoiceId);
      }
      await tx.query('UPDATE billing_customer SET last_reconciled_at=now() WHERE user_id=$1 AND provider_account=$2 AND mode=$3',[userId,this.databaseAccount,this.port.mode]);
      for(const refund of state.refunds){
        const refundSubscription=state.invoices.find(item=>item.paymentId===refund.paymentId)?.subscriptionId;
        if(!refundSubscription)continue;
        const previousRefund=await tx.query('SELECT status FROM billing_refund WHERE provider_account=$1 AND mode=$2 AND provider_refund_id=$3',[this.databaseAccount,this.port.mode,refund.refundId]);
        await tx.query(`INSERT INTO billing_refund(id,user_id,provider_account,mode,provider_subscription_id,payment_id,provider_refund_id,amount,status,reason,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(provider_account,mode,provider_refund_id) DO UPDATE SET status=EXCLUDED.status
          WHERE billing_refund.user_id=EXCLUDED.user_id`,[randomUUID(),userId,this.databaseAccount,this.port.mode,
          refundSubscription,refund.paymentId,refund.refundId,refund.amountMinor,refund.status,refund.reason??'',refund.createdAt]);
        if(previousRefund.rows[0]?.status!==refund.status)await enqueueTransactionalNotification(tx,{recipientUserId:userId,category:'billing',sourceId:null,internalUrl:'/app/billing',text:'A refund status changed. Review billing details for the latest information.'});
      }
      for(const dispute of state.disputes){
        const disputeSubscription=state.invoices.find(item=>item.paymentId===dispute.paymentId)?.subscriptionId;
        if(!disputeSubscription)continue;
        const previousDispute=await tx.query('SELECT status FROM billing_dispute WHERE provider_account=$1 AND mode=$2 AND provider_dispute_id=$3',[this.databaseAccount,this.port.mode,dispute.disputeId]);
        await tx.query(`INSERT INTO billing_dispute(id,user_id,provider_account,mode,provider_dispute_id,provider_subscription_id,payment_id,amount_minor,status,reason,created_at,resolved_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(provider_account,mode,provider_dispute_id) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,resolved_at=EXCLUDED.resolved_at
          WHERE billing_dispute.user_id=EXCLUDED.user_id`,[randomUUID(),userId,this.databaseAccount,this.port.mode,dispute.disputeId,
          disputeSubscription,dispute.paymentId,dispute.amountMinor,dispute.status,dispute.reason,dispute.createdAt,dispute.resolvedAt]);
        if(previousDispute.rows[0]?.status!==dispute.status)await enqueueTransactionalNotification(tx,{recipientUserId:userId,category:'billing',sourceId:null,internalUrl:'/app/billing',text:'A payment dispute status changed. Review billing details for the latest information.'});
      }
      for(let index=0;index<paidInvoices.length;index++)await enqueueTransactionalNotification(tx,{recipientUserId:userId,category:'billing',sourceId:null,internalUrl:'/app/billing',text:'A billing payment was received.',email:{subject:'Payment received',title:'Payment received',body:'A billing payment was received. You can review the invoice in account settings.'}});
      const active=nextDecisions.filter(row=>row.decision.plan==='pro').sort((a,b)=>(b.decision.validUntil?.getTime()??0)-(a.decision.validUntil?.getTime()??0))[0];
      if(!active&&state.subscriptions.length===0){
        await tx.query(`UPDATE subscription_entitlement SET plan='free',valid_from=now(),valid_until=NULL,provider_account=$2,provider_mode=$3 WHERE user_id=$1`,[userId,this.databaseAccount,this.port.mode]);
      } else {
        const target=active;
        if(target){
          const limits={journalMonthly:1000,watchlists:10,watchlistItems:100,layouts:10};
          await tx.query(`INSERT INTO subscription_entitlement(id,user_id,plan,limits,valid_from,valid_until,provider_account,provider_mode)
            VALUES($1,$2,$3,$4::jsonb,now(),$5,$6,$7) ON CONFLICT(user_id) DO UPDATE SET plan=EXCLUDED.plan,limits=EXCLUDED.limits,
            valid_from=EXCLUDED.valid_from,valid_until=EXCLUDED.valid_until,provider_account=EXCLUDED.provider_account,provider_mode=EXCLUDED.provider_mode`,
          [randomUUID(),userId,'pro',JSON.stringify(limits),target.decision.validUntil,this.databaseAccount,this.port.mode]);
        }else{
          await tx.query(`INSERT INTO subscription_entitlement(id,user_id,plan,limits,valid_from,valid_until,provider_account,provider_mode)
            VALUES($1,$2,'free',$3::jsonb,now(),NULL,$4,$5) ON CONFLICT(user_id) DO UPDATE SET plan='free',limits=EXCLUDED.limits,
            valid_from=EXCLUDED.valid_from,valid_until=NULL,provider_account=EXCLUDED.provider_account,provider_mode=EXCLUDED.provider_mode`,
          [randomUUID(),userId,JSON.stringify({journalMonthly:30,watchlists:1,watchlistItems:25,layouts:1}),this.databaseAccount,this.port.mode]);
        }
      }
      const after=active?'pro':'free';
      if(before!==after){
        const transitionId=sourceEvent?.eventId??`projection:${this.databaseAccount}:${this.port.mode}:${userId}:${hash({before,after,subscriptions:state.subscriptions.map(item=>[item.subscriptionId,item.status,item.currentPeriodEnd?.toISOString()??null,item.paidThrough?.toISOString()??null,item.firstFailureAt?.toISOString()??null]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))})}`;
        await recordProductEvent(tx,userId,after==='pro'?'conversion':'churn',transitionId,{plan:after});
        await enqueueTransactionalNotification(tx,{recipientUserId:userId,category:'billing',sourceId:null,internalUrl:'/app/billing',
          text:after==='pro'?'Your Pro access is active.':'Your Pro access ended. Your saved records remain available.',
          email:{subject:after==='pro'?'Pro is active':'Pro access ended',title:after==='pro'?'Your Pro plan is active':'Your plan changed',body:after==='pro'?'Your Pro plan is active. You can review billing details in account settings.':'Your Pro access ended. Your saved records remain available.'}});
      }
      for(const {provider,decision} of nextDecisions){
        const oldStatus=oldStatusById.get(provider.subscriptionId)?.toLowerCase();
        const nextStatus=provider.status.toLowerCase();
        if(oldStatus!==nextStatus&&['past_due','canceled','cancelled','unpaid'].includes(nextStatus)){
          const title=nextStatus==='past_due'?'Payment needs attention':'Subscription status changed';
          const body=nextStatus==='past_due'?'A payment needs attention. Your billing grace period is limited.':'Your subscription status changed. Review billing details for current access.';
          await enqueueTransactionalNotification(tx,{recipientUserId:userId,category:'billing',sourceId:null,internalUrl:'/app/billing',text:body,
            email:{subject:title,title,body}});
        }
        if(oldStatus==='past_due'&&['active','trialing'].includes(nextStatus)){
          await enqueueTransactionalNotification(tx,{recipientUserId:userId,category:'billing',sourceId:null,internalUrl:'/app/billing',text:'Your payment is current and Pro access is active.',
            email:{subject:'Payment received',title:'Your payment is current',body:'Your payment is current and Pro access is active.'}});
        }
        void decision;
      }
      return {userId,plan:after};
    };
    return transaction?apply(transaction):withTransaction(this.pool,apply);
  }

  async reconcilePendingOperations(limit=5) {
    if(!Number.isInteger(limit)||limit<1||limit>20)throw new CommandError(400,'INVALID_BATCH_LIMIT');
    const perKind=Math.max(1,Math.floor(limit/3));let attempted=0,reconciled=0;
    const pending=await withTransaction(this.pool,async tx=>tx.query(`WITH claimed AS (SELECT id FROM billing_operation
      WHERE provider_account=$2 AND mode=$3 AND (status IN ('pending','uncertain') OR (status='processing' AND updated_at<now()-interval '5 minutes'))
      AND attempts<5 AND next_attempt_at<=now()
      ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT $1)
      UPDATE billing_operation o SET status='processing',updated_at=now(),attempts=o.attempts+1 FROM claimed c WHERE o.id=c.id
      RETURNING o.id,o.user_id,o.kind,o.idempotency_key,o.provider_ref,o.status,o.result,o.attempts,o.created_at`,[perKind,this.databaseAccount,this.port.mode]));
    for(const operation of pending.rows){
      attempted++;
      try{
        const user=String(operation.user_id);
        const customer=await withTransaction(this.pool,async tx=>tx.query('SELECT provider_customer_id FROM billing_customer WHERE user_id=$1 AND provider_account=$2 AND mode=$3',[user,this.databaseAccount,this.port.mode]));
        const saved=resultJson<Record<string,unknown>>(operation.result);
        if(operation.kind==='checkout'){
          if(!saved||saved.plan!=='pro'||!['monthly','annual'].includes(String(saved.interval)))throw new Error('Missing persisted checkout request');
          const customerId=customer.rows[0]?.provider_customer_id?String(customer.rows[0].provider_customer_id):await this.customer(user,String(operation.id),String(operation.idempotency_key));
          if(customer.rows[0])await this.reconcileCustomer(customerId);
          const createdAt=new Date(operation.created_at).getTime();
          if(!Number.isFinite(createdAt)||Date.now()-createdAt>24*60*60*1000||Number(operation.attempts)>=5)throw new Error('Checkout requires manual provider review');
          const plan:BillingPlan=saved.interval==='monthly'?'pro_month':'pro_year';
          const session=await this.port.createCheckout({userId:user,customerId,plan,successUrl:`${this.config.appOrigin}/subscribe/return`,cancelUrl:`${this.config.appOrigin}/subscribe/return`,idempotencyKey:`${String(operation.idempotency_key)}:checkout`});
          await this.updateOperation(String(operation.id),'succeeded',session.sessionId,{url:session.url,expiresAt:session.expiresAt.toISOString(),pendingWebhook:true});
        }else if(operation.kind==='portal'){
          if(!customer.rows[0]?.provider_customer_id)throw new Error('Missing customer for portal recovery');
          const createdAt=new Date(operation.created_at).getTime();
          if(!Number.isFinite(createdAt)||Date.now()-createdAt>24*60*60*1000||Number(operation.attempts)>=5)throw new Error('Portal session requires manual provider review');
          const result=await this.port.createPortal({customerId:String(customer.rows[0].provider_customer_id),returnUrl:`${this.config.appOrigin}/app/billing`,idempotencyKey:`${String(operation.idempotency_key)}:portal`});
          await this.updateOperation(String(operation.id),'succeeded',null,result);
        }else{
          const request=saved??{};
          const actorUserId=typeof request.actorUserId==='string'?request.actorUserId:'';
          const subscriptionId=typeof request.subscriptionId==='string'?request.subscriptionId:'';
          const action=String(request.action??operation.kind);
          const reason=typeof request.reason==='string'?request.reason:'';
          const customerId=customer.rows[0]?.provider_customer_id?String(customer.rows[0].provider_customer_id):'';
          if(!actorUserId||!subscriptionId||!reason||!customerId)throw new Error('Missing persisted admin operation context');
          if(action==='reconcile'){
            await this.reconcileCustomer(customerId);
            await this.completeAdminOperation(String(operation.id),actorUserId,subscriptionId,'reconcile',reason,null,operation.provider_ref?String(operation.provider_ref):null);
          }else if(action==='cancel'||action==='refund'){
            await this.reconcileCustomer(customerId);
            const state=await this.port.getCustomerState({customerId});this.checkScope(state);
            const providerSubscriptionId=String(request.providerSubscriptionId??'');
            const subscription=state.subscriptions.find(item=>item.subscriptionId===providerSubscriptionId&&item.customerId===customerId);
            if(!subscription)throw new Error('Provider subscription no longer confirms the target');
            let paymentId: string|null=null;
            if(action==='refund'){
              const requestedPaymentId=String(request.paymentId??'');
              const amountMinor=Number(request.amountMinor);
              const providerRefund=state.refunds.find(item=>item.operationId===String(operation.id)&&item.paymentId===requestedPaymentId);
              if(providerRefund){
                const invoice=state.invoices.find(item=>item.paymentId===providerRefund.paymentId&&item.subscriptionId===providerSubscriptionId);
                if(!invoice||providerRefund.amountMinor!==amountMinor)throw new Error('Provider refund does not match persisted operation details');
                await withTransaction(this.pool,async tx=>tx.query(`INSERT INTO billing_refund(id,user_id,provider_account,mode,provider_subscription_id,payment_id,provider_refund_id,amount,status,reason,created_at)
                  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(provider_account,mode,provider_refund_id) DO UPDATE SET status=EXCLUDED.status
                  WHERE billing_refund.user_id=EXCLUDED.user_id`,[randomUUID(),operation.user_id,this.databaseAccount,this.port.mode,providerSubscriptionId,requestedPaymentId,providerRefund.refundId,providerRefund.amountMinor,providerRefund.status,reason,providerRefund.createdAt]));
                paymentId=requestedPaymentId;
              }else{
                const createdAt=new Date(operation.created_at).getTime();
                if(!Number.isFinite(createdAt)||Date.now()-createdAt>24*60*60*1000||Number(operation.attempts)>=5)throw new Error('Refund requires manual provider review');
                const providerIdempotencyKey=String(request.providerIdempotencyKey??'');
                if(!providerIdempotencyKey)throw new Error('Missing persisted refund idempotency key');
                const response=await this.port.refund({customerId,subscriptionId:providerSubscriptionId,paymentId:String(requestedPaymentId),operationId:String(operation.id),amountMinor,reason:'requested_by_customer',idempotencyKey:providerIdempotencyKey});
                paymentId=requestedPaymentId;
                await this.reconcileCustomer(customerId);
                const confirmed=await this.port.getCustomerState({customerId});
                const refund=confirmed.refunds.find(item=>item.refundId===response.refundId&&item.operationId===String(operation.id)&&item.paymentId===requestedPaymentId);
                if(!refund||refund.amountMinor!==amountMinor)throw new Error('Refund write is not yet confirmed by provider truth');
              }
            }
            if(action==='cancel'||Boolean(request.cancelSubscription)){
              if(!subscription.cancelAtPeriodEnd&&subscription.status.toLowerCase()!=='canceled'&&subscription.status.toLowerCase()!=='cancelled'){
                const createdAt=new Date(operation.created_at).getTime();
                if(!Number.isFinite(createdAt)||Date.now()-createdAt>24*60*60*1000||Number(operation.attempts)>=5)throw new Error('Cancellation requires manual provider review');
                const providerIdempotencyKey=String(request.cancelIdempotencyKey??'');if(!providerIdempotencyKey)throw new Error('Missing persisted cancellation idempotency key');
                await this.port.cancelSubscription({subscriptionId:providerSubscriptionId,atPeriodEnd:true,idempotencyKey:providerIdempotencyKey});
                await this.reconcileCustomer(customerId);
                const confirmed=await this.port.getCustomerState({customerId});
                const canceled=confirmed.subscriptions.find(item=>item.subscriptionId===providerSubscriptionId);
                if(!canceled?.cancelAtPeriodEnd&&canceled?.status.toLowerCase()!=='canceled'&&canceled?.status.toLowerCase()!=='cancelled')throw new Error('Cancellation is not yet confirmed by provider truth');
              }
            }
            await this.completeAdminOperation(String(operation.id),actorUserId,subscriptionId,action as 'refund'|'cancel',reason,paymentId,operation.provider_ref?String(operation.provider_ref):null);
          }else throw new Error('Unknown durable billing operation');
        }
        reconciled++;
      }catch{await this.updateOperation(String(operation.id),'uncertain',operation.provider_ref?String(operation.provider_ref):null,undefined,'RECOVERY_PENDING');}
    }
    const failedEvents=await withTransaction(this.pool,async tx=>tx.query(`SELECT event_id,provider_customer_id FROM billing_event WHERE provider_account=$1 AND mode=$2
      AND reconciliation_status IN ('received','failed') AND attempts<5 AND next_attempt_at<=now() ORDER BY created_at,event_id LIMIT $3`,[this.databaseAccount,this.port.mode,Math.min(perKind,limit-attempted)]));
    for(const row of failedEvents.rows){if(attempted>=limit)break;attempted++;try{if(row.provider_customer_id)await this.reconcileCustomer(String(row.provider_customer_id));await withTransaction(this.pool,async tx=>tx.query(`UPDATE billing_event SET reconciliation_status='reconciled',reconciled_at=now(),reason=NULL WHERE provider_account=$1 AND mode=$2 AND event_id=$3`,[this.databaseAccount,this.port.mode,row.event_id]));reconciled++;}catch{await withTransaction(this.pool,async tx=>tx.query(`UPDATE billing_event SET reconciliation_status='failed',reason='RECONCILIATION_PENDING',attempts=LEAST(attempts+1,5),next_attempt_at=now()+interval '1 minute'*LEAST(60,GREATEST(attempts+1,1)) WHERE provider_account=$1 AND mode=$2 AND event_id=$3`,[this.databaseAccount,this.port.mode,row.event_id]));}}
    const remaining=limit-attempted;
    if(remaining>0){
      const customers=await withTransaction(this.pool,async tx=>tx.query(`SELECT c.provider_customer_id FROM billing_customer c LEFT JOIN subscription s ON s.user_id=c.user_id AND s.provider_account=c.provider_account AND s.mode=c.mode
        WHERE c.provider_account=$1 AND c.mode=$2 AND (c.last_reconciled_at IS NULL OR c.last_reconciled_at<now()-interval '5 minutes')
        GROUP BY c.user_id,c.provider_customer_id,c.last_reconciled_at ORDER BY c.last_reconciled_at NULLS FIRST LIMIT $3`,[this.databaseAccount,this.port.mode,Math.min(perKind,remaining)]));
      for(const row of customers.rows){if(attempted>=limit)break;attempted++;try{await this.reconcileCustomer(String(row.provider_customer_id));reconciled++;}catch{}}
    }
    return {reconciled};
  }

  async adminListSubscriptions(actorUserId:string,rawCursor?:unknown,rawLimit?:unknown,rawQuery?:unknown){
    requireUuid(actorUserId);const limit=rawLimit===undefined?20:Number(rawLimit);if(!Number.isInteger(limit)||limit<1||limit>50)throw new CommandError(400,'INVALID_PAGE_LIMIT');
    const search=typeof rawQuery==='string'?rawQuery.trim().replace(/\s+/g,' ').slice(0,200):'';
    let after:{at:string;id:string}|null=null;
    if(rawCursor!==undefined&&rawCursor!=='')try{if(typeof rawCursor!=='string'||rawCursor.length>500)throw new Error();const value=JSON.parse(Buffer.from(rawCursor,'base64url').toString());if(value.v!==1||value.search!==search||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.at)||!UUID.test(value.id))throw new Error();after=value;}catch{throw new CommandError(400,'INVALID_CURSOR');}
    return withActorTransaction(this.pool,actorUserId,async tx=>{
      await this.requireAdmin(tx,actorUserId);
      const rows=await tx.query(`SELECT s.id,s.user_id,s.provider_subscription_id,s.provider_status,s.provider_account,s.mode,s.plan,s.paid_through,s.grace_until,
        s.cancel_at_period_end,s.last_reconciled_at,s.reason,p.handle,p.display_name,p.avatar_media_id,p.bio,
        e.plan AS entitlement_plan,e.valid_from,e.valid_until,to_char(COALESCE(s.last_reconciled_at,s.current_period_end,s.paid_through,s.canceled_at)::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
        FROM subscription s JOIN user_account u ON u.id=s.user_id LEFT JOIN profile p ON p.user_id=u.id LEFT JOIN subscription_entitlement e ON e.user_id=u.id AND e.provider_account=s.provider_account AND e.provider_mode=s.mode
        WHERE s.provider_account=$1 AND s.mode=$2 AND ($3::text='' OR p.handle ILIKE '%'||$3||'%' OR p.display_name ILIKE '%'||$3||'%' OR s.provider_subscription_id ILIKE '%'||$3||'%')
        AND ($4::timestamptz IS NULL OR (COALESCE(s.last_reconciled_at,s.current_period_end,s.paid_through,s.canceled_at),s.id)<($4::timestamptz,$5::uuid))
        ORDER BY COALESCE(s.last_reconciled_at,s.current_period_end,s.paid_through,s.canceled_at) DESC NULLS LAST,s.id DESC LIMIT $6`,[this.databaseAccount,this.port.mode,search,after?.at??null,after?.id??null,limit+1]);
      const selected=rows.rows.slice(0,limit),items=[];
      for(const row of selected){
        const payments=await tx.query(`SELECT i.payment_id,i.amount_paid,COALESCE(sum(r.amount),0)::int refunded FROM billing_invoice i LEFT JOIN billing_refund r
          ON r.provider_account=i.provider_account AND r.mode=i.mode AND r.payment_id=i.payment_id
          WHERE i.user_id=$1 AND i.provider_account=$2 AND i.mode=$3 AND i.provider_subscription_id=$4 AND i.payment_id IS NOT NULL GROUP BY i.payment_id,i.amount_paid ORDER BY i.payment_id LIMIT 24`,[row.user_id,this.databaseAccount,this.port.mode,row.provider_subscription_id]);
        const paid= row.entitlement_plan==='pro'&&row.valid_until&&new Date(row.valid_from)<=new Date()&&new Date(row.valid_until)>new Date();
        items.push({id:String(row.id),user:{id:String(row.user_id),handle:String(row.handle??'member'),displayName:String(row.display_name??'Member'),avatarUrl:null,pro:paid,bio:String(row.bio??'')},
          entitlement:{plan:paid?'pro':'free',status:providerStatus(row.provider_status),paidThrough:iso(row.paid_through),graceUntil:iso(row.grace_until),limits:{watchlists:paid?10:1,itemsPerWatchlist:paid?100:25,savedLayouts:paid?10:1,newJournalEntriesPerMonth:paid?1000:30}},
          providerSubscriptionId:String(row.provider_subscription_id??'').slice(0,200),mode:String(row.mode),lastReconciledAt:iso(row.last_reconciled_at),provider:this.port.provider,demo:this.port.provider==='fake'&&row.mode==='test',
          interval:intervalFor(planFor(row.plan)),cancelAtPeriodEnd:Boolean(row.cancel_at_period_end),payments:payments.rows.map(p=>({paymentId:String(p.payment_id).slice(0,200),remainingMinor:Math.max(0,Number(p.amount_paid)-Number(p.refunded))}))});
      }
      const last=selected.at(-1);return {items,nextCursor:rows.rows.length>limit&&last?Buffer.from(JSON.stringify({v:1,search,at:last.cursor_at,id:last.id})).toString('base64url'):null};
    });
  }

  private decimalToMinor(value:string){if(typeof value!=='string'||!/^\d{1,8}(?:\.\d{1,2})?$/.test(value))throw new CommandError(422,'INVALID_REFUND_AMOUNT');const [whole,fraction='']=value.split('.');const amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));if(!Number.isSafeInteger(amount)||amount<1)throw new CommandError(422,'INVALID_REFUND_AMOUNT');return amount;}

  async adminBillingAction(actorUserId:string,subscriptionId:string,input:BillingActionInput,idempotencyKey:string){
    requireUuid(actorUserId);requireUuid(subscriptionId);const reason=safeReason(input.reason);if(!reason)throw new CommandError(422,'REASON_REQUIRED');
    if(!['reconcile','refund','cancel'].includes(input.action))throw new CommandError(422,'INVALID_BILLING_ACTION');
    const target=await withActorTransaction(this.pool,actorUserId,async tx=>{
      await this.requireAdmin(tx,actorUserId);
      const row=await tx.query(`SELECT s.*,u.email,c.provider_customer_id FROM subscription s JOIN user_account u ON u.id=s.user_id
        LEFT JOIN billing_customer c ON c.user_id=s.user_id AND c.provider_account=s.provider_account AND c.mode=s.mode
        WHERE s.id=$1 AND s.provider_account=$2 AND s.mode=$3`,[subscriptionId,this.databaseAccount,this.port.mode]);
      if(!row.rows[0])throw new CommandError(404,'SUBSCRIPTION_NOT_FOUND');return row.rows[0];
    });
    const adminOperationKey=`admin:${actorUserId}:${hash(idempotencyKey)}`;
    const op=await this.beginOperation(String(target.user_id),input.action,adminOperationKey,{actorUserId,subscriptionId,action:input.action,reason,paymentId:input.paymentId??null,amount:input.amount??null,cancelSubscription:!!input.cancelSubscription});
    const operation=op.operation;if(!operation)throw new Error('Billing operation insert returned no row');
    if(operation.status==='succeeded')return resultJson(operation.result)??{};
    if(!op.created){if(operation.status==='failed')throw new CommandError(409,'BILLING_OPERATION_FAILED');throw new CommandError(503,'BILLING_OPERATION_UNCERTAIN','The original operation is being reconciled. Retry with the same idempotency key.');}
    let providerWriteStarted=false,providerRef:string|null=null;
    try{
      if(input.action==='reconcile'){
        const customerId=String(target.provider_customer_id??'');if(!customerId)throw new CommandError(409,'BILLING_CUSTOMER_NOT_FOUND');
        await this.reconcileCustomer(customerId);providerRef=String(target.provider_subscription_id);
      }else if(input.action==='cancel'){
        const cancelIdempotencyKey=`${idempotencyKey}:cancel`;
        const operationInput={actorUserId,subscriptionId,action:input.action,reason,providerSubscriptionId:String(target.provider_subscription_id),providerIdempotencyKey:`${idempotencyKey}:refund`,cancelIdempotencyKey,paymentId:null,amountMinor:null,cancelSubscription:true};
        await this.updateOperation(String(operation.id),'pending',null,operationInput);
        providerWriteStarted=true;
        const updated=await this.port.cancelSubscription({subscriptionId:String(target.provider_subscription_id),atPeriodEnd:true,idempotencyKey:cancelIdempotencyKey});
        this.checkScope(updated);await this.reconcileCustomer(updated.customerId);
        providerRef=updated.subscriptionId;
      }else{
        if(typeof input.paymentId!=='string'||!input.paymentId||input.paymentId.length>200)throw new CommandError(422,'PAYMENT_REQUIRED');
        const payment=await withActorTransaction(this.pool,actorUserId,async tx=>tx.query(`SELECT i.amount_paid,i.payment_id FROM billing_invoice i WHERE i.user_id=$1 AND i.provider_account=$2 AND i.mode=$3
          AND i.provider_subscription_id=$4 AND i.payment_id=$5 LIMIT 1`,[target.user_id,this.databaseAccount,this.port.mode,target.provider_subscription_id,input.paymentId]));
        if(!payment.rows[0])throw new CommandError(422,'PAYMENT_SUBSCRIPTION_MISMATCH');
        const prior=await withTransaction(this.pool,async tx=>tx.query(`SELECT COALESCE(sum(amount),0)::int refunded FROM billing_refund WHERE provider_account=$1 AND mode=$2 AND payment_id=$3
          AND status NOT IN ('failed','canceled','cancelled','rejected')`,[this.databaseAccount,this.port.mode,input.paymentId]));
        const remaining=Number(payment.rows[0].amount_paid)-Number(prior.rows[0]?.refunded??0);const amount=input.amount===undefined?remaining:this.decimalToMinor(input.amount);
        if(amount<1||amount>remaining)throw new CommandError(422,'REFUND_EXCEEDS_PAYMENT');
        const operationInput={actorUserId,subscriptionId,action:input.action,reason,paymentId:input.paymentId,amountMinor:amount,cancelSubscription:!!input.cancelSubscription,
          providerSubscriptionId:String(target.provider_subscription_id),providerIdempotencyKey:`${idempotencyKey}:refund`,cancelIdempotencyKey:`${idempotencyKey}:cancel`};
        await this.updateOperation(String(operation.id),'pending',null,operationInput);
        providerWriteStarted=true;
        const response=await this.port.refund({customerId:String(target.provider_customer_id),subscriptionId:String(target.provider_subscription_id),paymentId:input.paymentId,operationId:String(operation.id),amountMinor:amount,reason:'requested_by_customer',idempotencyKey:`${idempotencyKey}:refund`});
        providerRef=response.refundId;
        await withTransaction(this.pool,async tx=>tx.query(`INSERT INTO billing_refund(id,user_id,provider_account,mode,provider_subscription_id,payment_id,provider_refund_id,amount,status,reason,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) ON CONFLICT(provider_account,mode,provider_refund_id) DO NOTHING`,[randomUUID(),target.user_id,this.databaseAccount,this.port.mode,target.provider_subscription_id,input.paymentId,response.refundId,amount,response.status,reason]));
        if(input.cancelSubscription){const canceled=await this.port.cancelSubscription({subscriptionId:String(target.provider_subscription_id),atPeriodEnd:true,idempotencyKey:`${idempotencyKey}:cancel`});this.checkScope(canceled);await this.reconcileCustomer(canceled.customerId);}
      }
      return this.completeAdminOperation(String(operation.id),actorUserId,subscriptionId,input.action,reason,input.paymentId??null,providerRef);
    }catch(error){if(error instanceof CommandError&&!providerWriteStarted){await this.updateOperation(String(operation.id),'failed',null,undefined,error.code);throw error;}await this.updateOperation(String(operation.id),'uncertain',providerRef,undefined,'PROVIDER_WRITE_UNCERTAIN');throw new CommandError(503,'BILLING_OPERATION_UNCERTAIN');}
  }

  async getDemoSession(userId:string,sessionId:string){
    requireUuid(userId);if(typeof sessionId!=='string'||! /^[A-Za-z0-9_-]{1,200}$/.test(sessionId))throw new CommandError(400,'INVALID_ID');
    if(this.port.provider!=='fake'||!this.port.synthetic||!this.port.getFakeSession)throw new CommandError(404,'DEMO_UNAVAILABLE');
    let session;try{session=await this.port.getFakeSession({userId,sessionId});}catch(error){if(error instanceof BillingProviderError&&error.code==='rejected')throw new CommandError(404,'DEMO_SESSION_NOT_FOUND');throw error;}if(!session)throw new CommandError(404,'DEMO_SESSION_NOT_FOUND');
    return {id:session.sessionId,kind:session.kind,status:session.status,interval:intervalFor(planFor(session.plan)),amountMinor:session.amountMinor??(session.plan?planPrice(session.plan).amountMinor:null),currency:'usd',expiresAt:iso(session.expiresAt)};
  }

  async applyDemoAction(userId:string,sessionId:string,action:'complete'|'cancel_checkout'|'cancel'|'resume',idempotencyKey:string){
    requireUuid(userId);if(typeof sessionId!=='string'||! /^[A-Za-z0-9_-]{1,200}$/.test(sessionId))throw new CommandError(400,'INVALID_ID');
    if(this.port.provider!=='fake'||!this.port.synthetic||!this.port.applyDemoAction)throw new CommandError(404,'DEMO_UNAVAILABLE');
    let session;try{session=await this.port.getFakeSession?.({userId,sessionId});}catch(error){if(error instanceof BillingProviderError&&error.code==='rejected')throw new CommandError(404,'DEMO_SESSION_NOT_FOUND');throw error;}if(!session)throw new CommandError(404,'DEMO_SESSION_NOT_FOUND');
    let result;try{result=await this.port.applyDemoAction({userId,sessionId,action,idempotencyKey});}catch(error){if(error instanceof BillingProviderError&&error.code==='rejected')throw new CommandError(409,'DEMO_ACTION_NOT_AVAILABLE');throw error;}
    if(action==='cancel_checkout')await withActorTransaction(this.pool,userId,async tx=>tx.query(`UPDATE billing_operation SET status='failed',reason='CHECKOUT_CANCELED',updated_at=now()
      WHERE user_id=$1 AND provider_account=$2 AND mode=$3 AND provider_ref=$4 AND kind='checkout' AND status='succeeded'`,[userId,this.databaseAccount,this.port.mode,sessionId]));
    const delivery=await this.port.getEventDelivery?.({eventId:result.eventId});if(delivery)await this.receiveWebhook(delivery.rawBody,delivery.signature);
    return {url:`${this.config.appOrigin}${session.kind==='checkout'?'/subscribe/return':'/app/billing'}`};
  }

  async applyServerScenario(userId:string,scenario:'payment_failed'|'unpaid'|'refund'|'renew'|'dispute'|'resolve_dispute'){
    requireUuid(userId);if(!this.config.allowScenarioControls||!this.port.applyScenario)throw new CommandError(404,'DEMO_UNAVAILABLE');
    const result=await this.port.applyScenario({userId,scenario});const delivery=await this.port.getEventDelivery?.({eventId:result.eventId});if(delivery)await this.receiveWebhook(delivery.rawBody,delivery.signature);
    return {eventId:result.eventId};
  }
}
