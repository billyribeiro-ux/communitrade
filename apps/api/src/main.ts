import {PrivacyService} from './privacy/service.js';
import { FilesystemStorage, FilesystemExportStorage,createObjectStores } from '@trading/media';
import {EmailWebhookService} from './email/webhook.js';
import { AuthService, authConfigFromEnv } from './auth/service.js';
import { ProfileService } from './profiles/service.js';
import { MediaService } from './media/service.js';
import { Pool } from 'pg';
import {SupportWorkflows} from './support/workflows.js';
import {StaffService} from './staff/service.js';
import { SupportService } from './support/service.js';
import { createApp } from './app.js';
import { createDatabase } from './database.js';
import { parseAppConfig, billingEntitlementScope,assertProductionRuntime } from '@trading/config';
import { assertNoProductionFixtures } from './persistence/release-guard.js';
import { InstrumentService } from './instruments/service.js';
import { createMarketDataRuntime } from './instruments/market-data-config.js';
import { assertProductionDataReady } from './persistence/production-data-readiness.js';
import { DraftService } from './drafts/service.js';
import { PublicationService } from './publications/service.js';
import { PositionService, PerformanceService } from './positions/service.js';
import { CorrectionService } from './corrections/service.js';
import { CommunityService } from './community/service.js';
import { DiscoveryService } from './discovery/service.js';
import type { Transaction } from './persistence/transactions.js';
import { WorkspaceService } from './workspace/service.js';
import { JournalService } from './journal/service.js';
import { ExportService } from './exports/service.js';
import { effectivePlan } from './workspace/entitlements.js';
import { JobService } from './jobs/service.js';
import { NotificationService } from './notifications/service.js';
import { MeasurementService } from './measurement/service.js';
import { BillingService } from './billing/service.js';
import { createBillingProvider, createBillingProviderConfig } from './billing/provider-config.js';
async function main() {
  assertProductionRuntime(process.env,'api');
  const {
    databaseUrl,
    port
  } = parseAppConfig(process.env);
  const database = createDatabase(databaseUrl);
  try {
    await assertNoProductionFixtures(database, process.env);
  } catch (error) {
    await database.$disconnect();
    throw error;
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 8,
    connectionTimeoutMillis: 1500,
    query_timeout: 3000
  });
  // An idle socket can fail during a database restart. pg removes that client;
  // handle its pool error without crashing or serializing connection internals.
  pool.on('error', () => console.error(JSON.stringify({event:'api.database_pool_unavailable'})));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const market = await createMarketDataRuntime(pool, process.env);
    const production = process.env.NODE_ENV === 'production' || ['production', 'public'].includes((process.env.RELEASE_MODE ?? '').toLowerCase());
    if (production && market.mode !== 'databento') throw new Error('Public and production releases require the Databento adapter boundary.');
    if (production) await assertProductionDataReady(pool, market.configured);
    if(production&&(process.env.PRIVACY_SUPPRESSION_KEY?.length??0)<32)throw new Error('Production requires a stable backed-up PRIVACY_SUPPRESSION_KEY.');
    if(production&&(process.env.SUPPORT_CONTACT_MONITORED!=='true'||!process.env.SUPPORT_CONTACT_EMAIL||!/^[-a-zA-Z0-9._+]+@[-a-zA-Z0-9.]+\.[a-zA-Z]{2,}$/.test(process.env.SUPPORT_CONTACT_EMAIL)||/\.(?:invalid|test|localhost)$/.test(process.env.SUPPORT_CONTACT_EMAIL)))throw new Error('Production requires monitored support contact configuration.');
    const support = new SupportService(pool, process.env.SESSION_SECRET ?? '', process.env.WEB_ORIGIN ?? 'http://localhost:3000');
    const auth = new AuthService(pool, authConfigFromEnv());
    const objects=process.env.STORAGE_DRIVER==='r2'?createObjectStores(process.env):{
      media:new FilesystemStorage(process.env.LOCAL_OBJECTS_PATH??'/var/lib/options-trade-ideas/objects'),
      exportStorage:new FilesystemExportStorage(process.env.LOCAL_OBJECTS_PATH??'/var/lib/options-trade-ideas/objects')};
    const storage=objects.media;
    if('initialize' in storage)await storage.initialize();
    const instruments = new InstrumentService(pool, market.adapter, market.mode, market.configured);
    const publications = new PublicationService(pool, instruments);
    const assertPublicVersion = (publicationId: string, versionId: string, queryable: Transaction) => publications.assertPublicVersionDataRights(publicationId, versionId, queryable);
    const positions = new PositionService(pool, assertPublicVersion);
    const performance = new PerformanceService(pool, assertPublicVersion);
    const corrections = new CorrectionService(pool, positions, (tx, input) => publications.queueCorrectionSnapshot(tx, input));
    const billingConfig = createBillingProviderConfig(process.env);
    const billingScope = billingEntitlementScope(process.env);
    if (billingScope[0] !== `${billingConfig.provider}:${billingConfig.providerAccountId}` || billingScope[1] !== billingConfig.mode) {
      throw new Error('Billing entitlement scope does not match provider configuration.');
    }
    const billingProvider = await createBillingProvider(process.env, database);
    publications.setCorrectionFinalizer((tx, correctionRequestId, jobId, publicationVersionId) => corrections.finalizeCorrection(tx, correctionRequestId, jobId, publicationVersionId));
    app = await createApp(database, support, {
      auth,
      ...(process.env.RESEND_WEBHOOK_SECRET?{emailWebhook:new EmailWebhookService(pool,{secret:process.env.RESEND_WEBHOOK_SECRET,from:process.env.EMAIL_FROM??'',suppressionKey:process.env.PRIVACY_SUPPRESSION_KEY?.trim()||(process.env.SESSION_SECRET??'')})}:{}),
      privacy:new PrivacyService(pool),
      staff:new StaffService(pool),
      supportWorkflows:new SupportWorkflows(pool,{monitored:process.env.SUPPORT_CONTACT_MONITORED==='true',contactEmail:process.env.SUPPORT_CONTACT_EMAIL??null,responseTargetHours:48}),
      billing: new BillingService(pool, billingProvider, billingConfig),
      notifications:new NotificationService(pool,process.env.SESSION_SECRET,async(publicationId,versionId)=>{try{await publications.getPublication(publicationId,versionId);return true;}catch{return false;}}),
      jobs:new JobService(pool),
      measurement:new MeasurementService(pool),
      workspace:new WorkspaceService(pool,(ids,tx)=>instruments.workspaceSummaries(ids,tx)),
      journal:new JournalService(pool,assertPublicVersion),
      exports:new ExportService(pool,objects.exportStorage,effectivePlan),
      profiles: new ProfileService(pool, performance),
      media: new MediaService(pool, storage, (publicationId, versionId) => publications.canServeSnapshot(publicationId, versionId)),
      instruments,
      drafts: new DraftService(pool, market.adapter),
      publications,
      positions,
      performance,
      corrections,
      community: new CommunityService(pool, publications),
      discovery: new DiscoveryService(pool, publications, instruments)
    },{consumeNonce:async(nonce,expiresAt)=>Boolean((await pool.query(`INSERT INTO trusted_ingress_nonce(nonce,expires_at) VALUES($1,$2)
      ON CONFLICT(nonce) DO UPDATE SET expires_at=EXCLUDED.expires_at WHERE trusted_ingress_nonce.expires_at<=now() RETURNING nonce`,[nonce,expiresAt])).rowCount)});
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await app?.close();
      await pool.end();
      await database.$disconnect();
    };
    process.once('SIGTERM', () => void stop());
    process.once('SIGINT', () => void stop());
    await app.listen(port, '0.0.0.0');
    console.log(JSON.stringify({
      event: 'api.started',
      port
    }));
  } catch (error) {
    await app?.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await database.$disconnect().catch(() => undefined);
    throw error;
  }
}
main().catch(() => {
  console.error(JSON.stringify({
    event: 'api.start_failed'
  }));
  process.exitCode = 1;
});
