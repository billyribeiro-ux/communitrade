import { createDatabase } from './database.js';
import { randomUUID } from 'node:crypto';

if (process.env.NODE_ENV === 'production' || ['production','public'].includes((process.env.RELEASE_MODE ?? '').toLowerCase())) {
  throw new Error('Synthetic seed data is disabled in production.');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');

const db = createDatabase(process.env.DATABASE_URL);
const syntheticIssuer = 'urn:options-trade-ideas:synthetic-fixture';
const personas = [
  { id: '00000000-0000-4000-8000-000000000101', subject: 'persona-verified-free', email: 'free@example.invalid', emailVerified: true, status: 'active', plan: 'free' },
  { id: '00000000-0000-4000-8000-000000000102', subject: 'persona-verified-pro', email: 'pro@example.invalid', emailVerified: true, status: 'active', plan: 'pro' },
  { id: '00000000-0000-4000-8000-000000000103', subject: 'persona-incomplete-costs', email: 'incomplete@example.invalid', emailVerified: true, status: 'active', plan: 'free' },
  { id: '00000000-0000-4000-8000-000000000104', subject: 'persona-unverified', email: 'unverified@example.invalid', emailVerified: false, status: 'active', plan: 'free' },
  { id: '00000000-0000-4000-8000-000000000105', subject: 'persona-moderator', email: 'moderator@example.invalid', emailVerified: true, status: 'active', plan: 'free', role: 'moderator' },
  { id: '00000000-0000-4000-8000-000000000106', subject: 'persona-administrator', email: 'administrator@example.invalid', emailVerified: true, status: 'active', plan: 'free', role: 'admin' },
  { id: '00000000-0000-4000-8000-000000000108', subject: 'persona-journal-quota', email: 'journal-quota@example.invalid', emailVerified: true, status: 'active', plan: 'free' },
  { id: '00000000-0000-4000-8000-000000000109', subject: 'persona-downgraded', email: 'downgraded@example.invalid', emailVerified: true, status: 'active', plan: 'free' },
  { id: '00000000-0000-4000-8000-000000000107', subject: 'persona-suspended', email: 'suspended@example.invalid', emailVerified: true, status: 'suspended', plan: 'free' },
] as const;

try {
  // Preserve the original P01 operational probe and its stable upsert contract.
  await db.foundationProbe.upsert({
    where: { id: 'seed' },
    create: { id: 'seed', label: 'P01 local seed' },
    update: {},
  });

  for (const persona of personas) {
    await db.user.upsert({
      where: { id: persona.id },
      create: {
        id: persona.id,
        oidcIssuer: syntheticIssuer,
        oidcSubject: persona.subject,
        email: persona.email,
        emailVerified: persona.emailVerified,
        status: persona.status,
        synthetic: true,
        onboardingVersion: 'synthetic-fixture-v1',
        declarationVersion: 'synthetic-fixture-v1',
        policyVersion: 'synthetic-fixture-v1',
      },
      update: { oidcIssuer: syntheticIssuer, oidcSubject: persona.subject, email: persona.email, emailVerified: persona.emailVerified, status: persona.status, synthetic: true },
    });
    await db.subscriptionEntitlement.upsert({
      where: { userId: persona.id },
      create: {
        userId: persona.id,
        plan: persona.plan,
        limits: persona.plan === 'pro'
          ? { watchlists: 10, itemsPerWatchlist: 100, savedLayouts: 10, newJournalEntriesPerMonth: 1000 }
          : { watchlists: 1, itemsPerWatchlist: 25, savedLayouts: 1, newJournalEntriesPerMonth: 30 },
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
      update: {
        plan: persona.plan,
        limits: persona.plan === 'pro'
          ? { watchlists: 10, itemsPerWatchlist: 100, savedLayouts: 10, newJournalEntriesPerMonth: 1000 }
          : { watchlists: 1, itemsPerWatchlist: 25, savedLayouts: 1, newJournalEntriesPerMonth: 30 },
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    if ('role' in persona && persona.role) {
      await db.roleGrant.upsert({
        where: { userId_role: { userId: persona.id, role: persona.role } },
        create: { userId: persona.id, role: persona.role, grantorUserId: persona.id, reason: 'Deterministic synthetic fixture persona' },
        update: {},
      });
    }
  }

  const stockId = '00000000-0000-4000-8000-000000000201';
  const catalog: Array<{
    id: string;
    asset: string;
    symbol: string;
    underlyingId: string | null;
    root?: string;
    metadata: { multiplier: string; tickSize: string; strike?: string; optionType?: string; expiration?: string; contractMonth?: number; contractYear?: number; futureExpiry?: string };
  }> = [
    { id: stockId, asset: 'stock', symbol: 'SYN-XYZ', underlyingId: null, metadata: { multiplier: '1', tickSize: '0.01' } },
    { id: '00000000-0000-4000-8000-000000000202', asset: 'future', symbol: 'SYN-ESZ26', underlyingId: null, root: 'ES', metadata: { multiplier: '50', tickSize: '0.25' } },
    { id: '00000000-0000-4000-8000-000000000203', asset: 'future', symbol: 'SYN-MESZ26', underlyingId: null, root: 'MES', metadata: { multiplier: '5', tickSize: '0.25' } },
    { id: '00000000-0000-4000-8000-000000000204', asset: 'future', symbol: 'SYN-NQZ26', underlyingId: null, root: 'NQ', metadata: { multiplier: '20', tickSize: '0.25' } },
    { id: '00000000-0000-4000-8000-000000000205', asset: 'future', symbol: 'SYN-MNQZ26', underlyingId: null, root: 'MNQ', metadata: { multiplier: '2', tickSize: '0.25' } },
    { id: '00000000-0000-4000-8000-000000000206', asset: 'future', symbol: 'SYN-ESH27', underlyingId: null, root: 'ES', metadata: { multiplier: '50', tickSize: '0.25', contractMonth: 3, contractYear: 2027, futureExpiry: '2027-03-19T13:30:00.000Z' } },
    { id: '00000000-0000-4000-8000-000000000207', asset: 'future', symbol: 'SYN-MESH27', underlyingId: null, root: 'MES', metadata: { multiplier: '5', tickSize: '0.25', contractMonth: 3, contractYear: 2027, futureExpiry: '2027-03-19T13:30:00.000Z' } },
    { id: '00000000-0000-4000-8000-000000000208', asset: 'future', symbol: 'SYN-NQH27', underlyingId: null, root: 'NQ', metadata: { multiplier: '20', tickSize: '0.25', contractMonth: 3, contractYear: 2027, futureExpiry: '2027-03-19T13:30:00.000Z' } },
    { id: '00000000-0000-4000-8000-000000000209', asset: 'future', symbol: 'SYN-MNQH27', underlyingId: null, root: 'MNQ', metadata: { multiplier: '2', tickSize: '0.25', contractMonth: 3, contractYear: 2027, futureExpiry: '2027-03-19T13:30:00.000Z' } },
    { id: '00000000-0000-4000-8000-000000000221', asset: 'option', symbol: 'SYN-XYZ-20261120-C100', underlyingId: stockId, metadata: { multiplier: '100', tickSize: '0.01', strike: '100', optionType: 'call' } },
    { id: '00000000-0000-4000-8000-000000000222', asset: 'option', symbol: 'SYN-XYZ-20261120-C105', underlyingId: stockId, metadata: { multiplier: '100', tickSize: '0.01', strike: '105', optionType: 'call' } },
    { id: '00000000-0000-4000-8000-000000000223', asset: 'option', symbol: 'SYN-XYZ-20261120-P100', underlyingId: stockId, metadata: { multiplier: '100', tickSize: '0.01', strike: '100', optionType: 'put' } },
    { id: '00000000-0000-4000-8000-000000000224', asset: 'option', symbol: 'SYN-XYZ-20261120-P105', underlyingId: stockId, metadata: { multiplier: '100', tickSize: '0.01', strike: '105', optionType: 'put' } },
    { id: '00000000-0000-4000-8000-000000000225', asset: 'option', symbol: 'SYN-XYZ-20261120-C95', underlyingId: stockId, metadata: { multiplier: '100', tickSize: '0.01', strike: '95', optionType: 'call' } },
    { id: '00000000-0000-4000-8000-000000000226', asset: 'option', symbol: 'SYN-XYZ-20261120-C110', underlyingId: stockId, metadata: { multiplier: '100', tickSize: '0.01', strike: '110', optionType: 'call' } },
    { id: '00000000-0000-4000-8000-000000000227', asset: 'option', symbol: 'SYN-XYZ-20261120-P95', underlyingId: stockId, metadata: { multiplier: '100', tickSize: '0.01', strike: '95', optionType: 'put' } },
    { id: '00000000-0000-4000-8000-000000000228', asset: 'option', symbol: 'SYN-XYZ-20261120-P110', underlyingId: stockId, metadata: { multiplier: '100', tickSize: '0.01', strike: '110', optionType: 'put' } },
    { id: '00000000-0000-4000-8000-000000000229', asset: 'option', symbol: 'SYN-XYZ-20261218-C100', underlyingId: stockId, metadata: { multiplier: '100', tickSize: '0.01', strike: '100', optionType: 'call', expiration: '2026-12-18T21:00:00.000Z' } },
    { id: '00000000-0000-4000-8000-000000000230', asset: 'option', symbol: 'SYN-XYZ-20261218-C105', underlyingId: stockId, metadata: { multiplier: '100', tickSize: '0.01', strike: '105', optionType: 'call', expiration: '2026-12-18T21:00:00.000Z' } },
    { id: '00000000-0000-4000-8000-000000000231', asset: 'option', symbol: 'SYN-XYZ-20261218-P100', underlyingId: stockId, metadata: { multiplier: '100', tickSize: '0.01', strike: '100', optionType: 'put', expiration: '2026-12-18T21:00:00.000Z' } },
    { id: '00000000-0000-4000-8000-000000000232', asset: 'option', symbol: 'SYN-XYZ-20261218-P105', underlyingId: stockId, metadata: { multiplier: '100', tickSize: '0.01', strike: '105', optionType: 'put', expiration: '2026-12-18T21:00:00.000Z' } },
  ];
  const futureExpiry = new Date('2026-12-18T21:00:00.000Z');
  const optionExpiry = new Date('2026-11-20T21:00:00.000Z');
  for (const instrument of catalog) {
    await db.instrument.upsert({
      where: { id: instrument.id },
      create: {
        id: instrument.id,
        asset: instrument.asset,
        vendor: 'synthetic-fixture',
        vendorId: instrument.symbol,
        underlyingId: 'underlyingId' in instrument ? instrument.underlyingId : null,
        venue: 'SYNTHETIC',
        currency: 'USD',
        enabled: true,
      },
      update: {},
    });
    const isFuture = instrument.asset === 'future';
    await db.instrumentMetadataVersion.upsert({
      where: { instrumentId_version: { instrumentId: instrument.id, version: 1 } },
      create: {
        instrumentId: instrument.id,
        version: 1,
        multiplier: instrument.metadata.multiplier,
        tickSize: instrument.metadata.tickSize,
        strike: 'strike' in instrument.metadata ? instrument.metadata.strike : null,
        expiry: instrument.asset === 'option' ? new Date(instrument.metadata.expiration ?? optionExpiry.toISOString()) : isFuture ? new Date(instrument.metadata.futureExpiry ?? futureExpiry.toISOString()) : null,
        root: 'root' in instrument ? instrument.root : null,
        contractMonth: isFuture ? (instrument.metadata.contractMonth ?? 12) : null,
        contractYear: isFuture ? (instrument.metadata.contractYear ?? 2026) : null,
        optionType: 'optionType' in instrument.metadata ? instrument.metadata.optionType : null,
        adjusted: false,
        sourceId: 'synthetic-fixture-v1',
      },
      update: {},
    });
    if (instrument.asset === 'future' && instrument.metadata.contractMonth === undefined) {
      await db.instrumentMetadataVersion.upsert({
        where: { instrumentId_version: { instrumentId: instrument.id, version: 2 } },
        create: { instrumentId: instrument.id, version: 2, multiplier: instrument.metadata.multiplier, tickSize: instrument.metadata.tickSize, expiry: new Date('2026-12-18T14:30:00.000Z'), root: 'root' in instrument ? instrument.root : null, contractMonth: 12, contractYear: 2026, adjusted: false, sourceId: 'synthetic-fixture-v2-corrected-quarterly-expiry' },
        update: {},
      });
    }
  }
  // Fixture capability rows are explicit, audience/purpose-scoped and safe to re-run.
  // Their synthetic agreement is never valid production evidence.
  for (const asset of ['stock','option','future']) for (const audience of ['public','member']) for (const purpose of ['display','chart','snapshot','export','personal_record','publishing']) {
    const flags = { displayPublic: audience==='public', displayMember: audience==='member', retainBars: purpose==='chart'||purpose==='publishing', retainSnapshot: purpose==='snapshot'||purpose==='publishing', exportImage: purpose==='export', exportPersonalRecord: purpose==='personal_record', newPublishing: purpose==='publishing' };
    await db.$executeRaw`INSERT INTO data_capability(id,supplier,agreement_id,dataset,audience,purpose,effective_at,flags)
      SELECT ${randomUUID()}::uuid,'synthetic-fixture','synthetic-fixture-v1',${asset},${audience},${purpose},now(),${JSON.stringify(flags)}::jsonb
      WHERE NOT EXISTS(SELECT 1 FROM data_capability WHERE supplier='synthetic-fixture' AND agreement_id='synthetic-fixture-v1' AND dataset=${asset} AND audience=${audience} AND purpose=${purpose} AND revoked_at IS NULL)`;
  }
  for (const audience of ['public','member']) {
    const flags = { displayPublic: audience==='public', displayMember: audience==='member', retainBars: false, retainSnapshot: false, exportImage: false, exportPersonalRecord: false, newPublishing: false };
    await db.$executeRaw`INSERT INTO data_capability(id,supplier,agreement_id,dataset,audience,purpose,effective_at,flags) SELECT ${randomUUID()}::uuid,'synthetic-fixture','synthetic-fixture-v1','calendar',${audience},'display',now(),${JSON.stringify(flags)}::jsonb WHERE NOT EXISTS(SELECT 1 FROM data_capability WHERE supplier='synthetic-fixture' AND agreement_id='synthetic-fixture-v1' AND dataset='calendar' AND audience=${audience} AND purpose='display' AND revoked_at IS NULL)`;
  }
  // P07 owner-scoped chart documents. Seed inserts are intentionally insert-only:
  // rerunning fixtures never replaces drafts or drawings a local user has edited.
  const chartDrafts = [
    { id: '00000000-0000-4000-8000-000000000701', owner: personas[0].id, title: 'Synthetic stock chart', asset: 'stock', instrument: stockId, metadataVersion: 1, interval: '1d', timezone: 'America/New_York', session: 'regular', from: '2026-09-21T13:30:00.000Z', to: '2026-10-20T20:00:00.000Z', entry: '100.00', target: '105.00' },
    { id: '00000000-0000-4000-8000-000000000702', owner: personas[0].id, title: 'Synthetic option underlying chart', asset: 'option', instrument: stockId, metadataVersion: 1, interval: '1d', timezone: 'America/New_York', session: 'regular', from: '2026-09-21T13:30:00.000Z', to: '2026-10-20T20:00:00.000Z', entry: '100.00', target: '105.00' },
    { id: '00000000-0000-4000-8000-000000000703', owner: personas[0].id, title: 'Synthetic futures chart', asset: 'future', instrument: '00000000-0000-4000-8000-000000000202', metadataVersion: 2, interval: '1d', timezone: 'America/Chicago', session: 'exchange', from: '2026-09-21T13:30:00.000Z', to: '2026-10-20T20:00:00.000Z', entry: '6000.00', target: '6020.00' },
    { id: '00000000-0000-4000-8000-000000000704', owner: personas[1].id, title: 'Separate owner synthetic chart', asset: 'stock', instrument: stockId, metadataVersion: 1, interval: '1d', timezone: 'America/New_York', session: 'regular', from: '2026-09-21T13:30:00.000Z', to: '2026-10-20T20:00:00.000Z', entry: '99.00', target: '104.00' },
  ];
  for (const item of chartDrafts) {
    const inserted = await db.$queryRaw<Array<{ id: string }>>`INSERT INTO draft(id,owner_user_id,kind,title,plan,revision,chart_revision,created_at,updated_at)
      VALUES(${item.id}::uuid,${item.owner}::uuid,'trade',${item.title},${JSON.stringify({ asset: item.asset, instrumentId: item.instrument, strategy: item.asset === 'option' ? 'long_call' : 'long', priceKind: item.asset === 'future' ? 'futures' : item.asset === 'option' ? 'option_premium' : 'underlying', underlyingChartLevels: { entry: item.entry, targets: [item.target] } })}::jsonb,1,1,now(),now())
      ON CONFLICT(id) DO NOTHING RETURNING id`;
    if (!inserted.length) continue;
    const state = {
      schemaVersion: 1,
      instrumentId: item.instrument,
      metadataVersion: item.metadataVersion,
      interval: item.interval,
      timezone: item.timezone,
      session: item.session,
      adjustment: 'unadjusted',
      viewport: { from: item.from, to: item.to },
      indicators: [],
      provenance: { provider: 'synthetic-fixture', asOf: '2026-10-19T20:00:00.000Z', delaySeconds: 900, demo: true },
      drawings: [
        { id: randomUUID(), type: 'entry', anchors: [{ time: item.from, price: item.entry }], style: { color: '#16865d', lineWidth: 1, lineStyle: 'dashed', fillOpacity: 0 }, planField: 'entryUnderlying' },
        { id: randomUUID(), type: 'target', anchors: [{ time: item.from, price: item.target }], style: { color: '#4678d4', lineWidth: 1, lineStyle: 'dashed', fillOpacity: 0 }, planField: 'targetUnderlying1', text: 'Target 1' },
      ],
    };
    await db.$executeRaw`INSERT INTO chart_state(id,owner_user_id,draft_id,publication_version_id,schema_version,state,provenance,revision,created_at)
      VALUES(${randomUUID()}::uuid,${item.owner}::uuid,${item.id}::uuid,NULL,1,${JSON.stringify(state)}::jsonb,${JSON.stringify(state.provenance)}::jsonb,1,now())`;
  }
  // P10 insert-only quota/downgrade fixtures. These identities cannot enter a
  // production release and reruns never reset a real member's quota or edits.
  const quotaOwner = '00000000-0000-4000-8000-000000000108';
  const downgradeOwner = '00000000-0000-4000-8000-000000000109';
  for (let index=0;index<30;index++) {
    const journalId=`00000000-0000-4000-8000-${String(108000+index).padStart(12,'0')}`;
    await db.journalEntry.upsert({where:{id:journalId},create:{id:journalId,ownerUserId:quotaOwner,title:`Synthetic quota entry ${index+1}`,thesis:'Synthetic personal research fixture.',notes:'Private fixture notes; never a public trade.',tags:['synthetic','quota'],review:'',revision:1},update:{}});
  }
  await db.$executeRaw`INSERT INTO quota_bucket(id,user_id,metric,month_start,count,reserved_count,created_at,updated_at)
    VALUES(${randomUUID()}::uuid,${quotaOwner}::uuid,'journal_monthly',date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',30,0,now(),now())
    ON CONFLICT(user_id,metric,month_start) DO NOTHING`;
  const template = {schemaVersion:1,instrumentId:stockId,metadataVersion:1,interval:'1d',timezone:'America/New_York',session:'regular',adjustment:'unadjusted',viewport:{from:'2026-10-01T00:00:00.000Z',to:'2026-10-19T20:00:00.000Z'},indicators:[],provenance:{provider:'synthetic-fixture',asOf:'2026-10-19T20:00:00.000Z',delaySeconds:900,demo:true},drawings:[]};
  for (let index=0;index<2;index++) {
    const listId=`00000000-0000-4000-8000-${String(109000+index).padStart(12,'0')}`;
    const layoutId=`00000000-0000-4000-8000-${String(109100+index).padStart(12,'0')}`;
    await db.watchlist.upsert({where:{id:listId},create:{id:listId,ownerUserId:downgradeOwner,name:`Synthetic preserved list ${index+1}`},update:{}});
    await db.watchlistItem.upsert({where:{listId_instrumentId:{listId,instrumentId:stockId}},create:{listId,instrumentId:stockId},update:{}});
    await db.savedLayout.upsert({where:{id:layoutId},create:{id:layoutId,ownerUserId:downgradeOwner,name:`Synthetic preserved layout ${index+1}`,version:1,template},update:{}});
  }
  console.log('Synthetic P02 personas/catalog and P07 owner-scoped stock, option-underlying, and futures chart drafts plus P10 quota/downgrade states seeded (non-production only).');
} finally {
  await db.$disconnect();
}
