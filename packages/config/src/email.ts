import {createHmac} from 'node:crypto';

/** Purpose-separated, stable suppression key; never stores a recipient address. */
export function emailSuppressionDigest(email:string,key:string):string {
  if(key.length<32)throw new Error('Email suppression requires a stable key.');
  return createHmac('sha256',key).update(`email-suppression:v1\0${email.trim().toLowerCase()}`).digest('hex');
}
