import test from 'node:test';
import assert from 'node:assert/strict';
import {productProperties,PRODUCT_EVENT_NAMES} from '../dist/measurement/events.js';
test('P11 first-party measurement vocabulary rejects private text, URLs, credentials and unapproved properties',()=>{
 assert.deepEqual(PRODUCT_EVENT_NAMES,['activation','return','publication','review','report','conversion','churn']);
 assert.deepEqual(productProperties({asset:'option',strategy:'long_call',plan:'free',surface:'journal'}),{asset:'option',strategy:'long_call',plan:'free',surface:'journal'});
 for(const input of [{notes:'secret'},{thesis:'secret'},{url:'/app/journal/private'},{email:'private@example.invalid'},{token:'secret'},{asset:'crypto'},{surface:'https://tracking.invalid'},{plan:1},[]])assert.throws(()=>productProperties(input),{code:'INVALID_PRODUCT_PROPERTIES'});
});
