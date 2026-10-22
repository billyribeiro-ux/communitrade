type SnapshotHost={dataset:DOMStringMap};
type SnapshotWindow={__capturePublicationSnapshot?:()=>string};
const owners=new WeakMap<SnapshotHost,symbol>();
/** A readiness marker and its callback share one lifecycle; stale cleanup cannot remove a newer capture. */
export function beginSnapshotReadiness(host:SnapshotHost,target:SnapshotWindow,capture:()=>string){
 const owner=Symbol('snapshot-capture');owners.set(host,owner);let disposed=false;
 delete host.dataset.publicationSnapshotReady;delete host.dataset.publicationSnapshotError;
 delete target.__capturePublicationSnapshot;
 const current=()=>!disposed&&owners.get(host)===owner;
 return{
  publish(){if(!current())return false;target.__capturePublicationSnapshot=capture;host.dataset.publicationSnapshotReady='true';return true;},
  fail(stage:string){if(!current())return;delete host.dataset.publicationSnapshotReady;if(target.__capturePublicationSnapshot===capture)delete target.__capturePublicationSnapshot;host.dataset.publicationSnapshotError=stage;},
  dispose(){if(owners.get(host)===owner){delete host.dataset.publicationSnapshotReady;delete host.dataset.publicationSnapshotError;owners.delete(host);}if(target.__capturePublicationSnapshot===capture)delete target.__capturePublicationSnapshot;disposed=true;},
 };
}
