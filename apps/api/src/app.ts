import {PrivacyController,PRIVACY_SERVICE} from './privacy/controller.js';
import type {PrivacyService} from './privacy/service.js';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DATABASE, HealthController, type ReadinessDatabase } from './health.js';
import { SupportController, SUPPORT, SUPPORT_WORKFLOWS } from './support/controller.js';
import type { SupportWorkflows } from './support/workflows.js';
import {StaffController,STAFF_SERVICE} from './staff/controller.js';
import type {StaffService} from './staff/service.js';
import type { SupportService } from './support/service.js';
import { AuthController } from './auth/controller.js';
import { AUTH, type AuthService } from './auth/service.js';
import { ProfileController, PROFILE_SERVICE } from './profiles/controller.js';
import type { ProfileService } from './profiles/service.js';
import { MediaController, MEDIA_SERVICE } from './media/controller.js';
import type { MediaService } from './media/service.js';
import { ProblemFilter } from './http/problem-filter.js';
import { InstrumentController, INSTRUMENT_SERVICE } from './instruments/controller.js';
import type { InstrumentService } from './instruments/service.js';
import { DraftController, DRAFT_SERVICE } from './drafts/controller.js';
import type { DraftService } from './drafts/service.js';
import { PublicationController, PUBLICATION_SERVICE } from './publications/controller.js';
import type { PublicationService } from './publications/service.js';
import { PositionController, PerformanceController, POSITION_SERVICE, PERFORMANCE_SERVICE } from './positions/controller.js';
import type { PositionService, PerformanceService } from './positions/service.js';
import { CorrectionController, CORRECTION_SERVICE } from './corrections/controller.js';
import type { CorrectionService } from './corrections/service.js';
import { CommunityController, COMMUNITY_SERVICE } from './community/controller.js';
import type { CommunityService } from './community/service.js';
import { DiscoveryController, DISCOVERY_SERVICE } from './discovery/controller.js';
import type { DiscoveryService } from './discovery/service.js';
import { createIngressGuard, isProductionIngressMode, type IngressNonceConsumer } from './http/ingress.js';

