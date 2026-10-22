import {runPrivacySweep} from './privacy.js';
import {deliverSupportReceipts} from './support-receipts.js';
import { createBillingReconciler } from "./billing-reconciliation.js";
import { PgBoss } from "pg-boss";
import pg from "pg";
import { parseAppConfig,emailSuppressionDigest,assertProductionRuntime,isProductionRuntime } from "@trading/config";
import { writeHeartbeat } from "./heartbeat.js";
import { FilesystemExportStorage, FilesystemStorage,createObjectStores } from "@trading/media";
import { dispatchMediaOutbox, processMediaJob, purgeExpiredUploads, type MediaJob } from "./media.js";
import { assertPublicationSnapshotConfiguration, dispatchPublicationSnapshotOutbox, processPublicationSnapshot, reconcilePublicationSnapshotJobs, type PublicationSnapshotJob } from "./publication-snapshot.js";
import { expireOpenPositions } from "./position-expiry.js";
import { dispatchExportOutbox, processExportJob, purgeExpiredExports, reconcileExportJobs, type ExportJobPayload } from "./exports.js";
import { createSmtpEmailPort } from "./email.js";
import { dispatchSideEffectDeliveries, processEmailDelivery, reconcileSideEffectDeliveries, scheduleDailyDigests, type DeliveryJob } from "./delivery.js";
import { purgeExpiredProductEvents,purgeOperationalReplay } from "./retention.js";
import { createSourceAuthorizer } from "./source-authorization.js";
import { dispatchNotificationOutbox, processNotificationJob, type NotificationJob } from "./notifications.js";

const { Pool } = pg;
const QUEUE = "foundation.heartbeat";
const HEARTBEAT_INTERVAL_MS = 15_000;
const MEDIA_QUEUE = "media.process";
const PUBLICATION_SNAPSHOT_QUEUE = "publication.snapshot";
const EXPORT_QUEUE = "export.generate";
const EMAIL_QUEUE = "email.deliver";
const NOTIFICATION_QUEUE = "notification.fanout";
const POSITION_EXPIRY_INTERVAL_MS = 60_000;
const PUBLICATION_SNAPSHOT_RECOVERY_INTERVAL_MS = 30_000;
const DELIVERY_RECOVERY_INTERVAL_MS = 30_000;
const DIGEST_SCHEDULE_INTERVAL_MS = 60_000;
const PRODUCT_EVENT_PURGE_INTERVAL_MS = 60 * 60_000;

