import test from 'node:test';import assert from 'node:assert/strict';import {beginSnapshotReadiness} from '../src/lib/snapshot-readiness.ts';
test('snapshot readiness and capture callback remain paired through StrictMode cleanup and remount',()=>{
 const host={dataset:{}},target={},captureFirst=()=> 'first',captureNext=()=> 'next';
 const first=beginSnapshotReadiness(host,target,captureFirst);assert.equal(target.__capturePublicationSnapshot,undefined);assert.equal(host.dataset.publicationSnapshotReady,undefined);
 first.publish();assert.equal(target.__capturePublicationSnapshot(),'first');assert.equal(host.dataset.publicationSnapshotReady,'true');first.dispose();assert.equal(target.__capturePublicationSnapshot,undefined);assert.equal(host.dataset.publicationSnapshotReady,undefined);
 const next=beginSnapshotReadiness(host,target,captureNext);assert.equal(first.publish(),false,'Disposed asynchronous initialization cannot resurrect readiness');next.publish();first.dispose();first.fail('old-error');assert.equal(target.__capturePublicationSnapshot(),'next');assert.equal(host.dataset.publicationSnapshotReady,'true');assert.equal(host.dataset.publicationSnapshotError,undefined);
 next.fail('viewport');assert.equal(host.dataset.publicationSnapshotReady,undefined);assert.equal(target.__capturePublicationSnapshot,undefined);assert.equal(host.dataset.publicationSnapshotError,'viewport');next.dispose();assert.deepEqual(host.dataset,{});
});
