import test from 'node:test';
import assert from 'node:assert/strict';
import {createSmtpEmailPort} from '../dist/email.js';
test('address suppression blocks anonymous as well as account mail before SMTP',async()=>{
  let checked=0;const port=createSmtpEmailPort({RELEASE_MODE:'local',SMTP_HOST:'mailpit',SMTP_PORT:'1025',EMAIL_FROM:'sender@example.invalid'},async email=>{checked++;assert.equal(email,'recipient@example.invalid');return true;});
  try{await assert.rejects(port.send({to:'recipient@example.invalid',subject:'generic receipt',text:'no private content',html:'no private content',messageId:'<p14@example.invalid>',from:'sender@example.invalid'}),error=>error.code==='SMTP_RECIPIENT_REJECTED');assert.equal(checked,1);}finally{port.close();}
});
