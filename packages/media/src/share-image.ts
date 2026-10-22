import sharp from 'sharp';

export interface ShareImageAttribution {
  authorHandle: string;
  publishedAt: string;
  strategy: string;
  instrument: string;
}
function xml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[character]!));
}
/** Append attribution to authorized frozen bytes; never replace the immutable original. */
export async function createAttributedShareImage(snapshot: Buffer, attribution: ShareImageAttribution): Promise<Buffer> {
  if(snapshot.length<1||snapshot.length>8*1024*1024)throw new Error('INVALID_SHARE_IMAGE');
  if(!/^[a-z0-9_]{3,30}$/.test(attribution.authorHandle)||!Number.isFinite(Date.parse(attribution.publishedAt))
      ||[attribution.strategy,attribution.instrument].some(label=>!label||label.length>200||/[\r\n<>]/.test(label)))throw new Error('INVALID_SHARE_ATTRIBUTION');
  const image=sharp(snapshot,{failOn:'error',limitInputPixels:1200*760,animated:false});
  const metadata=await image.metadata();
  if(metadata.format!=='webp'||metadata.width!==1200||metadata.height!==760||(metadata.pages??1)>1)throw new Error('INVALID_SHARE_IMAGE');
  const first=`Original by @${attribution.authorHandle} · Published ${new Date(attribution.publishedAt).toISOString()}`;
  const second=`${attribution.instrument} · ${attribution.strategy.replaceAll('_',' ')} · Member reported, not broker verified`;
  const footer=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="112"><rect width="1200" height="112" fill="#17212b"/><text x="28" y="34" fill="#e6edf3" font-size="18" font-family="sans-serif">${xml(first)}</text><text x="28" y="66" fill="#e6edf3" font-size="16" font-family="sans-serif">${xml(second)}</text><text x="28" y="94" fill="#a7b5c3" font-size="13" font-family="sans-serif">Original source, delay and TradingView attribution remain on the frozen chart above.</text></svg>`);
  return image.extend({bottom:112,top:0,left:0,right:0,background:'#17212b'}).composite([{input:footer,top:760,left:0}]).webp({quality:88,effort:4}).toBuffer();
}
