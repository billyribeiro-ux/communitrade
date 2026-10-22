import {notFound,redirect} from 'next/navigation';
import {apiFetch} from '@/lib/server-api';
import {SupportRequest} from '../../../SupportRequest';
export const metadata={title:'Claim private support request',robots:{index:false,follow:false}};
export default async function Claim({params}:{params:Promise<{id:string}>}){const{id}=await params;if(!/^[0-9a-f-]{36}$/i.test(id))notFound();const me=await apiFetch<{csrfToken:string}>('/me');if(!me.ok)redirect(`/login?returnTo=${encodeURIComponent(`/support/requests/${id}/claim`)}`);return <SupportRequest claimId={id} claimRequired csrfToken={me.data.csrfToken} ticket={null}/>;}