async function run(): Promise<void> {
  assertProductionRuntime(process.env,'worker');
  let connectionString: string;
  try {
    connectionString = parseAppConfig(process.env).databaseUrl;
  } catch {
    console.error("Worker configuration invalid: set a valid DATABASE_URL.");
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 1_500, query_timeout: 1_500 });
  const boss = new PgBoss({ connectionString, connectionTimeoutMillis: 1_500 });
  let emailPort: ReturnType<typeof createSmtpEmailPort> | undefined;
  let deliveryConfig: { appOrigin: string; sessionSecret: string; releaseMode: string; emailFrom: string; authorizeSource: ReturnType<typeof createSourceAuthorizer> } | undefined;
  const objects=process.env.STORAGE_DRIVER==='r2'?createObjectStores(process.env):{
    media:new FilesystemStorage(process.env.LOCAL_OBJECTS_PATH??'/var/lib/options-trade-ideas/objects'),
    exportStorage:new FilesystemExportStorage(process.env.LOCAL_OBJECTS_PATH??'/var/lib/options-trade-ideas/objects')};
  const storage=objects.media,exportStorage=objects.exportStorage;
  pool.on("error", () => console.error("Worker database pool reported an error."));
  let stopping: Promise<void> | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let privacyTimer:NodeJS.Timeout|undefined;
  let mediaTimer: NodeJS.Timeout | undefined;
  let expiryTimer: NodeJS.Timeout | undefined;
  let snapshotRecoveryTimer: NodeJS.Timeout | undefined;
  let exportRecoveryTimer: NodeJS.Timeout | undefined;
  let deliveryRecoveryTimer: NodeJS.Timeout | undefined;
  let digestScheduleTimer: NodeJS.Timeout | undefined;
  let productEventPurgeTimer: NodeJS.Timeout | undefined;
  let billingReconcileTimer: NodeJS.Timeout | undefined;

  const stop = (signal?: string): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (signal) console.info(`Worker stopping (${signal}).`);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if(privacyTimer)clearInterval(privacyTimer);
      if (mediaTimer) clearInterval(mediaTimer);
      if (expiryTimer) clearInterval(expiryTimer);
      if (snapshotRecoveryTimer) clearInterval(snapshotRecoveryTimer);
      if (exportRecoveryTimer) clearInterval(exportRecoveryTimer);
      if (deliveryRecoveryTimer) clearInterval(deliveryRecoveryTimer);
      if (digestScheduleTimer) clearInterval(digestScheduleTimer);
      if (productEventPurgeTimer) clearInterval(productEventPurgeTimer);
      if (billingReconcileTimer) clearInterval(billingReconcileTimer);
      try { await boss.stop({ timeout: 10_000 }); } catch { console.error("Worker queue shutdown failed."); }
      try { emailPort?.close(); } catch { console.error("Worker email transport shutdown failed."); }
      try { await pool.end(); } catch { console.error("Worker database shutdown failed."); }
      console.info("Worker stopped.");
    })();
    return stopping;
  };

  const handleSignal = (signal: NodeJS.Signals) => { void stop(signal); };
  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
  boss.on("error", () => console.error("Worker queue reported an error."));

  try {
    assertPublicationSnapshotConfiguration();
    const releaseMode = (process.env.RELEASE_MODE ?? "local").toLowerCase();
    const sessionSecret = process.env.SESSION_SECRET ?? "";
    const appOrigin = process.env.APP_ORIGIN ?? process.env.WEB_ORIGIN ?? "";
    const emailFrom = process.env.EMAIL_FROM?.trim() ?? "";
    let parsedOrigin: URL;
    try { parsedOrigin = new URL(appOrigin); } catch { throw new Error("APP_ORIGIN_INVALID"); }
    if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash) throw new Error("APP_ORIGIN_INVALID");
    if (sessionSecret.length < 32) throw new Error("SESSION_SECRET_REQUIRED_FOR_DELIVERY");
    if (!emailFrom) throw new Error("EMAIL_FROM_REQUIRED_FOR_DELIVERY");
    const apiOrigin = process.env.PUBLICATION_API_BASE_URL ?? "http://api:3001";
    deliveryConfig = { appOrigin: parsedOrigin.origin, sessionSecret, releaseMode, emailFrom, authorizeSource: createSourceAuthorizer(apiOrigin, sessionSecret) };
    emailPort = createSmtpEmailPort(process.env,async email=>{
      const hash=emailSuppressionDigest(email,process.env.PRIVACY_SUPPRESSION_KEY?.trim()||(process.env.SESSION_SECRET??''));
      return Boolean((await pool.query('SELECT 1 FROM email_address_suppression WHERE email_hash=$1',[hash])).rowCount);
    });
    if(isProductionRuntime(process.env)){
      const fixtures=await pool.query(`SELECT EXISTS(SELECT 1 FROM user_account WHERE synthetic)
        OR EXISTS(SELECT 1 FROM instrument WHERE vendor ILIKE '%synthetic%' OR vendor ILIKE '%fixture%')
        OR EXISTS(SELECT 1 FROM data_capability WHERE supplier ILIKE '%synthetic%' OR agreement_id ILIKE '%fixture%') AS found`);
      if(fixtures.rows[0]?.found!==false)throw new Error('Production worker refuses fixture records.');
    }
    await boss.start();
    await boss.createQueue(QUEUE);
    await boss.createQueue(MEDIA_QUEUE);
    await boss.createQueue(PUBLICATION_SNAPSHOT_QUEUE);
    await boss.createQueue(EXPORT_QUEUE);
    await boss.createQueue(EMAIL_QUEUE);
    await boss.createQueue(NOTIFICATION_QUEUE);
    if((releaseMode==='production'||releaseMode==='public')&&(process.env.PRIVACY_SUPPRESSION_KEY?.length??0)<32)throw new Error('PRIVACY_SUPPRESSION_KEY_REQUIRED');
    if('initialize' in storage)await storage.initialize();
    if('initialize' in exportStorage)await exportStorage.initialize();
    await boss.work(QUEUE, async () => {
      await writeHeartbeat(pool);
    });
    await boss.work<MediaJob>(MEDIA_QUEUE, async jobs => {
      for (const job of jobs) await processMediaJob(pool, storage, job.data, job.retryCount, 5);
    });
    await boss.work<PublicationSnapshotJob>(PUBLICATION_SNAPSHOT_QUEUE, async jobs => {
      for (const job of jobs) await processPublicationSnapshot(pool, storage, job.data, job.retryCount, 5);
    });
    await boss.work<ExportJobPayload>(EXPORT_QUEUE, async jobs => {
      for (const job of jobs) await processExportJob(pool, exportStorage, job.data, job.retryCount, 5);
    });
    await boss.work<DeliveryJob>(EMAIL_QUEUE, async jobs => {
      if (!emailPort || !deliveryConfig) throw new Error("EMAIL_DELIVERY_NOT_CONFIGURED");
      for (const job of jobs) await processEmailDelivery(pool, emailPort, job.data, deliveryConfig);
    });
    await boss.work<NotificationJob>(NOTIFICATION_QUEUE, async jobs => {
      for (const job of jobs) await processNotificationJob(pool, job.data, job.retryCount, 5, new Date(), deliveryConfig?.authorizeSource);
    });
    const enqueue = async () => {
      try {
        await boss.send(QUEUE, { kind: "heartbeat" }, {
          singletonKey: "worker-heartbeat",
          singletonSeconds: 10,
          retryLimit: 3,
          retryDelay: 5,
          retryBackoff: true,
          expireInSeconds: 30
        });
      }
      catch { console.error("Worker heartbeat scheduling failed."); }
    };
    await enqueue();
    heartbeatTimer = setInterval(() => void enqueue(), HEARTBEAT_INTERVAL_MS);
    let supportReceiptsRunning=false;
    const dispatchMedia = async () => {
      try {
        if(emailPort&&deliveryConfig&&!supportReceiptsRunning){supportReceiptsRunning=true;try{await deliverSupportReceipts(pool,emailPort,deliveryConfig.emailFrom);}finally{supportReceiptsRunning=false;}}
        await purgeExpiredUploads(pool, storage);
        await purgeExpiredExports(pool, exportStorage, { limit: 50 });
        await dispatchMediaOutbox(pool, storage, (queue: string, data: MediaJob, options?: Record<string, unknown>) => boss.send(queue, data, options as never));
        await dispatchPublicationSnapshotOutbox(pool, (queue: string, data: PublicationSnapshotJob, options?: Record<string, unknown>) => boss.send(queue, data, options as never));
        await dispatchExportOutbox(pool, (queue: string, data: ExportJobPayload, options?: Record<string, unknown>) => boss.send(queue, data, options as never));
        await dispatchSideEffectDeliveries(pool, (queue, data, options) => boss.send(queue, data, options as never));
        await dispatchNotificationOutbox(pool, (queue, data, options) => boss.send(queue, data, options as never));
      } catch { console.error("Outbox dispatch or private object cleanup failed; pending work will retry."); }
    };
    await dispatchMedia();
    mediaTimer = setInterval(() => void dispatchMedia(), 2_000);
    const recoverPublicationSnapshots = async () => {
      try { await reconcilePublicationSnapshotJobs(pool, { limit: 50 }); }
      catch { console.error("Publication snapshot recovery failed; stale jobs will be retried."); }
    };
    await recoverPublicationSnapshots();
    snapshotRecoveryTimer = setInterval(() => void recoverPublicationSnapshots(), PUBLICATION_SNAPSHOT_RECOVERY_INTERVAL_MS);
    let privacyRunning=false;
    const privacySweep=async()=>{if(privacyRunning)return;privacyRunning=true;try{await runPrivacySweep(pool,{deleteExport:key=>exportStorage.delete(key),deleteMedia:key=>storage.deleteObject(key)},{suppressionKey:process.env.PRIVACY_SUPPRESSION_KEY?.trim()||sessionSecret,limit:5});}catch{console.error('Privacy erasure sweep failed; stages will retry safely.');}finally{privacyRunning=false;}};
    await privacySweep();
    privacyTimer=setInterval(()=>void privacySweep(),30000);
    const recoverExports = async () => {
      try { await reconcileExportJobs(pool, { limit: 50 }); }
      catch { console.error("Export job recovery failed; stale jobs will be retried."); }
    };
    await recoverExports();
    exportRecoveryTimer = setInterval(() => void recoverExports(), PUBLICATION_SNAPSHOT_RECOVERY_INTERVAL_MS);
    const scheduleDigests = async () => {
      try { await scheduleDailyDigests(pool); }
      catch { console.error("Daily digest scheduling failed; eligible local dates will be retried."); }
    };
    await scheduleDigests();
    digestScheduleTimer = setInterval(() => void scheduleDigests(), DIGEST_SCHEDULE_INTERVAL_MS);
    const recoverDeliveries = async () => {
      try { await reconcileSideEffectDeliveries(pool, 100); }
      catch { console.error("Email delivery recovery failed; pending work will retry safely."); }
    };
    await recoverDeliveries();
    deliveryRecoveryTimer = setInterval(() => void recoverDeliveries(), DELIVERY_RECOVERY_INTERVAL_MS);
    const purgeProductEvents = async () => {
      try { await purgeExpiredProductEvents(pool);await purgeOperationalReplay(pool); }
      catch { console.error("Product event retention purge failed; the next bounded sweep will retry."); }
    };
    await purgeProductEvents();
    productEventPurgeTimer = setInterval(() => void purgeProductEvents(), PRODUCT_EVENT_PURGE_INTERVAL_MS);
    const requestBillingReconciliation = createBillingReconciler(apiOrigin, sessionSecret);
    const reconcileBilling = async () => {
      try { await requestBillingReconciliation(); }
      catch { console.error("Billing reconciliation unavailable; pending provider truth will retry on the next bounded sweep."); }
    };
    await reconcileBilling();
    billingReconcileTimer = setInterval(() => void reconcileBilling(), 60_000);
    const sweepExpiredPositions = async () => {
      try { await expireOpenPositions(pool, { limit: 50 }); }
      catch { console.error("Position expiry sweep failed; eligible rows will be retried."); }
    };
    await sweepExpiredPositions();
    expiryTimer = setInterval(() => void sweepExpiredPositions(), POSITION_EXPIRY_INTERVAL_MS);
    console.info("Worker started; foundation heartbeat and durable delivery queues are active.");
  } catch {
    console.error("Worker startup failed.");
    process.exitCode = 1;
    await stop();
  }
}

void run().catch(() => {
  console.error("Worker exited after an unexpected startup error.");
  process.exitCode = 1;
});
