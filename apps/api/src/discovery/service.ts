import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { components } from '@trading/contracts';
import { PublicationService } from '../publications/service.js';
import { InstrumentService } from '../instruments/service.js';
import { CommandError } from '../http/problem.js';
import { withTransaction } from '../persistence/transactions.js';

/** Public discovery has no persistent content cache: source rights are checked on every page. */
export class DiscoveryService {
  constructor(private readonly pool:Pool,private readonly publications:PublicationService,private readonly instruments:InstrumentService){}
  async list(input:Record<string,unknown>):Promise<components['schemas']['DiscoveryPage']>{
    const shard=Number(input.shard??0),limit=Number(input.limit??200);
    if(!Number.isInteger(shard)||shard<0||shard>15||!Number.isInteger(limit)||limit<1||limit>200)throw new CommandError(400,'INVALID_DISCOVERY_QUERY');
    const binding=createHash('sha256').update(`discovery-v1:${shard}`).digest('hex').slice(0,16);
    let after='';
    if(input.cursor){try{const value=JSON.parse(Buffer.from(String(input.cursor),'base64url').toString());if(value.binding!==binding||!/^\d:[0-9a-f-]{36}$/.test(value.after))throw new Error();after=value.after;}catch{throw new CommandError(400,'INVALID_CURSOR');}}
    return withTransaction(this.pool,async tx=>{
      const items:components['schemas']['DiscoveryEntry'][]=[];let nextCursor:string|null=null;let exhausted=false;
      // Bounded scanning can yield an empty continuation when many source records lose visibility.
      for(let scan=0;scan<4&&!exhausted&&items.length<limit;scan++){
        const batchLimit=limit-items.length+1;
        const rows=await tx.query(`SELECT * FROM (
          SELECT '0:'||p.id::text AS key,p.id,'publication' AS kind,pv.terms->>'slug' AS label,COALESCE(pv.created_at,p.published_at) AS modified,pv.id AS version_id
          FROM publication p JOIN publication_version pv ON pv.id=p.current_version_id JOIN user_account u ON u.id=p.author_user_id
          WHERE p.visibility='public' AND p.published_at IS NOT NULL AND u.status='active' AND (SELECT moderation_hidden_at FROM profile WHERE user_id=p.author_user_id) IS NULL AND substring(p.id::text,1,1)=$1
          UNION ALL SELECT '1:'||pr.user_id::text,pr.user_id,'profile',pr.handle,pr.updated_at,NULL::uuid FROM profile pr JOIN user_account u ON u.id=pr.user_id
          WHERE u.status='active' AND pr.moderation_hidden_at IS NULL AND u.onboarding_version IS NOT NULL AND substring(pr.user_id::text,1,1)=$1
          UNION ALL SELECT '2:'||i.id::text,i.id,'instrument',i.vendor_id,COALESCE((SELECT max(m.created_at) FROM instrument_metadata_version m WHERE m.instrument_id=i.id),i.created_at),NULL::uuid FROM instrument i
          WHERE i.enabled=true AND i.asset IN ('stock','future') AND substring(i.id::text,1,1)=$1
        ) candidates WHERE key>$2 ORDER BY key LIMIT $3`,[shard.toString(16),after,batchLimit]);
        if(!rows.rowCount){exhausted=true;break;}
        for(let index=0;index<rows.rows.length;index++){
          const row=rows.rows[index]!;if(items.length===limit){nextCursor=Buffer.from(JSON.stringify({binding,after})).toString('base64url');return {items,nextCursor};}
          after=String(row.key);
          try{
            let path:string;
            if(row.kind==='publication'){
              const source=await this.publications.assertPublicInteractionSource(String(row.id),tx);
              if(source.currentVersionId!==row.version_id)continue;
              // Slugs are generated at publication and never trusted from a caller's URL.
              if(typeof row.label!=='string'||!/^[a-z0-9-]{1,150}$/.test(row.label))continue;
              path=`/ideas/${row.id}/${row.label}`;
            }else if(row.kind==='profile'){path=`/u/${encodeURIComponent(String(row.label))}`;}
            else{const reference=await this.instruments.get(String(row.id),undefined,'public',tx);if(!reference.meta.capabilities.displayPublic)continue;path=`/instruments/${row.id}`;}
            items.push({path,lastModified:new Date(row.modified as Date).toISOString()});
          }catch(error){if(error instanceof CommandError&&[403,404].includes(error.status))continue;throw error;}
        }
        exhausted=rows.rows.length<batchLimit;
      }
      if(!exhausted)nextCursor=Buffer.from(JSON.stringify({binding,after})).toString('base64url');
      return {items,nextCursor};
    });
  }
}
