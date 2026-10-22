import {notFound} from "next/navigation";
import {apiFetch} from "@/lib/server-api";
import {uuid,type Position,type Publication} from "@/lib/publications";
import type {Instrument} from "@/lib/instruments";
import {PositionReporter} from "@/components/publications/PositionReporter";
export default async function PositionPage({params}:{params:Promise<{id:string}>}){
 const {id}=await params;if(!uuid.test(id))notFound();const [position,me]=await Promise.all([apiFetch<Position>(`/positions/${id}`),apiFetch<{csrfToken:string;user:{id:string}}>("/me")]);if(!position.ok&&position.response?.status===404)notFound();if(!position.ok||!me.ok)return <section><h1>Position unavailable</h1><p role="alert">The reported position service could not return this record. Retry later.</p></section>;
 let references:Instrument[]=[];
 if(position.data.publicationId){const publication=await apiFetch<Publication>(`/publications/${position.data.publicationId}${position.data.riskSourceVersionId?`/versions/${position.data.riskSourceVersionId}`:""}`);if(!publication.ok||publication.data.author.id!==me.data.user.id)notFound();const resolved=await Promise.all((publication.data.referenceVersions??[]).map(reference=>apiFetch<Instrument>(`/instruments/${reference.instrumentId}?metadataVersion=${reference.metadataVersion}`)));references=resolved.flatMap(reference=>reference.ok?[reference.data]:[]);}
 // The event endpoint authorizes ownership on every write. Public visibility grants no write permission.
 return <PositionReporter initialPosition={position.data} initialEtag={position.response.headers.get("ETag")??`"${position.data.revision??1}"`} csrfToken={me.data.csrfToken} references={references}/>;
}
