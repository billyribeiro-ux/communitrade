import {notFound} from 'next/navigation';
import {isLocalPreview} from '@/lib/preview';
import {Controls} from './Controls';
export const metadata={title:'Local component review',robots:{index:false,follow:false}};
export default function DesignPreview(){if(!isLocalPreview())notFound();return <Controls/>;}
