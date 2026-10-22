import assert from 'node:assert/strict';

/** Local acceptance maintenance only. No production erasure endpoint or trigger
 * exception is installed. Exclusive table locks prevent any other connection
 * from observing the temporary trigger state, and rollback restores it on error. */
export async function cleanupP08Fixtures(pool,userIds,instrumentIds=[]){
 if(process.env.RELEASE_MODE!=='local'||process.env.NODE_ENV==='production')throw new Error('P08 fixture cleanup requires local release mode.');
 const ids=[...new Set(userIds)];if(!ids.length)return;
 assert.ok(ids.every(id=>/^[0-9a-f-]{36}$/i.test(id)&&!id.startsWith('00000000-0000-4000-8000-000000000')),'Only disposable identities may be cleaned.');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='10s'");
  await client.query("SET LOCAL statement_timeout='20s'");
  const users=await client.query('SELECT id,email,oidc_issuer,oidc_subject,synthetic FROM user_account WHERE id=ANY($1::uuid[]) FOR UPDATE',[ids]);
  for(const user of users.rows)assert.ok(user.email.endsWith('@example.invalid')&&(/^https:\/\/p08\.(?:publications|positions)\.[0-9a-f-]+\.invalid$/.test(user.oidc_issuer)||user.oidc_issuer==='https://p08.media.invalid'||/^https:\/\/p09\.(?:community|feed)\.[0-9a-f-]+\.invalid$/.test(user.oidc_issuer)&&user.oidc_subject===user.id||/^https:\/\/p10\.(?:workspace|journal|exports)\.[0-9a-f-]+\.invalid$/.test(user.oidc_issuer)&&user.oidc_subject===user.id||/^https:\/\/p11\.(?:operations|notifications|delivery)\.[0-9a-f-]+\.invalid$/.test(user.oidc_issuer)&&user.oidc_subject===user.id||/^https:\/\/p12\.(?:billing|core)\.[0-9a-f-]+\.invalid$/.test(user.oidc_issuer)&&user.oidc_subject===user.id||/^https:\/\/p13\.(?:support|staff|privacy)\.[0-9a-f-]+\.invalid$/.test(user.oidc_issuer)&&user.oidc_subject===user.id||user.synthetic&&/^(?:p08|p09|p10|p11|p12|p13)-live-[0-9a-f-]+$/.test(user.oidc_subject)),'Identity is not a generated acceptance fixture.');
  if(instrumentIds.length){const instruments=await client.query('SELECT id,vendor,vendor_id FROM instrument WHERE id=ANY($1::uuid[])',[instrumentIds]);for(const instrument of instruments.rows)assert.ok(['p08-test','p10-test','p10-export'].includes(instrument.vendor)||instrument.vendor==='fixture'&&(instrument.vendor_id.startsWith('P09-')||instrument.vendor_id.startsWith('P10-')),'Instrument is not a generated acceptance fixture.');}
  const privacyRequests=(await client.query('SELECT id FROM privacy_request WHERE owner_user_id=ANY($1::uuid[])',[ids])).rows.map(row=>row.id);
  const tickets=(await client.query('SELECT id FROM support_ticket WHERE requester_user_id=ANY($1::uuid[]) OR requester_email IN (SELECT email FROM user_account WHERE id=ANY($1::uuid[]))',[ids])).rows.map(row=>row.id);
  const publications=(await client.query('SELECT id FROM publication WHERE author_user_id=ANY($1::uuid[])',[ids])).rows.map(row=>row.id);
  const corrections=(await client.query('SELECT id FROM correction_request WHERE publication_id=ANY($1::uuid[])',[publications])).rows.map(row=>row.id);
  const jobs=(await client.query('SELECT id FROM publication_job WHERE owner_user_id=ANY($1::uuid[])',[ids])).rows.map(row=>row.id);
  // Acquire all locks before changing any trigger; no disabled state is committed.
  await client.query('LOCK TABLE publication_version,position_event,audit_event,chart_state,instrument_metadata_version IN ACCESS EXCLUSIVE MODE');
  await client.query('ALTER TABLE publication_version DISABLE TRIGGER publication_version_immutable');
  await client.query('ALTER TABLE position_event DISABLE TRIGGER position_event_immutable');
  await client.query('ALTER TABLE audit_event DISABLE TRIGGER audit_event_immutable');
  await client.query('ALTER TABLE chart_state DISABLE TRIGGER published_chart_immutable');
  await client.query('ALTER TABLE instrument_metadata_version DISABLE TRIGGER instrument_metadata_append_only');
  await client.query("DELETE FROM audit_event WHERE (resource_type='correction_request' AND resource_id=ANY($1::uuid[])) OR actor=ANY($2::text[])",[corrections,ids]);
  await client.query("DELETE FROM audit_event WHERE actor=ANY($1::text[]) OR (resource_type='privacy_request' AND resource_id=ANY($2::uuid[])) OR (resource_type='support_ticket' AND resource_id=ANY($3::uuid[]))",[ids.map(id=>'user:'+id),privacyRequests,tickets]);
  await client.query("DELETE FROM side_effect_delivery WHERE channel='support_email' AND payload->>'ticketId'=ANY($1::text[])",[tickets]);
  await client.query("DELETE FROM idempotency_record WHERE route='/support' AND resource_id=ANY($1::uuid[])",[tickets]);
  await client.query('DELETE FROM support_access_grant WHERE ticket_id=ANY($1::uuid[]) OR owner_user_id=ANY($2::uuid[]) OR staff_user_id=ANY($2::uuid[])',[tickets,ids]);
  await client.query('DELETE FROM support_message WHERE ticket_id=ANY($1::uuid[]) OR author_user_id=ANY($2::uuid[])',[tickets,ids]);
  await client.query('DELETE FROM support_ticket WHERE id=ANY($1::uuid[])',[tickets]);
  await client.query('DELETE FROM privacy_deletion_object WHERE request_id=ANY($1::uuid[])',[privacyRequests]);
  await client.query('DELETE FROM privacy_deletion_suppression WHERE request_id=ANY($1::uuid[])',[privacyRequests]);
  await client.query("DELETE FROM outbox_event WHERE aggregate_type='privacy_request' AND aggregate_id=ANY($1::uuid[])",[privacyRequests]);
  await client.query('DELETE FROM privacy_request WHERE id=ANY($1::uuid[])',[privacyRequests]);
  const comments=(await client.query('SELECT id FROM comment WHERE author_user_id=ANY($1::uuid[]) OR publication_id=ANY($2::uuid[])',[ids,publications])).rows.map(row=>row.id);
  const reposts=(await client.query('SELECT id FROM repost WHERE user_id=ANY($1::uuid[]) OR publication_id=ANY($2::uuid[])',[ids,publications])).rows.map(row=>row.id);
  await client.query('DELETE FROM notification WHERE owner_user_id=ANY($1::uuid[]) OR source_id=ANY($2::uuid[])',[ids,publications]);
  await client.query('DELETE FROM side_effect_delivery WHERE owner_user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM product_event WHERE owner_user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM saved_search WHERE owner_user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM digest_suppression WHERE owner_user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM email_suppression WHERE owner_user_id=ANY($1::uuid[])',[ids]);
  await client.query(`DELETE FROM outbox_event WHERE event_type LIKE 'notification.%' AND
    (payload->>'recipientUserId'=ANY($1::text[]) OR payload->>'authorUserId'=ANY($1::text[]) OR payload->>'publicationId'=ANY($2::text[]))`,[ids,publications]);
  const reports=(await client.query('SELECT id FROM report WHERE reporter_user_id=ANY($1::uuid[]) OR resource_id=ANY($2::uuid[])',[ids,[...publications,...comments,...reposts, ...ids]])).rows.map(row=>row.id);
  await client.query('DELETE FROM appeal WHERE report_id=ANY($1::uuid[]) OR appellant_user_id=ANY($2::uuid[]) OR reviewer_user_id=ANY($2::uuid[]) OR assigned_reviewer_user_id=ANY($2::uuid[])',[reports,ids]);
  await client.query('DELETE FROM moderation_action WHERE report_id=ANY($1::uuid[]) OR reviewer_user_id=ANY($2::uuid[])',[reports,ids]);
  await client.query('DELETE FROM report WHERE id=ANY($1::uuid[])',[reports]);
  await client.query('DELETE FROM editorial_selection WHERE publication_id=ANY($1::uuid[]) OR selector_user_id=ANY($2::uuid[])',[publications,ids]);
  await client.query('DELETE FROM comment_mention WHERE comment_id=ANY($1::uuid[]) OR mentioned_user_id=ANY($2::uuid[])',[comments,ids]);
  await client.query('DELETE FROM comment_edit_history WHERE comment_id=ANY($1::uuid[])',[comments]);
  await client.query('DELETE FROM comment WHERE id=ANY($1::uuid[])',[comments]);
  await client.query('DELETE FROM reaction WHERE user_id=ANY($1::uuid[]) OR publication_id=ANY($2::uuid[])',[ids,publications]);
  await client.query('DELETE FROM bookmark WHERE user_id=ANY($1::uuid[]) OR publication_id=ANY($2::uuid[])',[ids,publications]);
  await client.query('DELETE FROM follow WHERE follower_user_id=ANY($1::uuid[]) OR target_user_id=ANY($1::uuid[]) OR instrument_id=ANY($2::uuid[])',[ids,instrumentIds]);
  await client.query('DELETE FROM mute WHERE user_id=ANY($1::uuid[]) OR author_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM repost WHERE id=ANY($1::uuid[])',[reposts]);
  await client.query("DELETE FROM outbox_event WHERE aggregate_type='export_job' AND aggregate_id IN (SELECT id FROM export_job WHERE owner_user_id=ANY($1::uuid[]))",[ids]);
  await client.query('DELETE FROM export_job WHERE owner_user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM saved_layout WHERE owner_user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM watchlist WHERE owner_user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM quota_bucket WHERE user_id=ANY($1::uuid[])',[ids]);
  const billingCustomers=(await client.query('SELECT customer_id FROM fake_billing_customer WHERE user_id=ANY($1::uuid[])',[ids])).rows.map(row=>row.customer_id);
  const billingSessionRows=(await client.query('SELECT session_id,url,idempotency_key FROM fake_billing_checkout WHERE user_id=ANY($1::uuid[])',[ids])).rows;
  const billingSessions=billingSessionRows.map(row=>row.session_id);
  const billingPayments=(await client.query('SELECT payment_id FROM fake_billing_invoice WHERE customer_id=ANY($1::text[]) AND payment_id IS NOT NULL',[billingCustomers])).rows.map(row=>row.payment_id);
  const billingKeys=(await client.query('SELECT idempotency_key FROM billing_operation WHERE user_id=ANY($1::uuid[])',[ids])).rows.map(row=>row.idempotency_key);
  const billingRefunds=(await client.query('SELECT refund_id,idempotency_key FROM fake_billing_refund WHERE payment_id=ANY($1::text[])',[billingPayments])).rows;
  await client.query(`DELETE FROM fake_billing_operation WHERE result->>'customerId'=ANY($1::text[]) OR result->>'sessionId'=ANY($2::text[])
    OR result->>'refundId'=ANY($3::text[]) OR idempotency_key=ANY($4::text[]) OR result->>'url'=ANY($6::text[])
    OR EXISTS(SELECT 1 FROM unnest($5::text[]) key WHERE idempotency_key LIKE key||':%')`,[billingCustomers,billingSessions,billingRefunds.map(row=>row.refund_id),[...billingRefunds.map(row=>row.idempotency_key),...billingSessionRows.map(row=>row.idempotency_key)],billingKeys,billingSessionRows.map(row=>row.url)]);
  await client.query('DELETE FROM fake_billing_event WHERE customer_id=ANY($1::text[])',[billingCustomers]);
  await client.query('DELETE FROM fake_billing_dispute WHERE payment_id=ANY($1::text[])',[billingPayments]);
  await client.query('DELETE FROM fake_billing_refund WHERE payment_id=ANY($1::text[])',[billingPayments]);
  await client.query('DELETE FROM fake_billing_invoice WHERE customer_id=ANY($1::text[])',[billingCustomers]);
  await client.query('DELETE FROM fake_billing_checkout WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM fake_billing_subscription WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM fake_billing_customer WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM billing_event WHERE provider_customer_id IN (SELECT provider_customer_id FROM billing_customer WHERE user_id=ANY($1::uuid[]))',[ids]);
  await client.query('DELETE FROM billing_dispute WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM billing_refund WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM billing_invoice WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM billing_operation WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM subscription WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM billing_customer WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM subscription_entitlement WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('UPDATE journal_entry SET position_id=NULL WHERE owner_user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM outcome_snapshot WHERE position_id IN (SELECT id FROM position WHERE owner_user_id=ANY($1::uuid[]))',[ids]);
  await client.query('DELETE FROM position_event WHERE position_id IN (SELECT id FROM position WHERE owner_user_id=ANY($1::uuid[]))',[ids]);
  await client.query('DELETE FROM position_leg WHERE position_id IN (SELECT id FROM position WHERE owner_user_id=ANY($1::uuid[]))',[ids]);
  await client.query('DELETE FROM position WHERE owner_user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM journal_entry WHERE owner_user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM correction_request WHERE publication_id=ANY($1::uuid[])',[publications]);
  await client.query("DELETE FROM outbox_event WHERE (aggregate_type='publication_job' AND aggregate_id=ANY($1::uuid[])) OR (aggregate_type='media' AND aggregate_id IN (SELECT id FROM media WHERE owner_user_id=ANY($2::uuid[])))",[jobs,ids]);
  await client.query('DELETE FROM publication_job WHERE owner_user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM chart_state WHERE publication_version_id IN (SELECT id FROM publication_version WHERE publication_id=ANY($1::uuid[])) OR draft_id IN (SELECT id FROM draft WHERE owner_user_id=ANY($2::uuid[]))',[publications,ids]);
  await client.query('UPDATE profile SET avatar_media_id=NULL WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM media WHERE owner_user_id=ANY($1::uuid[])',[ids]);
  await client.query('UPDATE publication SET original_version_id=NULL,current_version_id=NULL WHERE id=ANY($1::uuid[])',[publications]);
  await client.query('DELETE FROM publication_version WHERE publication_id=ANY($1::uuid[])',[publications]);
  await client.query('DELETE FROM publication WHERE id=ANY($1::uuid[])',[publications]);
  await client.query('DELETE FROM draft WHERE owner_user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM idempotency_record WHERE user_id=ANY($1::uuid[]) OR actor_key=ANY($1::text[])',[ids]);
  await client.query('DELETE FROM app_session WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM preference WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM policy_acceptance WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM handle_history WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM role_grant WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM profile WHERE user_id=ANY($1::uuid[])',[ids]);
  await client.query('DELETE FROM user_account WHERE id=ANY($1::uuid[])',[ids]);
  if(instrumentIds.length){await client.query('DELETE FROM instrument_metadata_version WHERE instrument_id=ANY($1::uuid[])',[instrumentIds]);await client.query('DELETE FROM instrument WHERE id=ANY($1::uuid[])',[instrumentIds]);}
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await client.query('ALTER TABLE publication_version ENABLE TRIGGER publication_version_immutable');
  await client.query('ALTER TABLE position_event ENABLE TRIGGER position_event_immutable');
  await client.query('ALTER TABLE audit_event ENABLE TRIGGER audit_event_immutable');
  await client.query('ALTER TABLE chart_state ENABLE TRIGGER published_chart_immutable');
  await client.query('ALTER TABLE instrument_metadata_version ENABLE TRIGGER instrument_metadata_append_only');
  const triggers=await client.query("SELECT count(*)::int AS enabled FROM pg_trigger WHERE tgname=ANY($1::text[]) AND tgenabled='O'",[['publication_version_immutable','position_event_immutable','audit_event_immutable','published_chart_immutable','instrument_metadata_append_only']]);
  assert.equal(triggers.rows[0].enabled,5);
  assert.equal((await client.query('SELECT 1 FROM user_account WHERE id=ANY($1::uuid[])',[ids])).rowCount,0);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
}
