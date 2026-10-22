import type {Pool} from 'pg';
import {withActorTransaction,requireUuid} from '../persistence/transactions.js';
import {recordProductEvent,productProperties} from './events.js';
import {CommandError} from '../http/problem.js';
export class MeasurementService{
 constructor(private readonly pool:Pool){}
 async recordReturn(owner:string,input:{name:string;sourceKey:string;properties?:unknown}){
  if(input.name!=='return')throw new CommandError(422,'CLIENT_EVENT_NOT_ALLOWED');requireUuid(input.sourceKey);
  const properties=productProperties(input.properties??{});
  if(Object.keys(properties).some(key=>key!=='surface'))throw new CommandError(422,'CLIENT_EVENT_NOT_ALLOWED');
  return withActorTransaction(this.pool,owner,async tx=>{
   // Serialize against consent changes; revoking consent cannot race a stale write.
   await recordProductEvent(tx,owner,'return',input.sourceKey,properties);
  });
 }
}
