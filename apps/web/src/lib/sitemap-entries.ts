export type DiscoveryPage={items:Array<{path:string;lastModified:string}>;nextCursor:string|null};
/** Stop rather than publish a partial or stale discovery file when authorization cannot be checked. */
export async function collectDiscoveryEntries(load:(cursor?:string)=>Promise<DiscoveryPage>){
  const items:DiscoveryPage['items']=[],seen=new Set<string>();let cursor:string|undefined;
  for(let page=0;page<250;page++){
    const result=await load(cursor);
    for(const item of result.items){
      if(!/^\/(?:ideas\/[0-9a-f-]{36}\/[a-z0-9-]+|u\/[a-z0-9_]{3,30}|instruments\/[0-9a-f-]{36})$/i.test(item.path)||!Number.isFinite(Date.parse(item.lastModified)))throw new Error('Invalid public discovery entry.');
      items.push(item);
    }
    if(items.length>49_980)throw new Error('Discovery shard requires further partitioning.');
    if(!result.nextCursor)return items;
    if(seen.has(result.nextCursor))throw new Error('Discovery cursor failed to advance.');
    seen.add(result.nextCursor);cursor=result.nextCursor;
  }
  throw new Error('Discovery shard exceeds the bounded traversal.');
}