import { WorkspaceController, WORKSPACE_SERVICE } from './workspace/controller.js';
import type { WorkspaceService } from './workspace/service.js';
import { JournalController, JOURNAL_SERVICE } from './journal/controller.js';
import type { JournalService } from './journal/service.js';
import { ExportController, EXPORT_SERVICE } from './exports/controller.js';
import type { ExportService } from './exports/service.js';
import { JobController, JOB_SERVICE } from './jobs/controller.js';
import type { JobService } from './jobs/service.js';
import { MeasurementController, MEASUREMENT_SERVICE } from './measurement/controller.js';
import type { MeasurementService } from './measurement/service.js';
import { NotificationController, NOTIFICATION_SERVICE } from './notifications/controller.js';
import type { NotificationService } from './notifications/service.js';
import { NotificationSourceController } from './notifications/source-controller.js';
import { BillingController, BILLING_SERVICE } from './billing/controller.js';
import { BillingReconcileController } from './billing/reconcile-controller.js';
import type { BillingService } from './billing/service.js';
import { EmailWebhookController, EMAIL_WEBHOOK } from './email/controller.js';
import type { EmailWebhookService } from './email/webhook.js';
export interface ApplicationServices {privacy?:PrivacyService;staff?:StaffService; supportWorkflows?:SupportWorkflows;billing?:BillingService; emailWebhook?:EmailWebhookService; notifications?:NotificationService; jobs?:JobService; measurement?:MeasurementService; journal?:JournalService; exports?:ExportService; workspace?:WorkspaceService; auth?: AuthService; profiles?: ProfileService; media?: MediaService; instruments?:InstrumentService; drafts?:DraftService; publications?:PublicationService; positions?:PositionService; performance?:PerformanceService; corrections?:CorrectionService; community?:CommunityService; discovery?:DiscoveryService}
export async function createApp(database: ReadinessDatabase, support: SupportService | null = null, services:ApplicationServices={}, ingress: { consumeNonce?: IngressNonceConsumer } = {}) {
  if(Object.values(services).some(Boolean)&&!services.auth)throw new Error('Application services require an auth boundary.');
  const ingressProduction = isProductionIngressMode(process.env);
  const ingressSecret = process.env.TRUSTED_INGRESS_SECRET ?? '';
  if (ingressProduction && ingressSecret.length < 32) throw new Error('Production requires a stable TRUSTED_INGRESS_SECRET of at least 32 characters.');
  @Module({ controllers: [HealthController, SupportController,...(services.privacy?[PrivacyController]:[]),...(services.staff?[StaffController]:[]),...(services.billing?[BillingController,BillingReconcileController]:[]),...(services.emailWebhook?[EmailWebhookController]:[]),...(services.notifications?[NotificationController]:[]),...(services.jobs?[JobController]:[]),...(services.measurement?[MeasurementController]:[]),...(services.journal?[JournalController]:[]),...(services.exports?[ExportController]:[]),...(services.workspace?[WorkspaceController]:[]),...(services.auth?[AuthController]:[]),...(services.profiles?[ProfileController]:[]),...(services.media?[MediaController]:[]),...(services.instruments?[InstrumentController]:[]),...(services.drafts?[DraftController]:[]),...(services.publications?[PublicationController,NotificationSourceController]:[]),...(services.positions?[PositionController]:[]),...(services.performance?[PerformanceController]:[]),...(services.corrections?[CorrectionController]:[]),...(services.community?[CommunityController]:[]),...(services.discovery?[DiscoveryController]:[])], providers: [{provide:PRIVACY_SERVICE,useValue:services.privacy??null},{provide:STAFF_SERVICE,useValue:services.staff??null},{provide:SUPPORT_WORKFLOWS,useValue:services.supportWorkflows??null},{provide:BILLING_SERVICE,useValue:services.billing??null},{provide:EMAIL_WEBHOOK,useValue:services.emailWebhook??null},{provide:NOTIFICATION_SERVICE,useValue:services.notifications??null},{provide:JOB_SERVICE,useValue:services.jobs??null},{provide:MEASUREMENT_SERVICE,useValue:services.measurement??null},{provide:JOURNAL_SERVICE,useValue:services.journal??null},{provide:EXPORT_SERVICE,useValue:services.exports??null},{provide:WORKSPACE_SERVICE,useValue:services.workspace??null},{ provide: DATABASE, useValue: database }, { provide: SUPPORT, useValue: support },{provide:AUTH,useValue:services.auth??null},{provide:PROFILE_SERVICE,useValue:services.profiles??null},{provide:MEDIA_SERVICE,useValue:services.media??null},{provide:INSTRUMENT_SERVICE,useValue:services.instruments??null},{provide:DRAFT_SERVICE,useValue:services.drafts??null},{provide:PUBLICATION_SERVICE,useValue:services.publications??null},{provide:POSITION_SERVICE,useValue:services.positions??null},{provide:PERFORMANCE_SERVICE,useValue:services.performance??null},{provide:CORRECTION_SERVICE,useValue:services.corrections??null},{provide:COMMUNITY_SERVICE,useValue:services.community??null},{provide:DISCOVERY_SERVICE,useValue:services.discovery??null}] })
  class AppModule {}
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false, rawBody: true });
  app.setGlobalPrefix('api/v1');
  // Preserve signed JSON bytes for billing webhooks before any JSON reserialization.
  // Only supported image MIME types become raw buffers. Other routes still validate
  // their declared transport/schema; JSON and logout forms use the normal parsers.
  app.useBodyParser('raw',{type:['image/png','image/jpeg','image/webp'],limit:2097152});
  // Register these before ingress: signatures bind parser-captured original bytes.
  app.useBodyParser('json',{limit:1048576});
  app.useBodyParser('urlencoded',{extended:false,limit:65536});
  app.use((_req:unknown,res:{setHeader:(name:string,value:string)=>void},next:()=>void)=>{res.setHeader('Cache-Control','no-store');next();});
  app.use(createIngressGuard({ secret: ingressSecret, production: ingressProduction, ...(ingress.consumeNonce?{consumeNonce:ingress.consumeNonce}:{}) }));
  app.useGlobalFilters(new ProblemFilter());
  app.use((_request: unknown, response: { setHeader: (name: string, value: string) => void }, next: () => void) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy','no-referrer');
    next();
  });
  return app;
}
